"""Native Python MediaPipe Tasks backend.

``HolisticTasksEngine`` is the stable CPU path. ``SplitTasksEngine`` runs the
native Face, Pose and Hand Task graphs concurrently on an explicitly selected
GPU, avoiding the Holistic GPU graph that is broken on some Linux EGL drivers.
Both emit the same whole-body payload contract used by the browser adapter: 33
pose landmarks, 21+21 hand landmarks, face landmarks and native blendshapes.
The engines are lazy-loaded; missing packages/models leave them unavailable
without terminating the XR server process.

Face landmarks are converted to the pixel/full-frame convention expected by the
existing JS consumer while native Tasks blendshapes are preserved under
``face.blendshapes.native``.
"""

from __future__ import annotations

import contextlib
import os
import queue
import sys
import threading
import time
from typing import Optional

import numpy as np

from . import registry

import logging

_GPU_AVAILABLE = None
_GPU_NAME = "Unknown GPU"

def _check_gpu():
    global _GPU_AVAILABLE, _GPU_NAME
    if os.environ.get("XRA_FORCE_CPU") == "1":
        _GPU_NAME = "CPU (XNNPACK)"
        return False
    if _GPU_AVAILABLE is not None:
        return _GPU_AVAILABLE
    try:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
        import tempfile
        model_path = registry.model_dir(registry.MEDIAPIPE_TASKS_ID) / "face_landmarker.task"
        if not model_path.is_file():
            _GPU_AVAILABLE = False
            return False
            
        saved_stderr = os.dup(2)
        tmp = tempfile.NamedTemporaryFile()
        os.dup2(tmp.fileno(), 2)
        
        try:
            base_options = mp_python.BaseOptions(model_asset_path=str(model_path), delegate=mp_python.BaseOptions.Delegate.GPU)
            options = vision.FaceLandmarkerOptions(base_options=base_options, running_mode=vision.RunningMode.IMAGE)
            lm = vision.FaceLandmarker.create_from_options(options)
            fake_img = np.zeros((16, 16, 3), dtype=np.uint8)
            lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=fake_img))
            lm.close()
            _GPU_AVAILABLE = True
        finally:
            os.dup2(saved_stderr, 2)
            os.close(saved_stderr)
            
        tmp.seek(0)
        logs = tmp.read().decode("utf-8", errors="ignore")
        tmp.close()
        for line in logs.split("\n"):
            if "renderer:" in line:
                _GPU_NAME = line.split("renderer:")[-1].strip()
    except Exception as e:
        print(f"[XRA_MP] GPU Delegate not supported or failed to init: {e}", flush=True)
        _GPU_AVAILABLE = False
    return _GPU_AVAILABLE


def reset_gpu_probe() -> None:
    """Forget a cached delegate result after the selected GPU changes."""
    global _GPU_AVAILABLE, _GPU_NAME
    _GPU_AVAILABLE = None
    _GPU_NAME = "Unknown GPU"

@contextlib.contextmanager
def suppress_c_stderr():
    """Silences low-level C/C++ writes to file descriptor 2 (STDERR) from MediaPipe/TFLite/glog."""
    if os.environ.get("XRA_VERBOSE", "0") in {"1", "true", "yes", "on"}:
        yield
        return
    old_stderr = None
    try:
        sys.stderr.flush()
        devnull = os.open(os.devnull, os.O_WRONLY)
        old_stderr = os.dup(2)
        os.dup2(devnull, 2)
        os.close(devnull)
    except Exception:
        old_stderr = None
    try:
        yield
    finally:
        if old_stderr is not None:
            try:
                sys.stderr.flush()
                os.dup2(old_stderr, 2)
                os.close(old_stderr)
            except Exception:
                pass

# -- face-mesh landmark indices used for blendshape math ---------------------
# (MediaPipe face-mesh canonical index map.)
_L_EYE = (33, 160, 158, 133, 153, 144)   # 6-point EAR ring (left)
_R_EYE = (362, 385, 387, 263, 373, 380)  # 6-point EAR ring (right)
_MOUTH_V = (13, 14)                       # upper/lower inner lip (jawOpen)
_MOUTH_L = (61, 291)                      # corner L/R (smile width)
_MOUTH_TOP = 13
_MOUTH_BOT = 14

# Tasks API native blendshape names we care about (for the scalar fallbacks
# when the Tasks engine reports no face landmarks but does report blendshapes).
_TASKS_BLINK = {"eyeBlinkLeft": "eyeBlinkLeft", "eyeBlinkRight": "eyeBlinkRight"}


def _ear(pts, ring) -> float:
    """Eye Aspect Ratio from a 6-point ring; 0 when degenerate."""
    try:
        p = [pts[i] for i in ring]
        v1 = np.hypot(p[1][0] - p[5][0], p[1][1] - p[5][1])
        v2 = np.hypot(p[2][0] - p[4][0], p[2][1] - p[4][1])
        h = np.hypot(p[0][0] - p[3][0], p[0][1] - p[3][1])
        if h <= 1e-6:
            return 0.0
        return float((v1 + v2) / (2.0 * h))
    except Exception:
        return 0.0


def _blendshapes_from_face(pts) -> dict:
    """Derive a small, vendor-neutral blendshape set from face-mesh pixels.

    ``pts`` is a list of ``(x, y)`` in *normalized* face-box coordinates for
    stability across engines; the ear/mouth ratios are scale-invariant.
    """
    if not pts or len(pts) < 300:
        return {"eyeBlinkLeft": 0.0, "eyeBlinkRight": 0.0,
                "jawOpen": 0.0, "mouthSmile": 0.0, "mouthFrown": 0.0}
    ear_l = _ear(pts, _L_EYE)
    ear_r = _ear(pts, _R_EYE)
    # EAR ~0.30 open, ~0.10 closed -> map to a 0..1 blink.
    blink_l = float(np.clip(1.0 - (ear_l / 0.30), 0.0, 1.0)) ** 0.7
    blink_r = float(np.clip(1.0 - (ear_r / 0.30), 0.0, 1.0)) ** 0.7

    try:
        upper = np.array(pts[_MOUTH_TOP]); lower = np.array(pts[_MOUTH_BOT])
        mouth_h = float(np.hypot(*(upper - lower)))
        corner_w = float(np.hypot(*(np.array(pts[_MOUTH_L[0]]) - np.array(pts[_MOUTH_L[1]]))))
        jaw = float(np.clip(mouth_h / (corner_w + 1e-6) * 2.5, 0.0, 1.0))
        # Smile: corners raised above the midline of the inner lips.
        mid_y = (upper[1] + lower[1]) * 0.5
        corner_y = (pts[_MOUTH_L[0]][1] + pts[_MOUTH_L[1]][1]) * 0.5
        lift = (mid_y - corner_y) / (corner_w + 1e-6)
        smile = float(np.clip(lift * 2.0, 0.0, 1.0))
        frown = float(np.clip(-lift * 2.0, 0.0, 1.0))
    except Exception:
        jaw = smile = frown = 0.0

    return {"eyeBlinkLeft": blink_l, "eyeBlinkRight": blink_r,
            "jawOpen": jaw, "mouthSmile": smile, "mouthFrown": frown}


def _bgr_to_rgb(frame_bgr: np.ndarray) -> np.ndarray:
    """Fast color conversion using OpenCV SIMD routines with fallback."""
    try:
        import cv2
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    except Exception:
        rgb = np.ascontiguousarray(frame_bgr[..., ::-1])
    if rgb.dtype != np.uint8:
        rgb = np.clip(rgb, 0, 255).astype(np.uint8)
    return rgb


class HolisticTasksEngine:
    """``mediapipe.tasks.vision.HolisticLandmarker`` wrapper."""

    name = "holistic-tasks"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._landmarker = None
        self._mp = None
        self._last_timestamp_ms = -1
        self._min_tracking_confidence = 0.50
        self._min_pose_confidence = 0.50
        self._min_face_confidence = 0.50
        self._last_shape: Optional[tuple[int, int]] = None
        self._accelerated = False

    @property
    def ready(self) -> bool:
        return self._landmarker is not None

    def configure_confidence(self, min_tracking=None, min_pose=None, min_face=None) -> dict:
        changed = False
        if min_tracking is not None:
            val = max(0.1, min(0.95, float(min_tracking)))
            if abs(val - self._min_tracking_confidence) > 1e-4:
                self._min_tracking_confidence = val
                changed = True
        if min_pose is not None:
            val = max(0.1, min(0.95, float(min_pose)))
            if abs(val - self._min_pose_confidence) > 1e-4:
                self._min_pose_confidence = val
                changed = True
        if min_face is not None:
            val = max(0.1, min(0.95, float(min_face)))
            if abs(val - self._min_face_confidence) > 1e-4:
                self._min_face_confidence = val
                changed = True
        if changed and self._landmarker is not None:
            return self.load()
        return {"ok": True, "changed": changed}

    def load(self, accelerated: Optional[bool] = None, **_) -> dict:
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision
        except Exception as exc:
            return {"ok": False, "error": f"mediapipe tasks unavailable: {exc}",
                    "needs_package": True}
        if not hasattr(vision, "HolisticLandmarker") or not hasattr(vision, "HolisticLandmarkerOptions"):
            return {
                "ok": False,
                "error": (
                    f"MediaPipe Tasks HolisticLandmarker is unavailable in mediapipe "
                    f"{getattr(mp, '__version__', 'unknown')} on Python "
                    f"{sys.version_info.major}.{sys.version_info.minor}"
                ),
                "needs_package": True,
            }
        if not registry.is_installed(registry.MEDIAPIPE_TASKS_ID):
            return {"ok": False, "error": "holistic_landmarker.task not installed",
                    "needs_download": True}
        target_accel = self._accelerated if accelerated is None else bool(accelerated)
        self.unload()
        model_path = registry.model_dir(registry.MEDIAPIPE_TASKS_ID) / "holistic_landmarker.task"
        try:
            self._accelerated = bool(target_accel and _check_gpu())
            if self._accelerated:
                base = mp_python.BaseOptions(model_asset_path=str(model_path), delegate=mp_python.BaseOptions.Delegate.GPU)
            else:
                base = mp_python.BaseOptions(model_asset_path=str(model_path))
            option_kwargs = {
                "base_options": base,
                "running_mode": vision.RunningMode.VIDEO,
                "output_face_blendshapes": True,
                "min_face_detection_confidence": self._min_face_confidence,
                "min_face_landmarks_confidence": self._min_face_confidence,
                "min_pose_detection_confidence": self._min_pose_confidence,
                "min_pose_landmarks_confidence": self._min_tracking_confidence,
                "min_hand_landmarks_confidence": max(0.20, self._min_tracking_confidence * 0.50),
            }
            # Keep optional fields feature-detected for MediaPipe API compatibility.
            option_fields = getattr(
                vision.HolisticLandmarkerOptions, "__dataclass_fields__", {}
            )
            if "output_facial_transformation_matrixes" in option_fields:
                option_kwargs["output_facial_transformation_matrixes"] = False
            opts = vision.HolisticLandmarkerOptions(**option_kwargs)
            self._mp = mp
            with suppress_c_stderr():
                self._landmarker = vision.HolisticLandmarker.create_from_options(opts)
            self._last_timestamp_ms = -1
            return {"ok": True, "engine": self.name}
        except Exception as exc:
            self._landmarker = None
            return {"ok": False, "error": f"holistic landmarker init failed: {exc}"}

    def unload(self) -> None:
        if self._landmarker is not None:
            try:
                self._landmarker.close()
            except Exception:
                pass
        self._landmarker = None
        self._mp = None
        self._last_timestamp_ms = -1
        self._last_shape = None
        self._accelerated = False

    def infer(self, frame_bgr: np.ndarray) -> Optional[dict]:
        if self._landmarker is None or self._mp is None:
            return None
        try:
            h, w, c = frame_bgr.shape
            if c != 3:
                return None
            if self._last_shape is not None and self._last_shape != (h, w):
                if not getattr(self._landmarker, "_is_closed", False):
                    with suppress_c_stderr():
                        self._landmarker.close()
                with self._lock:
                    result = self.load()
                    if not result.get("ok"):
                        return None
            self._last_shape = (h, w)
            rgb = _bgr_to_rgb(frame_bgr)
            if self._accelerated:
                rgb = rgb.copy()  # Prevent tensor.cc sync write conflicts on GPU
            mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
            with self._lock:
                timestamp_ms = time.monotonic_ns() // 1_000_000
                if timestamp_ms <= self._last_timestamp_ms:
                    timestamp_ms = self._last_timestamp_ms + 1
                self._last_timestamp_ms = timestamp_ms
                with suppress_c_stderr():
                    res = self._landmarker.detect_for_video(mp_image, timestamp_ms)
            out = _tasks_result_to_wholebody(res, w, h)
            if not isinstance(out.get("keypoints"), list) or len(out["keypoints"]) != 33:
                return None
            out.setdefault("leftHand", [])
            out.setdefault("rightHand", [])
            out.setdefault("leftHandWorld", [])
            out.setdefault("rightHandWorld", [])
            if not isinstance(out.get("face"), dict):
                out["face"] = {"landmarks": [], "blendshapes": {"native": {}}}
            out["face"].setdefault("landmarks", [])
            blendshapes = out["face"].get("blendshapes")
            if not isinstance(blendshapes, dict):
                blendshapes = {}
                out["face"]["blendshapes"] = blendshapes
            if not isinstance(blendshapes.get("native"), dict):
                blendshapes["native"] = {}
            return out
        except Exception as exc:
            exc_str = str(exc)
            # MediaPipe graph internal size mismatch (e.g. resolution changed between frames).
            # Recover cleanly by reloading the graph with new dimensions.
            _is_size_crash = any(k in exc_str for k in ("rows", "batch size", "batch_size",
                                                          "Batch size", "divergent", "shape"))
            if _is_size_crash:
                print(f"[XRA_MP_TASKS] graph size mismatch caught — reloading landmarker: {exc}", flush=True)
                self.load()
                self._last_shape = (h, w) if 'h' in locals() and 'w' in locals() else None
            else:
                print(f"[XRA_MP_TASKS] inference/conversion failed: {type(exc).__name__}: {exc}", flush=True)
            return None


class FaceTasksEngine:
    """Dedicated MediaPipe FaceLandmarker with the native 52 blendshapes."""

    name = "face-landmarker"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._landmarker = None
        self._mp = None
        self._last_timestamp_ms = -1
        self._min_face_confidence = 0.50
        self._min_tracking_confidence = 0.50
        self._last_shape: Optional[tuple[int, int]] = None
        self._accelerated = False

    @property
    def ready(self) -> bool:
        return self._landmarker is not None

    def configure_confidence(self, min_tracking=None, min_pose=None, min_face=None) -> dict:
        changed = False
        if min_face is not None:
            val = max(0.1, min(0.95, float(min_face)))
            if abs(val - self._min_face_confidence) > 1e-4:
                self._min_face_confidence = val
                changed = True
        if min_tracking is not None:
            val = max(0.1, min(0.95, float(min_tracking)))
            if abs(val - self._min_tracking_confidence) > 1e-4:
                self._min_tracking_confidence = val
                changed = True
        if changed and self._landmarker is not None:
            return self.load()
        return {"ok": True, "changed": changed}

    def load(self, accelerated: Optional[bool] = None, **_) -> dict:
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision
        except Exception as exc:
            return {"ok": False, "error": f"mediapipe face tasks unavailable: {exc}"}
        model_path = registry.model_dir(registry.MEDIAPIPE_TASKS_ID) / "face_landmarker.task"
        if not model_path.is_file():
            return {"ok": False, "error": "face_landmarker.task not installed", "needs_download": True}
        target_accel = self._accelerated if accelerated is None else bool(accelerated)
        self.unload()
        try:
            self._accelerated = bool(target_accel and _check_gpu())
            if self._accelerated:
                base = mp_python.BaseOptions(model_asset_path=str(model_path), delegate=mp_python.BaseOptions.Delegate.GPU)
            else:
                base = mp_python.BaseOptions(model_asset_path=str(model_path))
            options = vision.FaceLandmarkerOptions(
                base_options=base,
                running_mode=vision.RunningMode.VIDEO,
                num_faces=1,
                min_face_detection_confidence=self._min_face_confidence,
                min_face_presence_confidence=self._min_face_confidence,
                min_tracking_confidence=self._min_tracking_confidence,
                output_face_blendshapes=True,
                output_facial_transformation_matrixes=False,
            )
            self._mp = mp
            with suppress_c_stderr():
                self._landmarker = vision.FaceLandmarker.create_from_options(options)
            self._last_timestamp_ms = -1
            return {"ok": True, "engine": self.name}
        except Exception as exc:
            self._landmarker = None
            return {"ok": False, "error": f"face landmarker init failed: {exc}"}

    def unload(self) -> None:
        if self._landmarker is not None:
            try:
                self._landmarker.close()
            except Exception:
                pass
        self._landmarker = None
        self._mp = None
        self._last_timestamp_ms = -1
        self._last_shape = None
        self._accelerated = False

    def infer(self, frame_bgr: np.ndarray) -> Optional[dict]:
        if self._landmarker is None or self._mp is None:
            self.load()
            if self._landmarker is None or self._mp is None:
                return None
        try:
            h, w = frame_bgr.shape[:2]
            if h <= 0 or w <= 0:
                return None
            if self._last_shape is not None and (h, w) != self._last_shape:
                self.load()
                if self._landmarker is None or self._mp is None:
                    return None
            self._last_shape = (h, w)
            rgb = _bgr_to_rgb(frame_bgr)
            if self._accelerated:
                rgb = rgb.copy()  # Prevent tensor.cc sync write conflicts on GPU
            mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
            with self._lock:
                timestamp_ms = max(time.monotonic_ns() // 1_000_000, self._last_timestamp_ms + 1)
                self._last_timestamp_ms = timestamp_ms
                with suppress_c_stderr():
                    result = self._landmarker.detect_for_video(mp_image, timestamp_ms)
            face_payload = _face_result_to_payload(result, w, h)
            has_face = bool(face_payload.get("landmarks"))
            return {
                "score": 1.0 if has_face else 0.0,
                "keypoints": [],
                "keypoints3D": [],
                "face": face_payload,
                "leftHand": [],
                "rightHand": [],
            }
        except Exception as exc:
            exc_str = str(exc)
            if any(k in exc_str for k in ("rows", "batch size", "batch_size", "divergent", "shape")):
                self.load()
                self._last_shape = (h, w) if 'h' in locals() and 'w' in locals() else None
            else:
                print(f"[XRA_MP_FACE] inference/conversion failed: {type(exc).__name__}: {exc}", flush=True)
            return None
_BLAZEPOSE_NAMES = [
    "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner",
    "right_eye", "right_eye_outer", "left_ear", "right_ear", "mouth_left",
    "mouth_right", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_pinky", "right_pinky", "left_index",
    "right_index", "left_thumb", "right_thumb", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle", "left_heel",
    "right_heel", "left_foot_index", "right_foot_index",
]


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest) if rest else head


def _unwrap_landmarks(value):
    """Return a flat landmark sequence for MediaPipe protobuf or Tasks lists.

    MediaPipe protobuf results may expose NormalizedLandmarkList.landmark. Holistic Tasks
    expose face/pose/hand landmarks directly as List[NormalizedLandmark].
    """
    if value is None:
        return []
    nested = getattr(value, "landmark", None)
    if nested is not None:
        try:
            return list(nested)
        except Exception:
            return []
    if isinstance(value, (list, tuple)):
        return list(value)
    try:
        return list(value)
    except Exception:
        return []


def _landmark_list(landmarks, w, h, normalized=True):
    """Convert MediaPipe Tasks landmarks to pixel (x, y, z, score) tuples."""
    out = []
    for lm in _unwrap_landmarks(landmarks):
        if lm is None:
            continue
        try:
            x = float(getattr(lm, "x", 0.0))
            y = float(getattr(lm, "y", 0.0))
            z = float(getattr(lm, "z", 0.0))
        except Exception:
            continue
        vis = getattr(lm, "visibility", None)
        pres = getattr(lm, "presence", None)
        try:
            score = float(vis if vis is not None else (pres if pres is not None else 1.0))
        except Exception:
            score = 1.0
        if normalized:
            out.append((round(x * w, 2), round(y * h, 2), round(z * w, 2), round(score, 3)))
        else:
            out.append((round(x, 4), round(y, 4), round(z, 4), round(score, 3)))
    return out

def _body_from_pose(pose_landmarks, w, h):
    """Build BlazePose-33 body keypoints from MediaPipe Tasks landmarks."""
    kp = [{"position": {"x": 0.0, "y": 0.0, "z": 0.0}, "score": 0.0, "part": ""}
          for _ in range(33)]
    pts = _landmark_list(pose_landmarks, w, h, normalized=True)
    zs = [0.0] * 33
    for i, name in enumerate(_BLAZEPOSE_NAMES):
        kp[i]["part"] = _camel(name)
        if i < len(pts):
            x, y, z, score = pts[i]
            kp[i]["position"] = {"x": x, "y": y, "z": z}
            kp[i]["score"] = score
            zs[i] = z
    return kp, zs

def _face_from_landmarks(face_landmarks, w, h, normalized=True):
    """Return (face_points_px, blendshapes) for MediaPipe Tasks face landmarks."""
    pts = _landmark_list(face_landmarks, w, h, normalized=normalized)
    if not pts:
        return [], _blendshapes_from_face([])
    norm = [(p[0] / w, p[1] / h) if w and h else (p[0], p[1]) for p in pts]
    return pts, _blendshapes_from_face(norm)

def _hand_from_landmarks(hand_landmarks, w, h):
    return _landmark_list(hand_landmarks, w, h, normalized=True)


def _hand_world_from_landmarks(landmarks) -> list:
    pts = _unwrap_landmarks(landmarks)
    if not pts or len(pts) < 21:
        return []
    out = []
    for lm in pts[:21]:
        try:
            x = round(float(getattr(lm, "x", 0.0)), 4)
            y = round(float(getattr(lm, "y", 0.0)), 4)
            z = round(float(getattr(lm, "z", 0.0)), 4)
        except Exception:
            x = y = z = 0.0
        out.append([x, y, z])
    return out


def _first_landmark_group(value):
    """Accept either a flat Holistic list or a list-of-people Tasks result."""
    groups = _unwrap_landmarks(value)
    if not groups:
        return []
    if hasattr(groups[0], "x"):
        return groups
    return _unwrap_landmarks(groups[0])


def _native_categories(value) -> dict:
    groups = list(value or [])
    if groups and not hasattr(groups[0], "category_name"):
        try:
            groups = list(groups[0])
        except Exception:
            groups = []
    native = {}
    for category in groups:
        name = getattr(category, "category_name", None)
        if name:
            native[str(name)] = float(getattr(category, "score", 0.0))
    return native


def _face_result_to_payload(res, w, h) -> dict:
    face_landmarks = _first_landmark_group(getattr(res, "face_landmarks", None))
    face_pts, blendshapes = _face_from_landmarks(face_landmarks, w, h, normalized=True)
    native = _native_categories(getattr(res, "face_blendshapes", None))
    blendshapes["native"] = native
    return {
        "landmarks": [
            {"x": point[0], "y": point[1], "z": point[2], "score": point[3]}
            for point in face_pts
        ],
        "blendshapes": blendshapes,
        "faceInViewConfidence": 0.95,
        "layout": "mediapipe_face_mesh",
    }

def _tasks_result_to_wholebody(res, w, h) -> dict:
    """Convert HolisticLandmarkerResult.

    HolisticLandmarkerResult is one-person holistic output: pose_landmarks,
    face_landmarks and hand landmarks are flat lists. They are NOT the nested
    list-of-people layout used by PoseLandmarkerResult.
    """
    kp, zs = _body_from_pose(getattr(res, "pose_landmarks", None), w, h)
    face_pts, blendshapes = _face_from_landmarks(
        getattr(res, "face_landmarks", None), w, h, normalized=True)
    left = _hand_from_landmarks(getattr(res, "left_hand_landmarks", None), w, h)
    right = _hand_from_landmarks(getattr(res, "right_hand_landmarks", None), w, h)
    left_world = _hand_world_from_landmarks(getattr(res, "left_hand_world_landmarks", None))
    right_world = _hand_world_from_landmarks(getattr(res, "right_hand_world_landmarks", None))

    native = {}
    try:
        # Holistic Tasks exposes Optional[List[Category]], not List[List[Category]].
        for category in (getattr(res, "face_blendshapes", None) or []):
            name = getattr(category, "category_name", None)
            if not name:
                index = getattr(category, "index", None)
                name = str(index) if index is not None else None
            if name is not None:
                native[str(name)] = round(float(getattr(category, "score", 0.0)), 3)
    except Exception:
        native = {}

    out = _assemble(kp, zs, face_pts, blendshapes, left, right)
    out["leftHandWorld"] = left_world
    out["rightHandWorld"] = right_world
    if isinstance(out.get("face"), dict):
        out["face"]["faceInViewConfidence"] = 0.95
        if native:
            out["face"].setdefault("blendshapes", {})["native"] = native

    # Prefer the true MediaPipe world landmarks when available. Keep exactly 33
    # body-relative values so the downstream bridge never sees malformed data.
    world = _unwrap_landmarks(getattr(res, "pose_world_landmarks", None))
    if len(world) >= 33:
        k3 = []
        for i, lm in enumerate(world[:33]):
            try:
                x = round(float(getattr(lm, "x", 0.0)), 4)
                y = round(float(getattr(lm, "y", 0.0)), 4)
                z = round(float(getattr(lm, "z", 0.0)), 4)
                vis = getattr(lm, "visibility", None)
                pres = getattr(lm, "presence", None)
                score = round(float(vis if vis is not None else (pres if pres is not None else kp[i]["score"])), 3)
            except Exception:
                x = y = z = 0.0
                score = 0.0
            k3.append({"x": x, "y": y, "z": z, "score": score, "name": _BLAZEPOSE_NAMES[i]})
        out["keypoints3D"] = k3
        out["keypoints3d_space"] = "body_relative"
    return out

def _assemble(kp, zs, face_pts, blendshapes, left, right) -> dict:
    body = [{
        "position": {"x": round(float(p["position"]["x"]), 2), "y": round(float(p["position"]["y"]), 2),
                     "z": round(float(p["position"].get("z", zs[i])), 2)},
        "score": round(float(p["score"]), 3),
        "part": p["part"],
    } for i, p in enumerate(kp)]
    keypoints3D = [{
        "x": round(float(p["position"]["x"]), 4), "y": round(float(p["position"]["y"]), 4),
        "z": round(float(p["position"].get("z", zs[i])), 4), "score": round(float(p["score"]), 3),
        "name": _BLAZEPOSE_NAMES[i],
    } for i, p in enumerate(kp)]
    return {
        "score": 1.0,
        "keypoints": body,
        "keypoints3D": keypoints3D,
        "face": {
            "landmarks": [{"x": round(float(p[0]), 2), "y": round(float(p[1]), 2), "z": round(float(p[2]), 2), "score": round(float(p[3]), 3)} for p in face_pts],
            "blendshapes": blendshapes,
        },
        "leftHand": [{"x": round(float(p[0]), 2), "y": round(float(p[1]), 2), "z": round(float(p[2]), 2), "score": round(float(p[3]), 3)} for p in left],
        "rightHand": [{"x": round(float(p[0]), 2), "y": round(float(p[1]), 2), "z": round(float(p[2]), 2), "score": round(float(p[3]), 3)} for p in right],
    }


def _apply_pose_world(out: dict, result, kp: list) -> None:
    """Attach PoseLandmarker's body-relative 3D output to a wire payload."""
    world = _first_landmark_group(getattr(result, "pose_world_landmarks", None))
    if len(world) < 33:
        return
    keypoints3d = []
    for index, lm in enumerate(world[:33]):
        try:
            x = round(float(getattr(lm, "x", 0.0)), 4)
            y = round(float(getattr(lm, "y", 0.0)), 4)
            z = round(float(getattr(lm, "z", 0.0)), 4)
            visibility = getattr(lm, "visibility", None)
            presence = getattr(lm, "presence", None)
            fallback_score = kp[index]["score"]
            score = round(float(
                visibility if visibility is not None
                else (presence if presence is not None else fallback_score)
            ), 3)
        except Exception:
            x = y = z = 0.0
            score = 0.0
        keypoints3d.append({
            "x": x,
            "y": y,
            "z": z,
            "score": score,
            "name": _BLAZEPOSE_NAMES[index],
        })
    out["keypoints3D"] = keypoints3d
    out["keypoints3d_space"] = "body_relative"


def _split_hand_payload(result, w: int, h: int) -> tuple[list, list, list, list]:
    """Map HandLandmarker groups onto the same left/right keys as Holistic.

    MediaPipe Tasks 0.10.5+ reports the mirrored handedness convention used by
    the existing browser adapter. A raw ``Left`` category therefore belongs in
    ``leftHand``; the adapter intentionally exposes that group as subject Right.
    """
    groups = list(getattr(result, "hand_landmarks", None) or [])
    world_groups = list(getattr(result, "hand_world_landmarks", None) or [])
    handedness = list(getattr(result, "handedness", None) or [])
    slots = {
        "left": {"points": [], "world": [], "score": -1.0},
        "right": {"points": [], "world": [], "score": -1.0},
    }

    for index, group in enumerate(groups[:2]):
        categories = list(handedness[index] or []) if index < len(handedness) else []
        category = categories[0] if categories else None
        label = str(getattr(category, "category_name", "") or "").strip().lower()
        score = float(getattr(category, "score", 0.0) or 0.0)
        if label not in slots:
            # Stable geometric fallback for runtimes that omit handedness.
            points_raw = _unwrap_landmarks(group)
            wrist_x = float(getattr(points_raw[0], "x", 0.5)) if points_raw else 0.5
            label = "left" if wrist_x < 0.5 else "right"
        points = _hand_from_landmarks(group, w, h)
        world = _hand_world_from_landmarks(
            world_groups[index] if index < len(world_groups) else None
        )
        if points and score >= slots[label]["score"]:
            slots[label] = {"points": points, "world": world, "score": score}

    return (
        slots["left"]["points"],
        slots["right"]["points"],
        slots["left"]["world"],
        slots["right"]["world"],
    )


def _hand_recovery_candidates(result, w: int, h: int) -> list[dict]:
    """Return independent hands for temporal matching by the capture layer.

    Recovery deliberately does not trust handedness as identity.  During a
    crossing or palm rotation MediaPipe can flip Left/Right for a frame; the
    caller instead matches each candidate to the last confirmed wrist.
    """
    groups = list(getattr(result, "hand_landmarks", None) or [])
    world_groups = list(getattr(result, "hand_world_landmarks", None) or [])
    handedness = list(getattr(result, "handedness", None) or [])
    candidates = []
    for index, group in enumerate(groups[:2]):
        points = _hand_from_landmarks(group, w, h)
        if len(points) < 21:
            continue
        categories = list(handedness[index] or []) if index < len(handedness) else []
        category = categories[0] if categories else None
        candidates.append({
            "hand": points,
            "world": _hand_world_from_landmarks(
                world_groups[index] if index < len(world_groups) else None
            ),
            "label": str(getattr(category, "category_name", "") or "").strip().lower(),
            "score": float(getattr(category, "score", 0.0) or 0.0),
        })
    return candidates


class HandRecoveryTasksEngine:
    """Optional CPU full-frame hand search used only after a Holistic dropout."""

    name = "hand-recovery-cpu"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._landmarker = None
        self._mp = None
        self._min_tracking_confidence = 0.50
        self.last_inference_ms = 0.0
        self.last_error = ""

    @property
    def ready(self) -> bool:
        return self._landmarker is not None

    def configure_confidence(self, min_tracking=None, **_) -> dict:
        if min_tracking is None:
            return {"ok": True, "changed": False}
        value = max(0.1, min(0.95, float(min_tracking)))
        changed = abs(value - self._min_tracking_confidence) > 1e-4
        self._min_tracking_confidence = value
        if changed and self.ready:
            return self.load()
        return {"ok": True, "changed": changed}

    def load(self, **_) -> dict:
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision
        except Exception as exc:
            self.last_error = f"mediapipe hand tasks unavailable: {exc}"
            return {"ok": False, "error": self.last_error}

        model_path = (
            registry.model_dir(registry.MEDIAPIPE_TASKS_ID) / "hand_landmarker.task"
        )
        if not model_path.is_file():
            self.last_error = "hand_landmarker.task not installed"
            return {"ok": False, "error": self.last_error, "needs_download": True}

        self.unload()
        try:
            tracking = self._min_tracking_confidence
            options = vision.HandLandmarkerOptions(
                # Recovery is intentionally CPU-only.  It remains independent
                # from the continuously running split-GPU hand worker.
                base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
                running_mode=vision.RunningMode.IMAGE,
                num_hands=2,
                min_hand_detection_confidence=max(0.40, tracking * 0.75),
                min_hand_presence_confidence=max(0.40, tracking * 0.75),
                min_tracking_confidence=max(0.35, tracking * 0.65),
            )
            self._mp = mp
            with suppress_c_stderr():
                self._landmarker = vision.HandLandmarker.create_from_options(options)
            self.last_error = ""
            return {"ok": True, "engine": self.name}
        except Exception as exc:
            self._landmarker = None
            self._mp = None
            self.last_error = f"hand recovery init failed: {exc}"
            return {"ok": False, "error": self.last_error}

    def unload(self) -> None:
        if self._landmarker is not None:
            try:
                self._landmarker.close()
            except Exception:
                pass
        self._landmarker = None
        self._mp = None
        self.last_inference_ms = 0.0

    def infer(self, frame_bgr: np.ndarray) -> Optional[dict]:
        if self._landmarker is None or self._mp is None:
            return None
        try:
            h, w, channels = frame_bgr.shape
            if h <= 0 or w <= 0 or channels != 3:
                return None
            rgb = _bgr_to_rgb(frame_bgr)
            image = self._mp.Image(
                image_format=self._mp.ImageFormat.SRGB,
                data=rgb,
            )
            started = time.perf_counter()
            with self._lock:
                with suppress_c_stderr():
                    result = self._landmarker.detect(image)
            self.last_inference_ms = (time.perf_counter() - started) * 1000.0
            self.last_error = ""
            return {
                "candidates": _hand_recovery_candidates(result, w, h),
                "inference_ms": self.last_inference_ms,
            }
        except Exception as exc:
            self.last_error = f"hand recovery inference failed: {exc}"
            return None


def _split_results_to_wholebody(results: dict, w: int, h: int) -> dict:
    pose_result = results["pose"]
    face_result = results["face"]
    hand_result = results["hand"]

    pose_landmarks = _first_landmark_group(
        getattr(pose_result, "pose_landmarks", None)
    )
    kp, zs = _body_from_pose(pose_landmarks, w, h)
    face_landmarks = _first_landmark_group(
        getattr(face_result, "face_landmarks", None)
    )
    face_points, blendshapes = _face_from_landmarks(
        face_landmarks, w, h, normalized=True
    )
    blendshapes["native"] = _native_categories(
        getattr(face_result, "face_blendshapes", None)
    )
    left, right, left_world, right_world = _split_hand_payload(hand_result, w, h)

    out = _assemble(kp, zs, face_points, blendshapes, left, right)
    _apply_pose_world(out, pose_result, kp)
    out["leftHandWorld"] = left_world
    out["rightHandWorld"] = right_world
    out["face"]["faceInViewConfidence"] = 0.95 if face_points else 0.0
    out["face"]["layout"] = "mediapipe_face_mesh"
    return out


class _ParallelTaskWorker:
    """Own one GPU Task graph for its complete lifetime on one thread."""

    def __init__(self, kind: str, model_path, result_queue, confidence: dict) -> None:
        self.kind = kind
        self.model_path = str(model_path)
        self.result_queue = result_queue
        self.confidence = confidence
        self.requests = queue.Queue(maxsize=1)
        self.ready_result = queue.Queue(maxsize=1)
        self.thread = threading.Thread(
            target=self._run,
            name=f"xra-mediapipe-{kind}-gpu",
            daemon=True,
        )

    def start(self, timeout: float = 20.0) -> dict:
        self.thread.start()
        try:
            return self.ready_result.get(timeout=timeout)
        except queue.Empty:
            return {"ok": False, "error": f"{self.kind} GPU init timed out"}

    def submit(self, token: int, rgb: np.ndarray, timestamp_ms: int) -> bool:
        try:
            self.requests.put((token, rgb, timestamp_ms), timeout=0.25)
            return True
        except queue.Full:
            return False

    def stop(self) -> None:
        try:
            self.requests.put(None, timeout=0.25)
        except queue.Full:
            try:
                self.requests.get_nowait()
            except queue.Empty:
                pass
            try:
                self.requests.put_nowait(None)
            except queue.Full:
                pass
        if self.thread.is_alive() and self.thread is not threading.current_thread():
            self.thread.join(timeout=5.0)

    def _options(self, mp_python, vision):
        base = mp_python.BaseOptions(
            model_asset_path=self.model_path,
            delegate=mp_python.BaseOptions.Delegate.GPU,
        )
        tracking = self.confidence["tracking"]
        if self.kind == "face":
            face = self.confidence["face"]
            return vision.FaceLandmarker, vision.FaceLandmarkerOptions(
                base_options=base,
                running_mode=vision.RunningMode.VIDEO,
                num_faces=1,
                min_face_detection_confidence=face,
                min_face_presence_confidence=face,
                min_tracking_confidence=tracking,
                output_face_blendshapes=True,
                output_facial_transformation_matrixes=False,
            )
        if self.kind == "pose":
            pose = self.confidence["pose"]
            return vision.PoseLandmarker, vision.PoseLandmarkerOptions(
                base_options=base,
                running_mode=vision.RunningMode.VIDEO,
                num_poses=1,
                min_pose_detection_confidence=pose,
                min_pose_presence_confidence=pose,
                min_tracking_confidence=tracking,
                output_segmentation_masks=False,
            )
        # Keep detection/presence high enough to suppress phantom hands on GPU;
        # tracking is kept slightly looser so a confirmed hand stays tracked.
        hand_detect = max(0.40, tracking * 0.75)
        hand_track = max(0.35, tracking * 0.65)
        # Use IMAGE mode (not VIDEO) for the hand worker: VIDEO mode carries a
        # NORM_RECT ROI between frames via landmark_projection_calculator, which
        # emits a W0 warning when IMAGE_DIMENSIONS is absent and can produce
        # stale-ROI phantom detections when the hand moves quickly.  IMAGE mode
        # runs a full detection on every frame — no ROI drift, no warning.
        return vision.HandLandmarker, vision.HandLandmarkerOptions(
            base_options=base,
            running_mode=vision.RunningMode.IMAGE,
            num_hands=2,
            min_hand_detection_confidence=hand_detect,
            min_hand_presence_confidence=hand_detect,
            min_tracking_confidence=hand_track,
        )

    def _run(self) -> None:
        landmarker = None
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision

            landmarker_class, options = self._options(mp_python, vision)
            # Workers are started one at a time, so process-wide stderr
            # redirection cannot race another graph initialization.
            with suppress_c_stderr():
                landmarker = landmarker_class.create_from_options(options)
            self.ready_result.put({"ok": True})
        except Exception as exc:
            self.ready_result.put({
                "ok": False,
                "error": f"{self.kind} GPU init failed: {exc}",
            })
            return

        try:
            while True:
                request = self.requests.get()
                if request is None:
                    break
                token, rgb, timestamp_ms = request
                started = time.perf_counter()
                try:
                    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                    # Hand worker uses IMAGE mode (full detection each frame, no ROI drift).
                    # Face/pose workers use VIDEO mode (timestamp-based ROI tracking).
                    if self.kind == "hand":
                        result = landmarker.detect(image)
                    else:
                        result = landmarker.detect_for_video(image, timestamp_ms)
                    self.result_queue.put((
                        token,
                        self.kind,
                        result,
                        None,
                        (time.perf_counter() - started) * 1000.0,
                    ))
                except Exception as exc:
                    self.result_queue.put((
                        token,
                        self.kind,
                        None,
                        exc,
                        (time.perf_counter() - started) * 1000.0,
                    ))
        finally:
            if landmarker is not None:
                try:
                    landmarker.close()
                except Exception:
                    pass


class SplitTasksEngine:
    """Parallel native Face + Pose + Hand Tasks GPU full-body engine."""

    name = "split-tasks-gpu"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._workers: dict[str, _ParallelTaskWorker] = {}
        self._results = queue.Queue()
        self._token = 0
        self._last_timestamp_ms = -1
        self._last_shape: Optional[tuple[int, int]] = None
        self._min_tracking_confidence = 0.50
        self._min_pose_confidence = 0.50
        self._min_face_confidence = 0.50
        self._last_task_ms: dict[str, float] = {}
        self._last_error_log = 0.0
        self._accelerated = False

    @property
    def ready(self) -> bool:
        return (
            len(self._workers) == 3
            and all(worker.thread.is_alive() for worker in self._workers.values())
        )

    @property
    def task_timings_ms(self) -> dict[str, float]:
        return dict(self._last_task_ms)

    def configure_confidence(self, min_tracking=None, min_pose=None, min_face=None) -> dict:
        changed = False
        for attr, value in (
            ("_min_tracking_confidence", min_tracking),
            ("_min_pose_confidence", min_pose),
            ("_min_face_confidence", min_face),
        ):
            if value is None:
                continue
            normalized = max(0.1, min(0.95, float(value)))
            if abs(normalized - getattr(self, attr)) > 1e-4:
                setattr(self, attr, normalized)
                changed = True
        if changed and self.ready:
            return self.load(accelerated=True)
        return {"ok": True, "changed": changed}

    def load(self, accelerated: Optional[bool] = None, **_) -> dict:
        if accelerated is False:
            return {"ok": False, "error": "split Tasks requires a GPU delegate"}
        try:
            import mediapipe  # noqa: F401 - validate runtime before threads start
            from mediapipe.tasks.python import vision
        except Exception as exc:
            return {"ok": False, "error": f"mediapipe split tasks unavailable: {exc}"}
        for required in (
            "FaceLandmarker", "PoseLandmarker", "HandLandmarker",
            "FaceLandmarkerOptions", "PoseLandmarkerOptions", "HandLandmarkerOptions",
        ):
            if not hasattr(vision, required):
                return {"ok": False, "error": f"MediaPipe Tasks is missing {required}"}

        model_dir = registry.model_dir(registry.MEDIAPIPE_TASKS_ID)
        # Prefer the full pose model (better accuracy); fall back to lite if
        # full hasn't been downloaded yet (e.g. first run before upgrade).
        pose_full = model_dir / "pose_landmarker_full.task"
        pose_lite = model_dir / "pose_landmarker_lite.task"
        pose_model = pose_full if pose_full.is_file() else pose_lite
        model_paths = {
            "face": model_dir / "face_landmarker.task",
            "pose": pose_model,
            "hand": model_dir / "hand_landmarker.task",
        }
        print(f"[XRA_MP_SPLIT] Pose model: {pose_model.name}", flush=True)
        missing = [path.name for path in model_paths.values() if not path.is_file()]
        if missing:
            return {
                "ok": False,
                "error": "split Tasks models not installed: " + ", ".join(missing),
                "needs_download": True,
            }
        if not _check_gpu():
            return {"ok": False, "error": "GPU delegate is unavailable"}

        self.unload()
        self._results = queue.Queue()
        confidence = {
            "tracking": self._min_tracking_confidence,
            "pose": self._min_pose_confidence,
            "face": self._min_face_confidence,
        }
        try:
            # Sequential creation keeps stderr suppression safe while every
            # graph still remains bound to its own persistent worker thread.
            for kind in ("face", "pose", "hand"):
                worker = _ParallelTaskWorker(
                    kind, model_paths[kind], self._results, confidence
                )
                self._workers[kind] = worker
                status = worker.start()
                if not status.get("ok"):
                    raise RuntimeError(status.get("error") or f"{kind} init failed")
            self._accelerated = True
            self._last_timestamp_ms = -1
            self._last_shape = None
            return {"ok": True, "engine": self.name}
        except Exception as exc:
            self.unload()
            return {"ok": False, "error": f"split Tasks init failed: {exc}"}

    def unload(self) -> None:
        workers = list(self._workers.values())
        self._workers = {}
        for worker in workers:
            worker.stop()
        self._results = queue.Queue()
        self._last_timestamp_ms = -1
        self._last_shape = None
        self._last_task_ms = {}
        self._accelerated = False

    def _log_inference_error(self, message: str) -> None:
        now = time.monotonic()
        if now - self._last_error_log >= 2.0:
            print(f"[XRA_MP_SPLIT] {message}", flush=True)
            self._last_error_log = now

    def infer(self, frame_bgr: np.ndarray) -> Optional[dict]:
        if not self.ready:
            return None
        try:
            h, w, channels = frame_bgr.shape
            if h <= 0 or w <= 0 or channels != 3:
                return None
            rgb = _bgr_to_rgb(frame_bgr)
            with self._lock:
                self._token += 1
                token = self._token
                timestamp_ms = max(
                    time.monotonic_ns() // 1_000_000,
                    self._last_timestamp_ms + 1,
                )
                self._last_timestamp_ms = timestamp_ms
                self._last_shape = (h, w)

                for kind, worker in self._workers.items():
                    # Each graph may write to its input tensor; distinct arrays
                    # avoid cross-context tensor synchronization hazards.
                    if not worker.submit(token, rgb.copy(), timestamp_ms):
                        self._log_inference_error(f"{kind} worker queue is busy")
                        return None

                gathered = {}
                timings = {}
                deadline = time.monotonic() + 2.0
                while len(gathered) < 3:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        self._log_inference_error("parallel inference timed out")
                        return None
                    try:
                        result_token, kind, result, error, elapsed_ms = self._results.get(
                            timeout=remaining
                        )
                    except queue.Empty:
                        self._log_inference_error("parallel inference timed out")
                        return None
                    if result_token != token:
                        continue
                    if error is not None:
                        self._log_inference_error(
                            f"{kind} inference failed: {type(error).__name__}: {error}"
                        )
                        return None
                    gathered[kind] = result
                    timings[kind] = round(float(elapsed_ms), 3)

                self._last_task_ms = timings
            return _split_results_to_wholebody(gathered, w, h)
        except Exception as exc:
            self._log_inference_error(
                f"conversion failed: {type(exc).__name__}: {exc}"
            )
            return None
