"""Catalogue of mocap backends + their on-disk layout.

Three families are supported, all emitted through the *same* wholebody contract
(see ``engine.py`` / ``native_mediapipe.py``):

  * ONNX wholebody pose  -> DWPose-s/m/l (COCO-WholeBody-133, SimCC head)
  * Native MediaPipe     -> Legacy ``solutions.holistic.Holistic`` and the
                            Tasks ``HolisticLandmarker`` (with face blendshapes)

Keypoint contract
-----------------
Every backend emits a single **wholebody** payload:
  - body      : 33-keypoint BlazePose layout (full-frame pixels), as before
  - face      : up to 468 MediaPipe face-mesh landmarks + derived blendshape
                scalars (EAR blinks, jaw-open, mouth shape)
  - leftHand  : 21 landmarks (normalized 0..1) + derived finger pose
  - rightHand : 21 landmarks

The body mapping keeps the existing BlazePose schema so the rig pipeline is
unchanged; face + hands are additive and consumed by the VRM solvers.

DWPose SimCC decode
-------------------
The UnJIT DWPose exports output two tensors, ``simcc_x`` / ``simcc_y``, each
shaped ``(1, 133, dim * simcc_split_ratio)``. Coordinates are recovered by
argmax plus sub-pixel refinement (see ``engine.py``).
"""

from __future__ import annotations

from pathlib import Path

_PKG_DIR = Path(__file__).resolve().parent
MODELS_DIR = _PKG_DIR / "models"

MEDIAPIPE_ID = "mediapipe"
MEDIAPIPE_HOLISTIC_ID = "mediapipe-holistic"
MEDIAPIPE_TASKS_ID = "mediapipe-tasks-landmarker"

# Shared DWPose / MMPose preprocessing constants (RGB, ImageNet mean/std).
_MEAN = [123.675, 116.28, 103.53]
_STD = [58.395, 57.12, 57.375]
_SPLIT = 2.0

_UNJIT_HF = "https://huggingface.co/hr16/UnJIT-DWPose/resolve/main"
_YZDV_HF = "https://huggingface.co/yzd-v/DWPose/resolve/main"
_MEDIAPIPE_TASKS_URL = (
    "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/"
    "holistic_landmarker/float16/1/holistic_landmarker.task"
)

REGISTRY: dict[str, dict] = {
    # ------------------------------------------------------------------ RTMPose
    # Body-only models (COCO-17, 17 keypoints). No face/hand output.
    # Input: (1,3,256,192); simcc_x: (1,17,384) split=2; simcc_y: (1,17,512).
    "rtmpose-s": {
        "id": "rtmpose-s",
        "label": "RTMPose-S · ONNX body (fast, CPU)",
        "family": "rtmpose",
        "engine": "onnx",
        "quality": "fast",
        "layout": "coco17",
        "num_keypoints": 17,
        "contains_face": False,
        "contains_hands": False,
        "whole_body": False,
        "input_size": [192, 256],           # (w, h)
        "mean": _MEAN,
        "std": _STD,
        "simcc_split_ratio": _SPLIT,
        "files": [
            {"filename": "rtmpose-s.onnx",
             "url": "",                     # already downloaded
             "size_hint_mb": 7, "sha256": None},
        ],
        "output_names": ["simcc_x", "simcc_y"],
    },
    "rtmpose-m": {
        "id": "rtmpose-m",
        "label": "RTMPose-M · ONNX body (accurate)",
        "family": "rtmpose",
        "engine": "onnx",
        "quality": "balanced",
        "layout": "coco17",
        "num_keypoints": 17,
        "contains_face": False,
        "contains_hands": False,
        "whole_body": False,
        "input_size": [192, 256],
        "mean": _MEAN,
        "std": _STD,
        "simcc_split_ratio": _SPLIT,
        "files": [
            {"filename": "rtmpose-m.onnx",
             "url": "",
             "size_hint_mb": 20, "sha256": None},
        ],
        "output_names": ["simcc_x", "simcc_y"],
    },
    # ------------------------------------------------------------------ RTMW
    # Wholebody-133 model (body + face + hands), same layout as DWPose.
    # Input: (1,3,256,192); simcc_x: (1,133,384) split=2; simcc_y: (1,133,512).
    "rtmw-l": {
        "id": "rtmw-l",
        "label": "RTMW-L · ONNX wholebody (max accuracy)",
        "family": "rtmw",
        "engine": "onnx",
        "quality": "best",
        "layout": "wholebody133",
        "num_keypoints": 133,
        "contains_face": True,
        "contains_hands": True,
        "whole_body": True,
        "input_size": [192, 256],
        "mean": _MEAN,
        "std": _STD,
        "simcc_split_ratio": _SPLIT,
        "files": [
            {"filename": "rtmw-l.onnx",
             "url": "",
             "size_hint_mb": 250, "sha256": None},
        ],
        "output_names": ["simcc_x", "simcc_y"],
    },
    # ------------------------------------------------------------------ DWPose
    "dwpose-s": {
        "id": "dwpose-s",
        "label": "DWPose-S · ONNX (fast, CPU)",
        "family": "dwpose",
        "engine": "onnx",
        "quality": "fast",
        "layout": "wholebody133",
        "num_keypoints": 133,
        "contains_face": True,
        "contains_hands": True,
        "whole_body": True,
        "input_size": [192, 256],           # (w, h)
        "mean": _MEAN,
        "std": _STD,
        "simcc_split_ratio": _SPLIT,
        "files": [
            {"filename": "dw-ss_ucoco.onnx",
             "url": f"{_UNJIT_HF}/dw-ss_ucoco.onnx",
             "size_hint_mb": 28, "sha256": None},
        ],
        "output_names": ["simcc_x", "simcc_y"],
    },
    "dwpose-m": {
        "id": "dwpose-m",
        "label": "DWPose-M · ONNX (accurate)",
        "family": "dwpose",
        "engine": "onnx",
        "quality": "balanced",
        "layout": "wholebody133",
        "num_keypoints": 133,
        "contains_face": True,
        "contains_hands": True,
        "whole_body": True,
        "input_size": [192, 256],
        "mean": _MEAN,
        "std": _STD,
        "simcc_split_ratio": _SPLIT,
        "files": [
            {"filename": "dw-mm_ucoco.onnx",
             "url": f"{_UNJIT_HF}/dw-mm_ucoco.onnx",
             "size_hint_mb": 60, "sha256": None},
        ],
        "output_names": ["simcc_x", "simcc_y"],
    },
    "dwpose-l": {
        "id": "dwpose-l",
        "label": "DWPose-L · ONNX (max accuracy, 384px)",
        "family": "dwpose",
        "engine": "onnx",
        "quality": "best",
        "layout": "wholebody133",
        "num_keypoints": 133,
        "contains_face": True,
        "contains_hands": True,
        "whole_body": True,
        "input_size": [288, 384],           # dw-ll_ucoco_384 is 384 on the long side
        "mean": _MEAN,
        "std": _STD,
        "simcc_split_ratio": _SPLIT,
        "files": [
            {"filename": "dw-ll_ucoco_384.onnx",
             "url": f"{_YZDV_HF}/dw-ll_ucoco_384.onnx",
             "size_hint_mb": 200, "sha256": None},
        ],
        "output_names": ["simcc_x", "simcc_y"],
    },
    MEDIAPIPE_HOLISTIC_ID: {
        "id": MEDIAPIPE_HOLISTIC_ID,
        "label": "MediaPipe Holistic · native (Lite/Full)",
        "family": "mediapipe",
        "engine": "native-mediapipe",
        "native_engine": "holistic-legacy",
        "quality": "native",
        "layout": "wholebody133",
        "num_keypoints": 133,
        "contains_face": True,
        "contains_hands": True,
        "whole_body": True,
        "model_complexity": 1,              # 0 = Lite (potato), 1 = Full
        "complexity_options": [0, 1],
        "files": [],                        # bundled with the mediapipe package
    },
    MEDIAPIPE_TASKS_ID: {
        "id": MEDIAPIPE_TASKS_ID,
        "label": "MediaPipe Tasks Holistic · native (52 blendshapes)",
        "family": "mediapipe_tasks",
        "engine": "native-mediapipe",
        "native_engine": "holistic-tasks",
        "quality": "native",
        "layout": "wholebody133",
        "num_keypoints": 133,
        "contains_face": True,
        "contains_hands": True,
        "whole_body": True,
        "files": [
            {"filename": "holistic_landmarker.task",
             "url": _MEDIAPIPE_TASKS_URL,
             "size_hint_mb": 12, "sha256": None},
        ],
    },
}

# Which mocap-mode options each backend can serve.
SUPPORTED_PIPELINES = {
    "rtmpose-s": ["FULL_BODY"],
    "rtmpose-m": ["FULL_BODY"],
    "rtmw-l": ["FULL_BODY", "FACE"],
    "dwpose-s": ["FULL_BODY", "FACE"],
    "dwpose-m": ["FULL_BODY", "FACE"],
    "dwpose-l": ["FULL_BODY", "FACE"],
    MEDIAPIPE_HOLISTIC_ID: ["FULL_BODY", "FACE"],
    MEDIAPIPE_TASKS_ID: ["FULL_BODY", "FACE"],
}

# Backends that need no downloadable weights (engine is fully bundled).
BUNDLED_BACKENDS = {MEDIAPIPE_HOLISTIC_ID}


def model_dir(model_id: str) -> Path:
    return MODELS_DIR / model_id


def model_path(model_id: str, filename: str) -> Path:
    return model_dir(model_id) / filename


def is_installed(model_id: str) -> bool:
    spec = REGISTRY.get(model_id)
    if not spec:
        return False
    if model_id in BUNDLED_BACKENDS:
        return True
    files = spec.get("files") or []
    if not files:
        return True
    return all(model_path(model_id, f["filename"]).exists() for f in files)


def installed_size_mb(model_id: str) -> int:
    folder = model_dir(model_id)
    if not folder.exists():
        return 0
    total = sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())
    return int(total / (1024 * 1024))


def list_backends() -> list[dict]:
    """Summary for the UI: the built-in MediaPipe + ONNX + native engines."""
    items = [{
        "id": MEDIAPIPE_ID,
        "label": "MediaPipe (built-in, WASM)",
        "family": "mediapipe",
        "engine": "wasm",
        "quality": "native",
        "whole_body": True,
        "contains_face": True,
        "contains_hands": True,
        "installed": True,
        "downloadable": False,
        "bundled": True,
        "size_mb": 0,
        "complexity_options": None,
        "model_complexity": None,
        "supported_pipelines": ["FULL_BODY", "FACE"],
    }]
    for spec in REGISTRY.values():
        items.append({
            "id": spec["id"],
            "label": spec["label"],
            "family": spec["family"],
            "engine": spec.get("engine", "onnx"),
            "native_engine": spec.get("native_engine"),
            "quality": spec["quality"],
            "whole_body": spec["whole_body"],
            "contains_face": spec["contains_face"],
            "contains_hands": spec["contains_hands"],
            "installed": is_installed(spec["id"]),
            "downloadable": spec["id"] not in BUNDLED_BACKENDS,
            "bundled": spec["id"] in BUNDLED_BACKENDS,
            "size_mb": installed_size_mb(spec["id"]) or _hint_total(spec),
            "complexity_options": spec.get("complexity_options"),
            "model_complexity": spec.get("model_complexity"),
            "supported_pipelines": SUPPORTED_PIPELINES.get(spec["id"], ["FULL_BODY"]),
        })
    return items


def _hint_total(spec: dict) -> int:
    return sum(int(f.get("size_hint_mb", 0)) for f in (spec.get("files") or []))
