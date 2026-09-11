# XRA_TRACKING_HOTFIX_V9_3
# XRA_UNIVERSAL_RUNTIME_V9
# XRA_PERFORMANCE_RUNTIME_V7
# XRA_FRONTEND_STABILITY_V6
# XRA_BACKEND_CONTROL_V5
# XRA_BACKEND_CAMERA_V3
"""Local webcam capture + inference source for the mocap backends."""

from __future__ import annotations

import copy
import os
import shutil
import subprocess
import threading
import time
from io import BytesIO
from typing import Callable, Optional

import numpy as np

from . import engine, registry

_DEFAULT_WIDTH = 384
_DEFAULT_HEIGHT = 216
_DEFAULT_FPS = 20.0
_DEFAULT_DEVICE = os.environ.get("XRA_CAMERA_DEVICE", "/dev/video0")


# Hard ceilings protect the backend from legacy HTML5 constraints and cameras
# that negotiate Full-HD despite a small request. Override explicitly when a
# stronger machine needs a different trade-off.
_MAX_CAPTURE_WIDTH = 640
_MAX_CAPTURE_HEIGHT = 480
_MAX_INFER_WIDTH = 384
_MAX_INFER_HEIGHT = 216


def _find_ffmpeg() -> Optional[str]:
    for name in ("ffmpeg", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/snap/bin/ffmpeg"):
        found = shutil.which(name)
        if found:
            return found
        if os.path.isfile(name):
            return name
    return None


def _decode_jpeg_bgr(data: bytes) -> Optional[np.ndarray]:
    if not data:
        return None
    try:
        from PIL import Image
        rgb = np.array(Image.open(BytesIO(data)).convert("RGB"))
        return rgb[..., ::-1].copy()
    except Exception:
        return None


class _FfmpegGrabber:
    name = "ffmpeg"
    _SOI = b"\xff\xd8"
    _EOI = b"\xff\xd9"
    _MAX_FRAME = 5 * 1024 * 1024
    _READ_CHUNK = 16 * 1024

    def __init__(self, device: str, width: int, height: int, fps: float = 15.0):
        self.device = device
        self.width = width
        self.height = height
        self.fps = max(1.0, min(30.0, float(fps)))
        self.ffmpeg = _find_ffmpeg()
        self._proc: Optional[subprocess.Popen] = None
        self._buf = b""

    @property
    def available(self) -> bool:
        return self.ffmpeg is not None and os.path.exists(self.device)

    def _build_cmd(self, mjpeg_input: bool) -> list:
        cmd = [self.ffmpeg, "-hide_banner", "-loglevel", "error"]
        cmd += ["-f", "v4l2"]
        if mjpeg_input:
            cmd += ["-input_format", "mjpeg"]
        cmd += ["-framerate", str(int(self.fps))]
        cmd += ["-video_size", f"{self.width}x{self.height}"]
        cmd += ["-i", self.device]
        cmd += ["-r", str(int(self.fps)), "-f", "mjpeg", "-q:v", "5", "-"]
        return cmd

    def _start(self) -> bool:
        if not self.available:
            return False
        for mjpeg in (True, False):
            try:
                self._proc = subprocess.Popen(
                    self._build_cmd(mjpeg),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                )
                time.sleep(0.30)
                if self._proc.poll() is None:
                    return True
                self._proc = None
            except Exception:
                self._proc = None
                return False

    def read(self) -> Optional[np.ndarray]:
        if self._proc is None or self._proc.poll() is not None:
            self._buf = b""
            if not self._start():
                return None

        try:
            while len(self._buf) < self._MAX_FRAME:
                chunk = self._proc.stdout.read(self._READ_CHUNK)
                if not chunk:
                    self._proc = None
                    self._buf = b""
                    return None
                self._buf += chunk
                soi = self._buf.find(self._SOI)
                if soi < 0:
                    self._buf = b""
                    continue
                if soi > 0:
                    self._buf = self._buf[soi:]
                eoi = self._buf.find(self._EOI, 2)
                if eoi < 0:
                    continue
                jpeg = self._buf[:eoi + 2]
                self._buf = self._buf[eoi + 2:]
                return _decode_jpeg_bgr(jpeg)
        except Exception:
            self._proc = None
            self._buf = b""
            return None
        return None

    def release(self) -> None:
        proc = self._proc
        self._proc = None
        self._buf = b""
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass


class _OpenCVGrabber:
    name = "opencv"

    def __init__(self, device: str, width: int, height: int, fps: float = 20.0):
        self.device = str(device)
        self.width = int(width)
        self.height = int(height)
        self.fps = float(fps)
        self._cap = None
        self._cv2 = None
        self.last_error = ""
        self.actual_width = 0
        self.actual_height = 0
        self.actual_fps = 0.0

    @property
    def available(self) -> bool:
        try:
            import cv2
            return True
        except Exception:
            return False

    def _ensure(self) -> bool:
        if self._cap is not None:
            return True
        try:
            import cv2
        except Exception as exc:
            self.last_error = f"opencv import failed: {exc}"
            return False
        self._cv2 = cv2
        try:
            cv2.setNumThreads(1)
        except Exception:
            pass

        source = self.device
        if source.isdigit():
            source = int(source)
        elif source.startswith("/dev/video"):
            try:
                source = int(source.rsplit("video", 1)[1])
            except Exception:
                pass

        backend = None
        import sys
        if isinstance(source, int) and sys.platform.startswith("linux") and hasattr(cv2, "CAP_V4L2"):
            backend = cv2.CAP_V4L2
        elif isinstance(source, int) and sys.platform == "darwin" and hasattr(cv2, "CAP_AVFOUNDATION"):
            backend = cv2.CAP_AVFOUNDATION
        elif isinstance(source, int) and os.name == "nt" and hasattr(cv2, "CAP_DSHOW"):
            backend = cv2.CAP_DSHOW

        cap = cv2.VideoCapture()
        try:
            if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
                cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 2500)
            if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
                cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 2500)
            opened = cap.open(source, backend) if backend is not None else cap.open(source)
        except Exception as exc:
            self.last_error = f"camera open failed ({self.device}): {exc}"
            try:
                cap.release()
            except Exception:
                pass
            return False
        if not opened or not cap.isOpened():
            self.last_error = f"camera open failed ({self.device})"
            cap.release()
            return False

        # Ask for MJPEG before geometry: on V4L2 this often unlocks low-cost
        # 16:9 modes and avoids USB/raw-frame bandwidth spikes.
        if sys.platform.startswith("linux"):
            try:
                cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            except Exception:
                pass
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        cap.set(cv2.CAP_PROP_FPS, self.fps)
        if hasattr(cv2, "CAP_PROP_BUFFERSIZE"):
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        try:
            self.actual_width = int(round(cap.get(cv2.CAP_PROP_FRAME_WIDTH)))
            self.actual_height = int(round(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
            self.actual_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        except Exception:
            self.actual_width = self.actual_height = 0
            self.actual_fps = 0.0
        self._cap = cap
        self.last_error = ""
        return True

    def read(self) -> Optional[np.ndarray]:
        if not self._ensure():
            return None
        try:
            ok, frame = self._cap.read()
        except Exception:
            return None
        return frame if ok else None

    def release(self) -> None:
        cap, self._cap = self._cap, None
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass


def _make_grabber(device: str, width: int, height: int, fps: float = _DEFAULT_FPS):
    ocv = _OpenCVGrabber(device, width, height, fps=fps)
    if ocv.available:
        return ocv
    allow_ffmpeg = os.environ.get("XRA_ALLOW_FFMPEG_CAPTURE", "0").lower() in {
        "1", "true", "yes", "on"
    }
    if allow_ffmpeg:
        return _FfmpegGrabber(device, width, height, fps=fps)
    return ocv


class CaptureSource:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._paused = threading.Event()
        self._reopen = threading.Event()
        self._subscribers: set[Callable[[dict], None]] = set()
        self._subscribers_changed = threading.Event()
        self._device = _DEFAULT_DEVICE
        self._width = _DEFAULT_WIDTH
        self._height = _DEFAULT_HEIGHT
        self._target_fps = _DEFAULT_FPS
        self._grabber = None
        self._running = False
        self._available = False
        self._last_error = ""
        self._frames = 0
        self._last_frame_at = 0.0
        self._last_infer_ms = 0.0
        self._last_capture_ms = 0.0
        self._last_raw_geometry = (0, 0)
        self._last_inference_geometry = (0, 0)
        self._stabilizer_model = None
        self._body_last_good = [None] * 33
        self._body_last_good_at = [0.0] * 33
        self._hand_last_good = {"leftHand": None, "rightHand": None}
        self._hand_last_good_at = {"leftHand": 0.0, "rightHand": 0.0}
        self._held_joints = 0
        self._dropped_hands = 0

    def subscribe(self, on_pose: Callable[[dict], None]) -> None:
        with self._lock:
            before = len(self._subscribers)
            self._subscribers.add(on_pose)
            changed = len(self._subscribers) != before
        if changed:
            self._subscribers_changed.set()

    def unsubscribe(self, on_pose: Callable[[dict], None]) -> None:
        with self._lock:
            before = len(self._subscribers)
            self._subscribers.discard(on_pose)
            changed = len(self._subscribers) != before
        if changed:
            self._subscribers_changed.set()

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def start(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                self._running = True
                self._paused.clear()
                self._subscribers_changed.set()
                return
            self._stop.clear()
            self._paused.clear()
            self._running = True
            self._subscribers_changed.set()
            self._thread = threading.Thread(target=self._loop, name="xra-camera", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._paused.clear()
        self._subscribers_changed.set()
        thread = self._thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=3.0)
        self._release_camera()
        with self._lock:
            self._running = False
            self._thread = None

    def pause(self) -> None:
        self._paused.set()
        self._reopen.set()
        self._subscribers_changed.set()

    def resume(self) -> None:
        self.start()
        self._paused.clear()
        self._subscribers_changed.set()

    def configure(self, *, index=None, device=None, width=None, height=None, fps=None) -> dict:
        if device is None and index is not None:
            try:
                index = int(index)
                import sys
                device = f"/dev/video{index}" if sys.platform.startswith("linux") else str(index)
            except Exception:
                device = str(index)
        with self._lock:
            if device is not None:
                self._device = str(device)
            next_width = self._width if width is None else max(160, int(width))
            next_height = self._height if height is None else max(120, int(height))
            bound = min(
                1.0,
                _MAX_CAPTURE_WIDTH / max(1, next_width),
                _MAX_CAPTURE_HEIGHT / max(1, next_height),
            )
            self._width = max(160, int(round(next_width * bound)))
            self._height = max(120, int(round(next_height * bound)))
            if fps is not None:
                self._target_fps = max(1.0, min(60.0, float(fps)))
        self._reopen.set()
        self._subscribers_changed.set()
        return self.status()

    def set_geometry(self, width: Optional[int] = None, height: Optional[int] = None) -> None:
        self.configure(width=width, height=height)

    def set_device(self, device: str) -> None:
        self.configure(device=device)

    def set_target_fps(self, fps: float) -> None:
        try:
            self.configure(fps=fps)
        except Exception:
            return

    def status(self) -> dict:
        with self._lock:
            count = len(self._subscribers)
            return {
                "running": self._running and not self._stop.is_set(),
                "paused": self._paused.is_set(),
                "available": self._available,
                "camera_open": self._grabber is not None,
                "publishing": (
                    self._running
                    and not self._paused.is_set()
                    and self._grabber is not None
                    and count > 0
                    and engine.ENGINE.ready
                ),
                "device": self._device,
                "backend": getattr(self._grabber, "name", None),
                "geometry": [self._width, self._height],
                "capture_geometry": list(self._last_raw_geometry),
                "inference_geometry": list(self._last_inference_geometry),
                "effective_fps": self._effective_fps(),
                "held_joints": self._held_joints,
                "dropped_hands": self._dropped_hands,
                "target_fps": self._target_fps,
                "subscribers": count,
                "frames": self._frames,
                "last_infer_ms": self._last_infer_ms,
                "last_capture_ms": self._last_capture_ms,
                "last_frame_age_ms": (
                    round((time.time() - self._last_frame_at) * 1000.0, 1)
                    if self._last_frame_at else None
                ),
                "last_error": self._last_error,
            }

    def _loop(self) -> None:
        grabber = None
        failures = 0
        try:
            while not self._stop.is_set():
                if self._paused.is_set():
                    if grabber is not None:
                        self._release_camera(); grabber = None
                    self._stop.wait(0.1)
                    continue

                if self._reopen.is_set():
                    self._reopen.clear()
                    if grabber is not None:
                        self._release_camera(); grabber = None

                if not engine.ENGINE.ready:
                    self._stop.wait(0.05)
                    continue

                # 1. Apertura hardware immediata al comando start
                if grabber is None:
                    grabber = self._ensure_camera()
                    if grabber is None:
                        self._stop.wait(0.5)
                        continue
                    failures = 0

                # 2. Se non ci sono subscriber, non eseguire inferenza ONNX a vuoto
                if self.subscriber_count == 0:
                    # Clear before the second count so a subscription racing this
                    # block cannot be lost between the check and wait.
                    self._subscribers_changed.clear()
                    if self.subscriber_count == 0:
                        self._subscribers_changed.wait(1.0)
                    continue

                loop_started = time.perf_counter()
                capture_started = time.perf_counter()
                frame = grabber.read()
                self._last_capture_ms = (time.perf_counter() - capture_started) * 1000.0

                if frame is None:
                    failures += 1
                    self._set_error(getattr(grabber, "last_error", "") or "frame grab failed")
                    if failures >= 5:
                        self._release_camera(); grabber = None; failures = 0
                        self._stop.wait(0.5)
                    else:
                        self._stop.wait(0.02)
                    continue

                failures = 0
                self._available = True
                self._last_error = ""
                self._run_inference(frame)

                interval = 1.0 / max(1.0, self._effective_fps())
                slack = interval - (time.perf_counter() - loop_started)
                if slack > 0:
                    self._stop.wait(slack)
        finally:
            self._release_camera()
            with self._lock:
                self._running = False
                self._thread = None

    def _effective_fps(self) -> float:
        with self._lock:
            return max(1.0, min(60.0, float(self._target_fps)))
    def _prepare_inference_frame(self, frame: np.ndarray) -> np.ndarray:
        raw_h, raw_w = frame.shape[:2]
        self._last_raw_geometry = (int(raw_w), int(raw_h))
        scale = min(
            1.0,
            _MAX_INFER_WIDTH / max(1, raw_w),
            _MAX_INFER_HEIGHT / max(1, raw_h),
        )
        if scale >= 0.999:
            self._last_inference_geometry = (int(raw_w), int(raw_h))
            return frame
        out_w = max(2, int(round(raw_w * scale)))
        out_h = max(2, int(round(raw_h * scale)))
        try:
            import cv2
            reduced = cv2.resize(frame, (out_w, out_h), interpolation=cv2.INTER_AREA)
        except Exception:
            xs = np.linspace(0, raw_w - 1, out_w).astype(np.int32)
            ys = np.linspace(0, raw_h - 1, out_h).astype(np.int32)
            reduced = np.ascontiguousarray(frame[ys][:, xs])
        self._last_inference_geometry = (out_w, out_h)
        return reduced

    @staticmethod
    def _point_score(point) -> float:
        if not isinstance(point, dict):
            return 0.0
        try:
            return float(point.get("score", point.get("visibility", 0.0)) or 0.0)
        except Exception:
            return 0.0

    @staticmethod
    def _point_xy(point):
        if not isinstance(point, dict):
            return None
        pos = point.get("position") if isinstance(point.get("position"), dict) else point
        try:
            x, y = float(pos.get("x")), float(pos.get("y"))
            if not np.isfinite(x) or not np.isfinite(y):
                return None
            return x, y
        except Exception:
            return None

    def _reset_landmark_stabilizer(self, model_id=None) -> None:
        self._stabilizer_model = model_id
        self._body_last_good = [None] * 33
        self._body_last_good_at = [0.0] * 33
        self._joint_recovery = [0] * 33
        self._hand_last_good = {"leftHand": None, "rightHand": None}
        self._hand_last_good_at = {"leftHand": 0.0, "rightHand": 0.0}
        self._held_joints = 0
        self._dropped_hands = 0
    def _stabilize_payload(self, payload: dict, width: int, height: int) -> dict:
        """Reject low-confidence/kinematically implausible ONNX limb hallucinations.

        Important v9.3 change: an invalid joint with no previous good sample is
        actively suppressed instead of being left untouched. That was the hole
        that allowed invisible legs to appear on the first frame.
        """
        if not isinstance(payload, dict):
            return payload
        model_id = str(engine.ENGINE.model_id or "")
        if self._stabilizer_model != model_id:
            self._reset_landmark_stabilizer(model_id)
        if not hasattr(self, "_joint_recovery"):
            self._joint_recovery = [0] * 33

        now = time.monotonic()
        body = payload.get("keypoints")
        body3 = payload.get("keypoints3D")
        is_onnx = "mediapipe" not in model_id.lower()

        if isinstance(body, list) and len(body) == 33 and is_onnx:
            parent = {
                13: 11, 15: 13, 17: 15, 19: 15, 21: 15,
                14: 12, 16: 14, 18: 16, 20: 16, 22: 16,
                25: 23, 27: 25, 29: 27, 31: 27,
                26: 24, 28: 26, 30: 28, 32: 28,
            }
            thresholds = {
                13: 0.34, 14: 0.34,
                15: 0.46, 16: 0.46,
                17: 0.52, 18: 0.52, 19: 0.52, 20: 0.52, 21: 0.52, 22: 0.52,
                25: 0.44, 26: 0.44,
                27: 0.55, 28: 0.55,
                29: 0.60, 30: 0.60, 31: 0.60, 32: 0.60,
            }
            default_threshold = 0.12
            distal = {15,16,17,18,19,20,21,22,27,28,29,30,31,32}
            diag = max(1.0, float((width * width + height * height) ** 0.5))

            def point_distance(a, b):
                aa, bb = self._point_xy(a), self._point_xy(b)
                if aa is None or bb is None:
                    return None
                return ((aa[0] - bb[0]) ** 2 + (aa[1] - bb[1]) ** 2) ** 0.5

            # Torso scale for bone plausibility. Use shoulder-mid to hip-mid.
            torso = max(24.0, height * 0.12)
            ls, rs = self._point_xy(body[11]), self._point_xy(body[12])
            lh, rh = self._point_xy(body[23]), self._point_xy(body[24])
            if ls and rs and lh and rh:
                shoulder_mid = ((ls[0] + rs[0]) * 0.5, (ls[1] + rs[1]) * 0.5)
                hip_mid = ((lh[0] + rh[0]) * 0.5, (lh[1] + rh[1]) * 0.5)
                torso = max(torso, ((shoulder_mid[0] - hip_mid[0]) ** 2 + (shoulder_mid[1] - hip_mid[1]) ** 2) ** 0.5)

            bone_max = {
                13: 1.55, 14: 1.55, 15: 1.55, 16: 1.55,
                17: 0.75, 18: 0.75, 19: 0.75, 20: 0.75, 21: 0.75, 22: 0.75,
                25: 2.05, 26: 2.05, 27: 2.05, 28: 2.05,
                29: 0.85, 30: 0.85, 31: 0.95, 32: 0.95,
            }

            accepted = [False] * 33
            # Core points do not use the strict limb gate.
            for i in range(33):
                if i not in parent:
                    score = self._point_score(body[i])
                    xy = self._point_xy(body[i])
                    accepted[i] = bool(xy is not None and score >= default_threshold)

            for index in range(33):
                point = body[index]
                score = self._point_score(point)
                xy = self._point_xy(point)
                threshold = thresholds.get(index, default_threshold)
                sane = xy is not None and score >= threshold

                if sane and index in distal:
                    x, y = xy
                    # Distal landmarks outside the real image are never valid.
                    sane = (0.0 <= x <= width and 0.0 <= y <= height)

                pidx = parent.get(index)
                if sane and pidx is not None:
                    # Child cannot be trusted when its kinematic parent is lost.
                    parent_score = self._point_score(body[pidx])
                    parent_xy = self._point_xy(body[pidx])
                    if parent_xy is None or parent_score < max(0.18, thresholds.get(pidx, 0.18) * 0.75):
                        sane = False
                    else:
                        dist = point_distance(point, body[pidx])
                        if dist is None or dist > torso * bone_max.get(index, 2.2):
                            sane = False
                        # Reject implausible upward folds commonly produced when
                        # cropped legs are hallucinated back into the torso.
                        if index in {25,26,27,28,29,30,31,32} and xy[1] < parent_xy[1] - torso * 0.45:
                            sane = False

                previous = self._body_last_good[index]
                if sane and previous is not None:
                    prev_xy = self._point_xy(previous[0])
                    if prev_xy is not None:
                        jump = ((xy[0] - prev_xy[0]) ** 2 + (xy[1] - prev_xy[1]) ** 2) ** 0.5
                        if jump > diag * 0.28 and score < 0.72:
                            sane = False

                # Recovering a distal point after it was absent requires three
                # consecutive convincing frames; one hallucinated frame is not enough.
                if sane and previous is None and index in distal:
                    self._joint_recovery[index] += 1
                    if self._joint_recovery[index] < 3:
                        sane = False
                elif sane:
                    self._joint_recovery[index] = 3
                else:
                    self._joint_recovery[index] = 0

                if sane:
                    saved3 = copy.deepcopy(body3[index]) if isinstance(body3, list) and len(body3) == 33 else None
                    self._body_last_good[index] = (copy.deepcopy(point), saved3)
                    self._body_last_good_at[index] = now
                    accepted[index] = True
                    continue

                # Suppress invalid candidate. Never leave a first-frame hallucination
                # in the payload just because there is no last-good value yet.
                if previous is not None:
                    age = now - self._body_last_good_at[index]
                    held2, held3 = previous
                    body[index] = copy.deepcopy(held2)
                    body[index]["score"] = 0.08 if age <= 0.16 else 0.0
                    if isinstance(body[index].get("position"), dict):
                        body[index]["visibility"] = body[index]["score"]
                    if isinstance(body3, list) and len(body3) == 33 and held3 is not None:
                        body3[index] = copy.deepcopy(held3)
                        if isinstance(body3[index], dict):
                            body3[index]["score"] = body[index]["score"]
                    self._held_joints += 1
                else:
                    pidx = parent.get(index)
                    if pidx is not None and 0 <= pidx < len(body):
                        parent_point = copy.deepcopy(body[pidx])
                        if isinstance(parent_point, dict):
                            parent_point["score"] = 0.0
                            if isinstance(parent_point.get("position"), dict):
                                parent_point["visibility"] = 0.0
                            body[index] = parent_point
                    else:
                        if isinstance(point, dict):
                            point["score"] = 0.0
                            if isinstance(point.get("position"), dict):
                                point["visibility"] = 0.0
                    if isinstance(body3, list) and len(body3) == 33:
                        if pidx is not None and 0 <= pidx < len(body3) and isinstance(body3[pidx], dict):
                            body3[index] = copy.deepcopy(body3[pidx])
                        if isinstance(body3[index], dict):
                            body3[index]["score"] = 0.0

        for key in ("leftHand", "rightHand"):
            hand = payload.get(key)
            valid = isinstance(hand, list) and len(hand) == 21
            scores = [self._point_score(p) for p in hand] if valid else []
            finite = valid and sum(self._point_xy(p) is not None for p in hand) >= 18
            median = float(np.median(scores)) if scores else 0.0
            wrist = scores[0] if scores else 0.0
            threshold = 0.34 if is_onnx else 0.20
            wrist_threshold = 0.30 if is_onnx else 0.15
            if finite and median >= threshold and wrist >= wrist_threshold:
                self._hand_last_good[key] = copy.deepcopy(hand)
                self._hand_last_good_at[key] = now
            else:
                previous_hand = self._hand_last_good.get(key)
                age = now - self._hand_last_good_at.get(key, 0.0)
                if previous_hand is not None and age <= 0.12:
                    payload[key] = copy.deepcopy(previous_hand)
                else:
                    payload[key] = []
                    if previous_hand is not None:
                        self._dropped_hands += 1
        return payload
    def _run_inference(self, frame: np.ndarray) -> None:
        frame = self._prepare_inference_frame(frame)
        started = time.perf_counter()
        try:
            payload = engine.ENGINE.infer(frame)
            if payload is not None:
                payload = self._stabilize_payload(payload, frame.shape[1], frame.shape[0])
        except Exception as exc:
            self._set_error(f"infer: {exc}")
            return
        self._last_infer_ms = (time.perf_counter() - started) * 1000.0
        height, width = frame.shape[:2]
        if payload is None:
            payload = {"score": 0.0, "keypoints": [], "keypoints3D": [],
                       "face": None, "leftHand": [], "rightHand": []}
        wire = engine.to_wire(payload, capture_hint=(width, height))
        self._frames += 1
        self._last_frame_at = time.time()
        wire.update({
            "type": "pose",
            "frame_id": self._frames,
            "timestamp_ms": int(self._last_frame_at * 1000),
            "capture_width": width,
            "capture_height": height,
            "ms": self._last_infer_ms,
            "provider": engine.ENGINE.provider,
            "empty": not bool(wire.get("keypoints")),
            "reason": None if wire.get("keypoints") else "no_detection",
        })
        if self._frames % 30 == 1 or wire.get("empty") or not (wire.get("geometry") or {}).get("valid", True):
            print("[XRA_FRAME] " + __import__("json").dumps({
                "type": "pose", "frame_id": self._frames,
                "width": width, "height": height,
                "raw_geometry": list(self._last_raw_geometry),
                "ms": round(self._last_infer_ms, 2),
                "keypoints": len(wire.get("keypoints") or []),
                "geometry": wire.get("geometry"),
                "provider": wire.get("provider"),
                "error": wire.get("reason"),
            }, ensure_ascii=False), flush=True)
        with self._lock:
            subscribers = list(self._subscribers)
        for callback in subscribers:
            try:
                callback(wire)
            except Exception:
                pass

    def _ensure_camera(self):
        with self._lock:
            device = self._device
            width = self._width
            height = self._height
            fps = self._target_fps
        if self._grabber is not None:
            return self._grabber
        grabber = _make_grabber(device, width, height, fps=fps)
        if not grabber.available:
            self._set_error(f"camera backend unavailable ({grabber.name} {device})")
            return None
        ensure = getattr(grabber, "_ensure", None)
        if not callable(ensure) or not ensure():
            self._set_error(getattr(grabber, "last_error", "") or f"camera open failed ({device})")
            try:
                grabber.release()
            except Exception:
                pass
            return None
        self._grabber = grabber
        self._available = True
        self._last_error = ""
        return grabber

    def _release_camera(self) -> None:
        grabber, self._grabber = self._grabber, None
        self._available = False
        if grabber is not None:
            try:
                grabber.release()
            except Exception:
                pass

    def _set_error(self, message: str) -> None:
        self._available = False
        self._last_error = str(message)


CAPTURE = CaptureSource()
