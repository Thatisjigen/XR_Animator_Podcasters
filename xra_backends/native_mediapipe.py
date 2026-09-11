# XRA_TRACKING_HOTFIX_V9_3
# XRA_UNIVERSAL_RUNTIME_V9
# XRA_RUNTIME_BUILD_V8
# XRA_PERFORMANCE_RUNTIME_V7
"""Native Python MediaPipe Tasks backend.

``HolisticTasksEngine`` wraps ``mediapipe.tasks.vision.HolisticLandmarker`` and
emits the whole-body payload contract used by the browser adapter: 33 pose
landmarks, 21+21 hand landmarks, face landmarks and native face blendshapes.
The engine is lazy-loaded; missing packages/models leave it unavailable without
terminating the XR server process.

Face landmarks are converted to the pixel/full-frame convention expected by the
existing JS consumer while native Tasks blendshapes are preserved under
``face.blendshapes.native``.
"""

from __future__ import annotations

import contextlib
import os
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
        _GPU_AVAILABLE = False
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
                "min_hand_landmarks_confidence": self._min_tracking_confidence,
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
