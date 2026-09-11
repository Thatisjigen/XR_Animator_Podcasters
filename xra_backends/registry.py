"""Catalogue of bundled native MediaPipe Tasks models.

The app exposes a single native backend with two execution modes:
``HolisticLandmarker`` for full body and ``FaceLandmarker`` for face-only.

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

"""

from __future__ import annotations

from pathlib import Path

_PKG_DIR = Path(__file__).resolve().parent
MODELS_DIR = _PKG_DIR / "models"

MEDIAPIPE_ID = "mediapipe"
MEDIAPIPE_TASKS_ID = "mediapipe-tasks-landmarker"

_MEDIAPIPE_TASKS_URL = (
    "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/"
    "holistic_landmarker/float16/1/holistic_landmarker.task"
)
_MEDIAPIPE_FACE_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
REGISTRY: dict[str, dict] = {
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
            {"filename": "face_landmarker.task",
             "url": _MEDIAPIPE_FACE_URL,
             "size_hint_mb": 4, "sha256": None},
        ],
    },
}

DEFAULT_BACKEND = MEDIAPIPE_TASKS_ID

# Which mocap-mode options each backend can serve.
SUPPORTED_PIPELINES = {
    MEDIAPIPE_TASKS_ID: ["FULL_BODY", "FACE"],
}

# Backends that need no downloadable weights (engine is fully bundled).
BUNDLED_BACKENDS = set()


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
    """Summary for the UI: native MediaPipe Tasks engine."""
    items = []
    for spec in REGISTRY.values():
        items.append({
            "id": spec["id"],
            "label": spec["label"],
            "family": spec["family"],
            "engine": spec.get("engine", "native-mediapipe"),
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
