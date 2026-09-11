# XRA_BACKEND_CONTROL_V5
# XRA_BACKEND_CAMERA_V3
"""WebSocket transport + inference glue for the ONNX mocap backends."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import threading
import time
from typing import Optional

from . import capture, downloader, engine, registry, runtime

_WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


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
        self._sock = getattr(self._sock, "_sock", self._sock)
        try:
            if self._sock is not None and hasattr(self._sock, "settimeout"):
                self._sock.settimeout(timeout)
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
        return self.send_text(json.dumps(obj, ensure_ascii=False))

    def send_ping(self) -> bool:
        return self._send_frame(0x9, b"")

    def close(self) -> None:
        if not self.closed:
            try:
                self._send_frame(0x8, b"")
            except Exception:
                pass
        self.closed = True


# XRA_ONNX_STABILITY_V2: one browser frame -> one terminal JSON reply.
class InferenceWorker:
    """One WebSocket peer with an explicit control or pose role."""

    def __init__(self, conn: WSConnection, on_status=None):
        self.conn = conn
        self.on_status = on_status
        self.loop_count = 0
        self.errors = 0
        self._last_ok = time.time()
        self._subscribed = False
        self._role = "legacy"
        self._tx_json_cnt = 0
        self._rx_bin_cnt = 0

    def run(self) -> None:
        idle_since = None
        try:
            while not self.conn.closed:
                self.conn.read_timed_out = False
                msg = self.conn.read_message()
                if msg is None:
                    if self.conn.read_timed_out and not self.conn.closed:
                        idle_since = idle_since or time.time()
                        self.conn.send_ping()
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
            capture.CAPTURE.subscribe(self._on_pose)
        else:
            capture.CAPTURE.unsubscribe(self._on_pose)
        self._subscribed = enabled
        print(
            "[XRA_WS_SUB] " + json.dumps({
                "role": self._role,
                "enabled": enabled,
                "subscribers": capture.CAPTURE.subscriber_count,
            }),
            flush=True,
        )

    def _on_pose(self, wire: dict) -> None:
        if self.conn.closed or not self._subscribed:
            return
        self.loop_count += 1
        self._last_ok = time.time()
        sent = self.conn.send_json(wire)
        if sent:
            self._tx_json_cnt += 1
        else:
            self.errors += 1
        frame_id = int(wire.get("frame_id") or 0)
        if frame_id <= 3 or frame_id % 30 == 0 or not sent:
            print(
                "[XRA_WS_TX] " + json.dumps({
                    "role": self._role,
                    "frame_id": frame_id,
                    "sent": bool(sent),
                    "tx_count": self._tx_json_cnt,
                    "subscribed": self._subscribed,
                    "closed": self.conn.closed,
                }),
                flush=True,
            )

    def _handle_binary_frame(self, payload: bytes) -> None:
        self._rx_bin_cnt += 1
        self.conn.send_json({
            "type": "protocol_error",
            "error": "binary_frames_disabled_backend_owns_camera",
            "bytes": len(payload),
            "role": self._role,
        })

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
            self._send({
                "type": "status",
                **self._status(),
                "loading": True,
                "requested_model": model,
            }, obj)
            result = self._load(model, complexity)
            self._send({"type": "status", **result}, obj)
        elif mtype == "unload":
            capture.CAPTURE.stop()
            engine.ENGINE.unload()
            self._send({"type": "status", "ok": True, **self._status()}, obj)
        elif mtype in {"capture", "camera"}:
            self._handle_capture(obj)
        else:
            self._send({"type": "error", "error": f"unknown_message_type: {mtype}"}, obj)

    def _handle_capture(self, obj: dict) -> None:
        action = str(obj.get("action") or "status").lower()
        try:
            if action in {"configure", "config", "select"}:
                capture.CAPTURE.configure(
                    index=obj.get("index"),
                    device=obj.get("device"),
                    width=obj.get("width"),
                    height=obj.get("height"),
                    fps=obj.get("fps"),
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

    def _status(self) -> dict:
        st = engine.ENGINE.status()
        return {
            "model": st.get("model"),
            "provider": st.get("provider"),
            "provider_human": st.get("provider_human"),
            "ready": st.get("ready", False),
            "loading": st.get("loading", False),
            "requested_model": st.get("requested_model"),
            "generation": st.get("generation", 0),
            "accelerated": st.get("accelerated", False),
            "last_engine_error": st.get("last_error", ""),
            "model_complexity": st.get("model_complexity"),
            "frames": self.loop_count,
            "errors": self.errors,
            "source": "backend_camera",
            "role": self._role,
            "subscribed": self._subscribed,
            "capture": capture.CAPTURE.status(),
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
    worker.run()
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
