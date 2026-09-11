# XRA_TRACKING_HOTFIX_V9_3
# XRA_UNIVERSAL_RUNTIME_V9
# XRA_RUNTIME_BUILD_V8
# XRA_PERFORMANCE_RUNTIME_V7
"""Native Python MediaPipe backends (the C++ ``mediapipe`` package).

Two engines are provided, both emitting the *same* wholebody payload as the
ONNX DWPose engine:

  * ``HolisticLegacyEngine`` – ``mediapipe.solutions.holistic.Holistic``.
    Supports ``model_complexity`` 0 (Lite, potato-friendly) vs 1 (Full).
    Emits 33 body pose, 468 face-mesh landmarks and 21+21 hand landmarks.

  * ``HolisticTasksEngine`` – ``mediapipe.tasks.vision.HolisticLandmarker``.
    Loads the official ``holistic_landmarker.task`` bundle and enables
    ``output_face_blendshapes=True`` so we get the native 52 ARKit blendshapes
    alongside body + hand landmarks.

Both engines are loaded lazily and never raise into the caller: a missing
package / model leaves the engine ``ready == False`` and ``infer()`` returns
``None`` so the server keeps serving and the UI just reports "unavailable".

Face-mesh + blendshape derivation
---------------------------------
MediaPipe's legacy ``solutions`` API returns face landmarks in *pixel* space
(w, h) while the Tasks API returns *normalized* [0,1] landmarks. We normalize
both to the pixel/full-frame convention the JS facemesh consumer expects and
compute a small, vendor-neutral blendshape set:
  ``eyeBlinkLeft`` / ``eyeBlinkRight`` (via Eye Aspect Ratio),
  ``jawOpen`` (mouth vertical aperture),
  ``mouthSmile`` / ``mouthFrown`` (corner lift),
plus, for the Tasks engine, the native 52 ARKit blendshapes are forwarded
verbatim as ``nativeBlendshapes``.
"""

from __future__ import annotations

import sys
import multiprocessing
import threading
from typing import Optional

import numpy as np

from . import registry

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


# ---------------------------------------------------------------------------
# Legacy solutions.holistic
# ---------------------------------------------------------------------------

def _legacy_worker_main(conn, model_complexity: int, mode: str = "holistic-tracking") -> None:
    """Legacy MediaPipe worker isolated from the XR server process.

    Modes:
      holistic-tracking -> stock Holistic tracking graph
      holistic-static   -> stock Holistic static-image graph
      split             -> Pose + Hands + FaceMesh legacy solutions separately

    The split mode is a compatibility fallback for native Holistic CHECK/abort
    failures. It keeps the same wholebody payload contract.
    """
    models = []
    try:
        import mediapipe as mp
        solutions = getattr(mp, "solutions", None)
        if solutions is None:
            conn.send(("error", "mediapipe.solutions unavailable"))
            return

        holistic = None
        pose = hands = face = None
        if mode in {"holistic-tracking", "holistic-static"}:
            holistic_cls = getattr(getattr(solutions, "holistic", None), "Holistic", None)
            if holistic_cls is None:
                conn.send(("error", "mediapipe.solutions.holistic.Holistic unavailable"))
                return
            holistic = holistic_cls(
                static_image_mode=(mode == "holistic-static"),
                model_complexity=int(model_complexity),
                enable_segmentation=False,
                refine_face_landmarks=True,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            models.append(holistic)
        elif mode == "split":
            pose_cls = getattr(getattr(solutions, "pose", None), "Pose", None)
            hands_cls = getattr(getattr(solutions, "hands", None), "Hands", None)
            face_cls = getattr(getattr(solutions, "face_mesh", None), "FaceMesh", None)
            if not (pose_cls and hands_cls and face_cls):
                conn.send(("error", "MediaPipe legacy split solutions unavailable"))
                return
            pose = pose_cls(
                static_image_mode=False,
                model_complexity=int(model_complexity),
                enable_segmentation=False,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            hands = hands_cls(
                static_image_mode=False,
                max_num_hands=2,
                model_complexity=1,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            face = face_cls(
                static_image_mode=False,
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            models.extend((pose, hands, face))
        else:
            conn.send(("error", f"unknown legacy worker mode: {mode}"))
            return

        conn.send(("ready", {"model_complexity": int(model_complexity), "mode": mode}))

        while True:
            try:
                command, payload = conn.recv()
            except EOFError:
                break
            if command == "close":
                break
            if command != "infer":
                continue

            frame = np.asarray(payload)
            if frame.ndim != 3 or frame.shape[2] != 3 or frame.size == 0:
                conn.send(("result", None))
                continue
            if frame.dtype != np.uint8:
                frame = np.clip(frame, 0, 255).astype(np.uint8)
            frame = np.ascontiguousarray(frame)
            h, w = frame.shape[:2]
            rgb = np.ascontiguousarray(frame[..., ::-1])
            rgb.flags.writeable = False

            if holistic is not None:
                result = holistic.process(rgb)
            else:
                pose_result = pose.process(rgb)
                hands_result = hands.process(rgb)
                face_result = face.process(rgb)

                class CombinedResult:
                    pass

                result = CombinedResult()
                result.pose_landmarks = getattr(pose_result, "pose_landmarks", None)
                result.pose_world_landmarks = getattr(pose_result, "pose_world_landmarks", None)
                faces = getattr(face_result, "multi_face_landmarks", None) or []
                result.face_landmarks = faces[0] if faces else None
                result.left_hand_landmarks = None
                result.right_hand_landmarks = None

                hand_landmarks = getattr(hands_result, "multi_hand_landmarks", None) or []
                handedness = getattr(hands_result, "multi_handedness", None) or []
                for idx, lms in enumerate(hand_landmarks):
                    label = ""
                    try:
                        label = str(handedness[idx].classification[0].label).lower()
                    except Exception:
                        pass
                    if label == "left":
                        result.left_hand_landmarks = lms
                    elif label == "right":
                        result.right_hand_landmarks = lms
                    elif result.left_hand_landmarks is None:
                        result.left_hand_landmarks = lms
                    else:
                        result.right_hand_landmarks = lms

            conn.send(("result", _holistic_result_to_wholebody(result, w, h)))
    except BaseException as exc:
        try:
            conn.send(("error", f"{type(exc).__name__}: {exc}"))
        except Exception:
            pass
    finally:
        for model in reversed(models):
            try:
                model.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass

class HolisticLegacyEngine:
    """Legacy MediaPipe backend with crash isolation and compatibility fallback."""
    name = "holistic-legacy"
    _MODES = ("holistic-tracking", "holistic-static", "split")

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._process = None
        self._conn = None
        self._complexity = 1
        self._last_error = ""
        self._mode_index = 0

    @property
    def ready(self) -> bool:
        return bool(self._process is not None and self._process.is_alive() and self._conn is not None)

    @property
    def last_error(self) -> str:
        if self._process is not None and not self._process.is_alive() and not self._last_error:
            return f"MediaPipe Legacy worker exited with code {self._process.exitcode}"
        return self._last_error

    @property
    def runtime_mode(self) -> str:
        return self._MODES[min(self._mode_index, len(self._MODES) - 1)]

    def _stop_worker_locked(self) -> None:
        conn, proc = self._conn, self._process
        self._conn = None
        self._process = None
        if conn is not None:
            try:
                conn.send(("close", None))
            except Exception:
                pass
        if proc is not None:
            proc.join(timeout=0.8)
            if proc.is_alive():
                proc.terminate()
                proc.join(timeout=1.0)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def _start_worker_locked(self, mode_index: int) -> tuple[bool, str]:
        self._stop_worker_locked()
        mode_index = max(0, min(int(mode_index), len(self._MODES) - 1))
        mode = self._MODES[mode_index]
        ctx = multiprocessing.get_context("spawn")
        parent, child = ctx.Pipe(duplex=True)
        proc = ctx.Process(
            target=_legacy_worker_main,
            args=(child, self._complexity, mode),
            name=f"xra-mediapipe-legacy-{mode}",
            daemon=True,
        )
        proc.start()
        child.close()
        print(
            f"[XRA_MP_LEGACY] started child pid={proc.pid} mode={mode}",
            flush=True,
        )
        if not parent.poll(20.0):
            proc.terminate()
            proc.join(timeout=2.0)
            parent.close()
            return False, f"MediaPipe Legacy {mode} init timed out"
        try:
            kind, payload = parent.recv()
        except EOFError:
            proc.join(timeout=1.0)
            parent.close()
            return False, f"MediaPipe Legacy {mode} exited during init (exit={proc.exitcode})"
        if kind != "ready":
            proc.join(timeout=1.0)
            parent.close()
            return False, str(payload or f"MediaPipe Legacy {mode} init failed")
        self._process = proc
        self._conn = parent
        self._mode_index = mode_index
        return True, ""

    def load(self, model_complexity: int = 1) -> dict:
        try:
            import mediapipe as mp
        except Exception as exc:
            return {"ok": False, "error": f"mediapipe package unavailable: {exc}", "needs_package": True}
        if getattr(mp, "solutions", None) is None:
            return {"ok": False, "error": "mediapipe.solutions unavailable", "needs_python311": True}
        with self._lock:
            self._complexity = int(model_complexity)
            self._last_error = ""
            self._mode_index = 0
            for mode_index in range(len(self._MODES)):
                ok, error = self._start_worker_locked(mode_index)
                if ok:
                    return {
                        "ok": True,
                        "engine": self.name,
                        "model_complexity": self._complexity,
                        "runtime_mode": self.runtime_mode,
                    }
                self._last_error = error
            return {"ok": False, "error": self._last_error or "MediaPipe Legacy failed to initialize"}

    def unload(self) -> None:
        with self._lock:
            self._stop_worker_locked()
            self._mode_index = 0

    def _infer_locked(self, frame: np.ndarray) -> tuple[str, Optional[dict]]:
        proc, conn = self._process, self._conn
        if proc is None or conn is None or not proc.is_alive():
            code = proc.exitcode if proc is not None else None
            return "crashed", {"error": f"MediaPipe Legacy worker unavailable (exit={code})"}
        try:
            conn.send(("infer", frame))
            if not conn.poll(2.5):
                if not proc.is_alive():
                    return "crashed", {"error": f"MediaPipe Legacy worker aborted (exit={proc.exitcode})"}
                return "timeout", {"error": "MediaPipe Legacy inference timed out"}
            kind, payload = conn.recv()
            if kind == "result":
                return "result", payload
            return "error", {"error": str(payload or "MediaPipe Legacy inference failed")}
        except (EOFError, BrokenPipeError, OSError) as exc:
            return "crashed", {"error": (
                f"MediaPipe Legacy worker crashed (exit={proc.exitcode}): "
                f"{type(exc).__name__}: {exc}"
            )}
        except Exception as exc:
            return "error", {"error": f"MediaPipe Legacy IPC failed: {type(exc).__name__}: {exc}"}

    def infer(self, frame_bgr: np.ndarray) -> Optional[dict]:
        with self._lock:
            frame = np.asarray(frame_bgr)
            if frame.ndim != 3 or frame.shape[2] != 3 or frame.size == 0:
                self._last_error = "invalid camera frame for MediaPipe Legacy"
                return None
            if frame.dtype != np.uint8:
                frame = np.clip(frame, 0, 255).astype(np.uint8)
            frame = np.ascontiguousarray(frame)

            while True:
                state, payload = self._infer_locked(frame)
                if state == "result":
                    self._last_error = ""
                    return payload

                reason = str((payload or {}).get("error") or state)
                next_index = self._mode_index + 1
                if state in {"crashed", "timeout", "error"} and next_index < len(self._MODES):
                    print(
                        f"[XRA_MP_LEGACY] {self.runtime_mode} failed ({reason}); "
                        f"falling back to {self._MODES[next_index]}",
                        flush=True,
                    )
                    ok, start_error = self._start_worker_locked(next_index)
                    if ok:
                        continue
                    reason = start_error

                self._last_error = reason
                return None

class HolisticTasksEngine:
    """``mediapipe.tasks.vision.HolisticLandmarker`` wrapper."""

    name = "holistic-tasks"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._landmarker = None
        self._mp = None

    @property
    def ready(self) -> bool:
        return self._landmarker is not None

    def load(self, **_) -> dict:
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
        self.unload()
        model_path = registry.model_dir(registry.MEDIAPIPE_TASKS_ID) / "holistic_landmarker.task"
        try:
            base = mp_python.BaseOptions(model_asset_path=str(model_path))
            option_kwargs = {
                "base_options": base,
                "running_mode": vision.RunningMode.IMAGE,
                "output_face_blendshapes": True,
            }
            # This option belongs to FaceLandmarker, not HolisticLandmarker in
            # mediapipe 0.10.21. Add it only if a future API explicitly exposes it.
            option_fields = getattr(
                vision.HolisticLandmarkerOptions, "__dataclass_fields__", {}
            )
            if "output_facial_transformation_matrixes" in option_fields:
                option_kwargs["output_facial_transformation_matrixes"] = False
            opts = vision.HolisticLandmarkerOptions(**option_kwargs)
            self._mp = mp
            self._landmarker = vision.HolisticLandmarker.create_from_options(opts)
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

    def infer(self, frame_bgr: np.ndarray) -> Optional[dict]:
        if self._landmarker is None or self._mp is None:
            return None
        try:
            h, w = frame_bgr.shape[:2]
            if h <= 0 or w <= 0:
                return None
            rgb = np.ascontiguousarray(frame_bgr[..., ::-1])
            if rgb.dtype != np.uint8:
                rgb = np.clip(rgb, 0, 255).astype(np.uint8)
            mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
            with self._lock:
                res = self._landmarker.detect(mp_image)
            out = _tasks_result_to_wholebody(res, w, h)
            if not isinstance(out.get("keypoints"), list) or len(out["keypoints"]) != 33:
                return None
            out.setdefault("leftHand", [])
            out.setdefault("rightHand", [])
            if not isinstance(out.get("face"), dict):
                out["face"] = {"landmarks": [], "blendshapes": {}}
            out["face"].setdefault("landmarks", [])
            out["face"].setdefault("blendshapes", {})
            return out
        except Exception as exc:
            print(f"[XRA_MP_TASKS] inference/conversion failed: {type(exc).__name__}: {exc}", flush=True)
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
    """Return a flat landmark sequence for Legacy protobuf or Tasks lists.

    Legacy Solutions expose NormalizedLandmarkList.landmark. Holistic Tasks
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
    """Convert Legacy/Tasks landmarks to pixel (x, y, z, score) tuples."""
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
            out.append((x * w, y * h, z * w, score))
        else:
            out.append((x, y, z, score))
    return out

def _body_from_pose(pose_landmarks, w, h):
    """Build BlazePose-33 body keypoints from Legacy or Tasks landmarks."""
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
    """Return (face_points_px, blendshapes) for Legacy or Tasks face landmarks."""
    pts = _landmark_list(face_landmarks, w, h, normalized=normalized)
    if not pts:
        return [], _blendshapes_from_face([])
    norm = [(p[0] / w, p[1] / h) if w and h else (p[0], p[1]) for p in pts]
    return pts, _blendshapes_from_face(norm)

def _hand_from_landmarks(hand_landmarks, w, h):
    return _landmark_list(hand_landmarks, w, h, normalized=True)

def _holistic_result_to_wholebody(res, w, h) -> dict:
    kp, zs = _body_from_pose(getattr(res, "pose_landmarks", None), w, h)
    face_pts, blendshapes = _face_from_landmarks(
        getattr(res, "face_landmarks", None), w, h, normalized=True)
    left = _hand_from_landmarks(getattr(res, "left_hand_landmarks", None), w, h)
    right = _hand_from_landmarks(getattr(res, "right_hand_landmarks", None), w, h)
    out = _assemble(kp, zs, face_pts, blendshapes, left, right)

    world = _unwrap_landmarks(getattr(res, "pose_world_landmarks", None))
    if len(world) >= 33:
        k3 = []
        for i, lm in enumerate(world[:33]):
            try:
                score = kp[i]["score"]
                k3.append({
                    "x": float(getattr(lm, "x", 0.0)),
                    "y": float(getattr(lm, "y", 0.0)),
                    "z": float(getattr(lm, "z", 0.0)),
                    "score": float(score),
                    "name": _BLAZEPOSE_NAMES[i],
                })
            except Exception:
                k3.append({"x": 0.0, "y": 0.0, "z": 0.0, "score": 0.0, "name": _BLAZEPOSE_NAMES[i]})
        out["keypoints3D"] = k3
        out["keypoints3d_space"] = "body_relative"
    return out

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
                native[str(name)] = float(getattr(category, "score", 0.0))
    except Exception:
        native = {}

    out = _assemble(kp, zs, face_pts, blendshapes, left, right)
    if native and isinstance(out.get("face"), dict):
        out["face"].setdefault("blendshapes", {})["native"] = native

    # Prefer the true MediaPipe world landmarks when available. Keep exactly 33
    # body-relative values so the downstream bridge never sees malformed data.
    world = _unwrap_landmarks(getattr(res, "pose_world_landmarks", None))
    if len(world) >= 33:
        k3 = []
        for i, lm in enumerate(world[:33]):
            try:
                x = float(getattr(lm, "x", 0.0))
                y = float(getattr(lm, "y", 0.0))
                z = float(getattr(lm, "z", 0.0))
                vis = getattr(lm, "visibility", None)
                pres = getattr(lm, "presence", None)
                score = float(vis if vis is not None else (pres if pres is not None else kp[i]["score"]))
            except Exception:
                x = y = z = 0.0
                score = 0.0
            k3.append({"x": x, "y": y, "z": z, "score": score, "name": _BLAZEPOSE_NAMES[i]})
        out["keypoints3D"] = k3
        out["keypoints3d_space"] = "body_relative"
    return out

def _assemble(kp, zs, face_pts, blendshapes, left, right) -> dict:
    body = [{
        "position": {"x": p["position"]["x"], "y": p["position"]["y"],
                     "z": p["position"].get("z", zs[i])},
        "score": p["score"],
        "part": p["part"],
    } for i, p in enumerate(kp)]
    keypoints3D = [{
        "x": p["position"]["x"], "y": p["position"]["y"],
        "z": p["position"].get("z", zs[i]), "score": p["score"],
        "name": _BLAZEPOSE_NAMES[i],
    } for i, p in enumerate(kp)]
    return {
        "score": 1.0,
        "keypoints": body,
        "keypoints3D": keypoints3D,
        "face": {
            "landmarks": [{"x": p[0], "y": p[1], "z": p[2], "score": p[3]} for p in face_pts],
            "blendshapes": blendshapes,
        },
        "leftHand": [{"x": p[0], "y": p[1], "z": p[2], "score": p[3]} for p in left],
        "rightHand": [{"x": p[0], "y": p[1], "z": p[2], "score": p[3]} for p in right],
    }
