"""WebSocket transport + inference glue for native MediaPipe Tasks."""

from __future__ import annotations

import base64
import hashlib
import itertools
import json
import os
import struct
import threading
import time
from typing import Optional

from . import capture, downloader, engine, registry

_WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_CONNECTION_IDS = itertools.count(1)


def is_websocket_request(headers) -> bool:
    upgrade = (headers.get("Upgrade") or "").lower()
    connection = (headers.get("Connection") or "").lower()
    return upgrade == "websocket" and "upgrade" in connection


def accept_key(client_key: str) -> str:
    digest = hashlib.sha1((client_key + _WS_MAGIC).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


class WSConnection:
    def __init__(self, rfile, wfile, sock=None, timeout: float = 60.0):
        self.rfile = rfile
        self.wfile = wfile
        self.timeout = timeout
        self._send_lock = threading.Lock()
        self.closed = False
        self.idle_limit = max(timeout * 10, 600.0)
        self.read_timed_out = False
        self.max_message_bytes = 32 * 1024 * 1024
        self._sock = sock or getattr(rfile, "raw", None) or getattr(rfile, "_sock", None)
        try:
            if self._sock is not None and hasattr(self._sock, "settimeout"):
                self._sock.settimeout(timeout)
        except Exception:
            pass
        if sock is not None and hasattr(sock, "settimeout"):
            try:
                sock.settimeout(timeout)
            except Exception:
                pass

    def restore_blocking(self) -> None:
        try:
            if self._sock is not None and hasattr(self._sock, "settimeout"):
                self._sock.settimeout(None)
        except Exception:
            pass

    def _read_exact(self, n: int) -> Optional[bytes]:
        data = b""
        try:
            while len(data) < n:
                chunk = self.rfile.read(n - len(data))
                if not chunk:
                    return None
                data += chunk
        except OSError as exc:
            if isinstance(exc, TimeoutError) or "timed out" in str(exc).lower():
                self.read_timed_out = True
            else:
                self.closed = True
            return None
        except Exception:
            self.closed = True
            return None
        return data

    def _read_frame(self) -> Optional[tuple[int, bool, bytes]]:
        header = self._read_exact(2)
        if header is None:
            return None
        b1, b2 = header[0], header[1]
        fin = bool(b1 & 0x80)
        opcode = b1 & 0x0F
        masked = b2 & 0x80
        length = b2 & 0x7F
        if length == 126:
            ext = self._read_exact(2)
            if ext is None:
                return None
            length = struct.unpack("!H", ext)[0]
        elif length == 127:
            ext = self._read_exact(8)
            if ext is None:
                return None
            length = struct.unpack("!Q", ext)[0]

        mask = self._read_exact(4) if masked else b"\x00\x00\x00\x00"
        if mask is None:
            return None
        payload = self._read_exact(length) if length else b""
        if payload is None:
            return None
        if masked:
            mask_bytes = mask
            payload = bytes(b ^ mask_bytes[i % 4] for i, b in enumerate(payload))
        return opcode, fin, payload

    def read_message(self) -> Optional[tuple[int, bytes]]:
        if self.closed:
            return None

        message_opcode: Optional[int] = None
        buffer = bytearray()

        while True:
            frame = self._read_frame()
            if frame is None:
                return None
            opcode, fin, payload = frame

            if opcode >= 0x8:
                return opcode, payload

            if opcode == 0x0:
                if message_opcode is None:
                    self.closed = True
                    return None
                buffer += payload
            else:
                message_opcode = opcode
                buffer = bytearray(payload)

            if fin:
                return message_opcode, bytes(buffer)

            if len(buffer) > self.max_message_bytes:
                self.closed = True
                return None

    def _send_frame(self, opcode: int, payload: bytes) -> bool:
        with self._send_lock:
            if self.closed:
                return False
            header = bytearray()
            header.append(0x80 | opcode)
            length = len(payload)
            if length < 126:
                header.append(length)
            elif length < 65536:
                header.append(126)
                header += struct.pack("!H", length)
            else:
                header.append(127)
                header += struct.pack("!Q", length)
            try:
                self.wfile.write(bytes(header) + payload)
                self.wfile.flush()
                return True
            except Exception:
                self.closed = True
                return False

    def send_text(self, text: str) -> bool:
        return self._send_frame(0x1, text.encode("utf-8"))

    def send_json(self, obj) -> bool:
        return self.send_text(json.dumps(obj, ensure_ascii=False, separators=(',', ':')))

    def send_ping(self) -> bool:
        return self._send_frame(0x9, b"")

    def close(self) -> None:
        if not self.closed:
            try:
                self._send_frame(0x8, b"")
            except Exception:
                pass
        self.closed = True


# One browser frame -> one terminal JSON reply.
class InferenceWorker:
    """One WebSocket peer with an explicit control or pose role."""

    def __init__(self, conn: WSConnection, on_status=None):
        self.conn = conn
        self.connection_id = f"ws-{next(_CONNECTION_IDS)}"
        self.created_at = time.time()
        self.on_status = on_status
        self.loop_count = 0
        self.errors = 0
        self._last_ok = time.time()
        self._subscribed = False
        self._role = "legacy"
        self._tx_json_cnt = 0
        self._rx_bin_cnt = 0
        self._rx_drop_cnt = 0
        self._pose_cond = threading.Condition()
        self._latest_pose = None
        self._pose_sender = None
        self._pose_sent = 0
        self._pose_dropped = 0
        self._last_pose_send_ms = 0.0
        self._max_infer_fps = max(1.0, min(60.0, float(os.environ.get("XRA_BACKEND_MAX_FPS", "30"))))
        self._min_idle_s = max(0.0, float(os.environ.get("XRA_BACKEND_MIN_IDLE_MS", "2"))) / 1000.0
        self._next_infer_at = 0.0
        self._last_infer_finished_at = 0.0
        self._last_ping_at = 0.0

    def run(self) -> None:
        idle_since = None
        try:
            while not self.conn.closed:
                self.conn.read_timed_out = False
                msg = self.conn.read_message()
                if msg is None:
                    if self.conn.read_timed_out and not self.conn.closed:
                        idle_since = idle_since or time.time()
                        now = time.time()
                        if now - self._last_ping_at > 15.0:
                            self.conn.send_ping()
                            self._last_ping_at = now
                        time.sleep(0.05)
                        if time.time() - idle_since > self.conn.idle_limit:
                            break
                        continue
                    break
                idle_since = None
                opcode, payload = msg
                if opcode == 0x8:
                    break
                if opcode == 0x9:
                    self.conn._send_frame(0xA, payload)
                    continue
                if opcode == 0xA:
                    continue
                if opcode == 0x1:
                    self._handle_text(payload)
                    continue
                if opcode == 0x2:
                    self._handle_binary_frame(payload)
                    continue
        except Exception as exc:
            self.errors += 1
            try:
                self.conn.send_json({"type": "error", "error": str(exc), "role": self._role})
            except Exception:
                pass
        finally:
            self._set_pose_subscription(False)
            self.conn.close()

    def _set_pose_subscription(self, enabled: bool) -> None:
        enabled = bool(enabled)
        if enabled == self._subscribed:
            return
        if enabled:
            if self._pose_sender is None or not self._pose_sender.is_alive():
                self._pose_sender = threading.Thread(
                    target=self._pose_sender_loop,
                    name="xra-ws-pose-tx",
                    daemon=True,
                )
                self._pose_sender.start()
            capture.CAPTURE.subscribe(self._on_pose)
        else:
            capture.CAPTURE.unsubscribe(self._on_pose)
            with self._pose_cond:
                self._latest_pose = None
        self._subscribed = enabled
        if os.environ.get("XRA_VERBOSE", "0") in {"1", "true", "yes", "on"}:
            print(
                "[XRA_WS_SUB] " + json.dumps({
                    "connection_id": self.connection_id,
                    "role": self._role,
                    "enabled": enabled,
                    "subscribers": capture.CAPTURE.subscriber_count,
                }),
                flush=True,
            )

    def _queue_pose(self, wire: dict) -> None:
        if not isinstance(wire, dict) or self.conn.closed:
            return
        with self._pose_cond:
            if self._latest_pose is not None:
                self._pose_dropped += 1
            self._latest_pose = wire
            self._pose_cond.notify()

    def _pose_sender_loop(self) -> None:
        while not self.conn.closed:
            with self._pose_cond:
                while self._latest_pose is None and not self.conn.closed:
                    self._pose_cond.wait(timeout=0.5)
                if self.conn.closed:
                    return
                wire = self._latest_pose
                self._latest_pose = None

            started = time.perf_counter()
            if not self.conn.send_json(wire):
                return
            self._last_pose_send_ms = (time.perf_counter() - started) * 1000.0
            self._pose_sent += 1
            self._tx_json_cnt += 1

    def _on_pose(self, wire: dict) -> None:
        if self.conn.closed:
            return
        self.loop_count += 1
        self._last_ok = time.time()
        self._queue_pose(wire)

    def _handle_binary_frame(self, payload: bytes) -> None:
        if not engine.ENGINE.ready or len(payload) < 8:
            return

        self._rx_bin_cnt += 1
        now = time.monotonic()
        earliest = max(self._next_infer_at, self._last_infer_finished_at + self._min_idle_s)
        if now < earliest:
            self._rx_drop_cnt += 1
            return
        self._next_infer_at = now + (1.0 / self._max_infer_fps)

        try:
            if os.environ.get("XRA_VERBOSE", "0") in {"1", "true", "yes", "on"} and self._rx_bin_cnt % 30 == 1:
                print(f"[XRA PYTHON] Ricevuto frame binario #{self._rx_bin_cnt} ({len(payload)} bytes)")

            w, h = struct.unpack("!HH", payload[:4])
            raw_bytes = payload[4:]
            expected = w * h * 4
            if w <= 0 or h <= 0 or len(raw_bytes) < expected:
                return

            import numpy as np

            rgba = np.frombuffer(raw_bytes[:expected], dtype=np.uint8).reshape((h, w, 4))
            bgr = rgba[..., :3][..., ::-1].copy()

            t0 = time.perf_counter()
            try:
                res = engine.ENGINE.infer(bgr)
            finally:
                self._last_infer_finished_at = time.monotonic()
            infer_ms = (time.perf_counter() - t0) * 1000.0

            if res is not None:
                wire = engine.to_wire(res, capture_hint=(w, h))
                wire["type"] = "pose"
                wire["ms"] = infer_ms
                wire["provider"] = engine.ENGINE.provider
                self.loop_count += 1
                self._last_ok = time.time()
                self._queue_pose(wire)
        except Exception:
            self.errors += 1

    @staticmethod
    def _request_id(obj: dict):
        return obj.get("request_id")

    def _send(self, payload: dict, obj: Optional[dict] = None) -> None:
        if obj is not None and obj.get("request_id") is not None:
            payload = {**payload, "request_id": obj.get("request_id")}
        self.conn.send_json(payload)

    def _control_allowed(self) -> bool:
        return self._role not in {"pose", "viewer"}

    def _handle_text(self, payload: bytes) -> None:
        try:
            obj = json.loads(payload.decode("utf-8"))
        except Exception as exc:
            self.conn.send_json({"type": "error", "error": f"invalid_json: {exc}"})
            return

        mtype = obj.get("type")
        if mtype == "hello":
            role = str(obj.get("role") or "legacy").strip().lower()
            self._role = role if role in {"control", "pose", "viewer", "legacy"} else "legacy"
            if obj.get("subscribe") is not None:
                self._set_pose_subscription(bool(obj.get("subscribe")))
            self._send({
                "type": "hello",
                "ok": True,
                "connection_id": self.connection_id,
                "role": self._role,
                "subscribed": self._subscribed,
            }, obj)
            return

        if mtype == "subscribe":
            enabled = bool(obj.get("poses", obj.get("enabled", True)))
            self._set_pose_subscription(enabled)
            self._send({
                "type": "subscription",
                "ok": True,
                "role": self._role,
                "poses": self._subscribed,
            }, obj)
            return

        if mtype == "status":
            self._send({"type": "status", **self._status()}, obj)
            return

        if not self._control_allowed():
            self._send({
                "type": "error",
                "error": f"read_only_websocket_role: {self._role}",
                "command": mtype,
            }, obj)
            return

        if mtype == "load":
            model = obj.get("model")
            complexity = obj.get("model_complexity")
            mode = obj.get("mode") or obj.get("mocap_mode")
            if mode:
                engine.ENGINE.configure_mode(mode)
                try:
                    capture.CAPTURE.configure(mocap_mode=mode)
                except Exception:
                    pass
            self._send({
                "type": "status",
                **self._status(),
                "loading": True,
                "requested_model": model,
            }, obj)
            result = self._load(model, complexity)
            self._send({"type": "status", **result}, obj)
        elif mtype in {"mode", "configure_mode"}:
            mode = obj.get("mode") or obj.get("mocap_mode")
            res_engine = engine.ENGINE.configure_mode(mode)
            try:
                capture.CAPTURE.configure(mocap_mode=mode)
            except Exception:
                pass
            self._send({"type": "status", **res_engine, **self._status()}, obj)
        elif mtype == "unload":
            capture.CAPTURE.stop()
            engine.ENGINE.unload()
            self._send({"type": "status", "ok": True, **self._status()}, obj)
        elif mtype == "rates":
            try:
                rates = engine.ENGINE.configure_rates(
                    body_fps=obj.get("body_fps", obj.get("pose_fps")),
                    head_fps=obj.get("head_fps"),
                    roi_fps=obj.get("roi_fps"),
                )
                self._send({"type": "rates_status", **rates, **self._status()}, obj)
            except Exception as exc:
                self.errors += 1
                self._send({"type": "rates_status", "ok": False, "error": str(exc), **self._status()}, obj)
        elif mtype in {"confidence", "thresholds"}:
            try:
                res = engine.ENGINE.configure_confidence(
                    min_tracking=obj.get("min_tracking_confidence", obj.get("min_tracking")),
                    min_pose=obj.get("min_pose_confidence", obj.get("min_pose")),
                    min_face=obj.get("min_face_confidence", obj.get("min_face")),
                    min_joint=obj.get("min_joint_confidence", obj.get("min_joint")),
                    desk_wrist_guard=obj.get("desk_wrist_guard"),
                    desk_wrist_thresh=obj.get("desk_wrist_thresh"),
                )
                if "arm_steady_hold" in obj:
                    capture.CAPTURE.configure(arm_steady_hold=obj.get("arm_steady_hold"))
                if "smart_arm_sync" in obj:
                    capture.CAPTURE.configure(smart_arm_sync=obj.get("smart_arm_sync"))
                if "desk_wrist_guard" in obj:
                    capture.CAPTURE.configure(desk_wrist_guard=obj.get("desk_wrist_guard"))
                self._send({"type": "confidence_status", **res, **self._status()}, obj)
            except Exception as exc:
                self.errors += 1
                self._send({"type": "confidence_status", "ok": False, "error": str(exc), **self._status()}, obj)
        elif mtype in {"hardware", "configure_hardware"}:
            try:
                hardware_mode = obj.get("mode", "Auto")
                res = engine.ENGINE.configure_hardware(hardware_mode)
                self._send({"type": "hardware_status", **res, **self._status()}, obj)
            except Exception as exc:
                self.errors += 1
                self._send({"type": "hardware_status", "ok": False, "error": str(exc), **self._status()}, obj)
        elif mtype in {"capture", "camera"}:
            self._handle_capture(obj)
        else:
            self._send({"type": "error", "error": f"unknown_message_type: {mtype}"}, obj)

    def _handle_capture(self, obj: dict) -> None:
        action = str(obj.get("action") or "status").lower()
        try:
            if action in {"configure", "config", "select"}:
                mocap_mode = obj.get("mocap_mode") or obj.get("mode")
                if mocap_mode:
                    engine.ENGINE.configure_mode(mocap_mode)
                capture.CAPTURE.configure(
                    index=obj.get("index"),
                    device=obj.get("device"),
                    width=obj.get("width"),
                    height=obj.get("height"),
                    fps=obj.get("fps"),
                    selfie_mode=obj.get("selfie_mode"),
                    mocap_mode=mocap_mode,
                    infer_width=obj.get("infer_width"),
                    infer_height=obj.get("infer_height"),
                    infer_mode=obj.get("infer_mode"),
                    arm_steady_hold=obj.get("arm_steady_hold"),
                    smart_arm_sync=obj.get("smart_arm_sync"),
                    adaptive_frame_skip=obj.get("adaptive_frame_skip"),
                    cpu_affinity=obj.get("cpu_affinity"),
                )
            elif action in {"start", "on", "resume"}:
                if not engine.ENGINE.ready:
                    raise RuntimeError("engine_not_ready")
                if action == "resume":
                    capture.CAPTURE.resume()
                else:
                    capture.CAPTURE.start()
            elif action == "pause":
                capture.CAPTURE.pause()
            elif action in {"stop", "off"}:
                capture.CAPTURE.stop()
            elif action != "status":
                raise ValueError(f"unknown capture action: {action}")
            response = {
                "type": "capture_status",
                "ok": True,
                "action": action,
                **self._status(),
            }
            self._send(response, obj)
            if os.environ.get("XRA_VERBOSE", "0") in {"1", "true", "yes", "on"}:
                print("[XRA_CAMERA_CONTROL] " + json.dumps({
                    "action": action,
                    "ok": True,
                    "role": self._role,
                    "capture": response.get("capture"),
                }, ensure_ascii=False), flush=True)
        except Exception as exc:
            self.errors += 1
            response = {
                "type": "capture_status",
                "ok": False,
                "action": action,
                "error": str(exc),
                **self._status(),
            }
            self._send(response, obj)
            if os.environ.get("XRA_VERBOSE", "0") in {"1", "true", "yes", "on"}:
                print("[XRA_CAMERA_CONTROL] " + json.dumps({
                    "action": action,
                    "ok": False,
                    "role": self._role,
                    "error": str(exc),
                    "capture": response.get("capture"),
                }, ensure_ascii=False), flush=True)

    def _load(self, model: str, model_complexity=None) -> dict:
        if not model or model == registry.MEDIAPIPE_ID:
            capture.CAPTURE.stop()
            engine.ENGINE.unload()
            return {"ok": True, **self._status()}
        if not registry.is_installed(model):
            return {
                "ok": False,
                "error": "not-installed",
                "model": model,
                "needs_download": True,
                **self._status(),
            }
        capture_state = capture.CAPTURE.status()
        should_resume = bool(capture_state.get("running") and not capture_state.get("paused"))
        if capture_state.get("running"):
            capture.CAPTURE.pause()
        result = engine.ENGINE.load(model, model_complexity=model_complexity)
        if result.get("ok") and should_resume:
            capture.CAPTURE.resume()
        return {"ok": bool(result.get("ok")), "error": result.get("error"), **self._status()}

    def _transport_status(self) -> dict:
        with self._pose_cond:
            pending = int(self._latest_pose is not None)
        return {
            "connection_id": self.connection_id,
            "role": self._role,
            "subscribed": self._subscribed,
            "age_s": round(max(0.0, time.time() - self.created_at), 1),
            "frames_seen": self.loop_count,
            "errors": self.errors,
            "rx_binary": self._rx_bin_cnt,
            "rx_dropped": self._rx_drop_cnt,
            "tx_pose_sent": self._pose_sent,
            "tx_pose_dropped": self._pose_dropped,
            "tx_pending": pending,
            "last_send_ms": round(self._last_pose_send_ms, 3),
            "max_infer_fps": self._max_infer_fps,
            "min_idle_ms": self._min_idle_s * 1000.0,
        }

    def _status(self) -> dict:
        st = engine.ENGINE.status()
        return {
            **st,
            "frames": self.loop_count,
            "errors": self.errors,
            "capture": capture.CAPTURE.status(),
            "transport": self._transport_status(),
        }
_ACTIVE_WORKERS: set[InferenceWorker] = set()
_ACTIVE_WORKERS_LOCK = threading.Lock()
_LATEST_TRANSPORT_STATUS: dict = {
    "connected": False,
    "rx_binary": 0,
    "rx_dropped": 0,
    "tx_pose_sent": 0,
    "tx_pose_dropped": 0,
    "tx_pending": 0,
    "last_send_ms": 0.0,
    "max_infer_fps": 30,
    "min_idle_ms": 0.0,
}

def get_transport_status() -> dict:
    with _ACTIVE_WORKERS_LOCK:
        workers = []
        for worker in _ACTIVE_WORKERS:
            try:
                workers.append(worker._transport_status())
            except Exception:
                continue
        if not workers:
            fallback = dict(_LATEST_TRANSPORT_STATUS)
            fallback.update({
                "connections": 0,
                "pose_subscribers": 0,
                "roles": {},
                "workers": [],
            })
            return fallback

        roles = {}
        for item in workers:
            role = item.get("role") or "unknown"
            roles[role] = roles.get(role, 0) + 1
        return {
            "connected": True,
            "connections": len(workers),
            "pose_subscribers": sum(bool(item.get("subscribed")) for item in workers),
            "roles": roles,
            "rx_binary": sum(item.get("rx_binary", 0) for item in workers),
            "rx_dropped": sum(item.get("rx_dropped", 0) for item in workers),
            "tx_pose_sent": sum(item.get("tx_pose_sent", 0) for item in workers),
            "tx_pose_dropped": sum(item.get("tx_pose_dropped", 0) for item in workers),
            "tx_pending": sum(item.get("tx_pending", 0) for item in workers),
            "last_send_ms": max((item.get("last_send_ms", 0.0) for item in workers), default=0.0),
            "max_infer_fps": max((item.get("max_infer_fps", 0.0) for item in workers), default=0.0),
            "min_idle_ms": min((item.get("min_idle_ms", 0.0) for item in workers), default=0.0),
            "workers": sorted(workers, key=lambda item: item.get("connection_id", "")),
        }


def maybe_upgrade(handler) -> bool:
    if not is_websocket_request(handler.headers):
        return False
    key = handler.headers.get("Sec-WebSocket-Key")
    if not key:
        return False
    handler.send_response(101, "Switching Protocols")
    handler.send_header("Upgrade", "websocket")
    handler.send_header("Connection", "Upgrade")
    handler.send_header("Sec-WebSocket-Accept", accept_key(key))
    handler.end_headers()
    conn = WSConnection(handler.rfile, handler.wfile, sock=getattr(handler, "connection", None))
    st = engine.ENGINE.status()
    conn.send_json({"type": "status", **st, "source": "backend_camera",
                    "capture": capture.CAPTURE.status()})
    worker = InferenceWorker(conn)
    with _ACTIVE_WORKERS_LOCK:
        _ACTIVE_WORKERS.add(worker)
    try:
        worker.run()
    finally:
        with _ACTIVE_WORKERS_LOCK:
            _ACTIVE_WORKERS.discard(worker)
            try:
                latest = worker._transport_status()
                latest["connected"] = False
                _LATEST_TRANSPORT_STATUS.update(latest)
            except Exception:
                pass
        try:
            handler.close_connection = True
        except Exception:
            pass
        conn.restore_blocking()
    return True
def _preferred_model() -> Optional[str]:
    state = os.environ.get("XRA_BACKEND_MODEL")
    if state and state in registry.REGISTRY:
        return state
    for mid in registry.REGISTRY:
        if registry.is_installed(mid):
            return mid
    return None
