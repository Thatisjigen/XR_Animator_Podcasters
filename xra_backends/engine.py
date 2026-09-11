# XRA_UNIVERSAL_RUNTIME_V9
# XRA_RUNTIME_BUILD_V8
# XRA_PERFORMANCE_RUNTIME_V7
# XRA_BACKEND_CAMERA_V3
"""Server-side mocap inference (ONNX DWPose + native MediaPipe dispatcher).

Three backend families share one wholebody output contract:

  * ONNX DWPose  -> :class:`MocapEngine` (COCO-WholeBody-133, SimCC head)
  * Legacy MP    -> :mod:`xra_backends.native_mediapipe` (solutions.holistic)
  * Tasks MP     -> :mod:`xra_backends.native_mediapipe` (HolisticLandmarker)

The process-wide :data:`ENGINE` is a thin dispatcher: it owns the ONNX session
and forwards native backends to the matching engine object, so ``server.py``
only ever talks to one object with ``load/unload/infer/status``.

Wholebody output contract
-------------------------
  ``{"score", "keypoints"[33 BlazePose], "keypoints3D"[33],
     "face": {"landmarks"[N], "blendshapes": {...}},
     "leftHand"[21], "rightHand"[21]}``

Body keeps the BlazePose schema the rig already consumes; face + hands are
additive fields for the VRM face / finger solvers.

DWPose SimCC decode
-------------------
DWPose exports ``simcc_x`` / ``simcc_y`` shaped ``(1, 133, dim*split_ratio)``.
Coordinates are argmax + sub-pixel; the 133 layout is
``0-16 body, 17-22 feet, 23-90 face, 91-111 left-hand, 112-132 right-hand``.
"""

from __future__ import annotations

import gc
import math
import os
import threading
import time
from typing import Optional

import numpy as np

from . import registry, runtime
from . import native_mediapipe as _native

# ---------------------------------------------------------------------------
# BlazePose-33 names (must mirror js/mocap_lib_module.js BLAZEPOSE_KEYPOINTS).
# ---------------------------------------------------------------------------
BLAZEPOSE_NAMES = [
    "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner",
    "right_eye", "right_eye_outer", "left_ear", "right_ear", "mouth_left",
    "mouth_right", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_pinky", "right_pinky", "left_index",
    "right_index", "left_thumb", "right_thumb", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle", "left_heel",
    "right_heel", "left_foot_index", "right_foot_index",
]

# COCO-17 body layout -> BlazePose-33 name.
_COCO17_TO_BLAZE = {
    0: "nose", 1: "left_eye", 2: "right_eye", 3: "left_ear", 4: "right_ear",
    5: "left_shoulder", 6: "right_shoulder", 7: "left_elbow", 8: "right_elbow",
    9: "left_wrist", 10: "right_wrist", 11: "left_hip", 12: "right_hip",
    13: "left_knee", 14: "right_knee", 15: "left_ankle", 16: "right_ankle",
}

# COCO-WholeBody-133 layout (DWPose):
#   0-16  : 17 body keypoints (same order as COCO-17 above)
#   17-22 : 6 foot keypoints (L big_toe/small_toe/heel, R big_toe/small_toe/heel)
#   23-90 : 68 face keypoints (COCO-WholeBody face-68)
#   91-111: 21 left-hand keypoints
#   112-132: 21 right-hand keypoints
_WB133_BODY_TO_BLAZE = {
    0: "nose", 1: "left_eye", 2: "right_eye", 3: "left_ear", 4: "right_ear",
    5: "left_shoulder", 6: "right_shoulder", 7: "left_elbow", 8: "right_elbow",
    9: "left_wrist", 10: "right_wrist", 11: "left_hip", 12: "right_hip",
    13: "left_knee", 14: "right_knee", 15: "left_ankle", 16: "right_ankle",
}
# BlazePose has no "small toe"; big_toe -> foot_index, plus heel.
_WB133_FOOT_TO_BLAZE = {
    17: "left_foot_index", 19: "left_heel",
    20: "right_foot_index", 22: "right_heel",
}

# Wholebody-133 slice boundaries.
_WB133_FACE_START, _WB133_FACE_END = 23, 91        # 68 face points
_WB133_LHAND_START, _WB133_LHAND_END = 91, 112     # 21 left-hand points
_WB133_RHAND_START, _WB133_RHAND_END = 112, 133    # 21 right-hand points

# COCO hand layout (per hand, 21 pts): 0 wrist, 1-4 thumb, 5-8 index,
# 9-12 middle, 13-16 ring, 17-20 pinky.
_HAND_NAMES = (
    ["wrist"] + [f"thumb{i}" for i in range(1, 5)]
    + [f"index{i}" for i in range(1, 5)]
    + [f"middle{i}" for i in range(1, 5)]
    + [f"ring{i}" for i in range(1, 5)]
    + [f"pinky{i}" for i in range(1, 5)]
)

# COCO hand points we map onto BlazePose's single pinky/index/thumb points.
_WB133_HAND_LEFT_ROOT = 91
_WB133_HAND_RIGHT_ROOT = 112
_HAND_OFFSETS = {"thumb": 1, "index": 5, "pinky": 17}

_BLAZE_INDEX = {name: i for i, name in enumerate(BLAZEPOSE_NAMES)}


class _OpenVinoInput:
    def __init__(self, name: str) -> None:
        self.name = name


class _OpenVinoSession:
    """Tiny ORT-compatible adapter around a compiled OpenVINO ONNX model."""
    def __init__(self, model_file: Path, device: str) -> None:
        import openvino as ov
        self.device = str(device)
        self.core = ov.Core()
        model = self.core.read_model(str(model_file))
        # LATENCY is the correct hint for one webcam stream / one pose at a time.
        self.compiled = self.core.compile_model(
            model,
            self.device,
            {"PERFORMANCE_HINT": "LATENCY"},
        )
        self.input_port = self.compiled.input(0)
        self.output_ports = list(self.compiled.outputs)
        try:
            self.input_name = self.input_port.get_any_name()
        except Exception:
            self.input_name = "input"
        self.request = self.compiled.create_infer_request()

    def get_inputs(self):
        return [_OpenVinoInput(self.input_name)]

    def get_providers(self):
        return [f"OpenVINO:{self.device}"]

    def run(self, _outputs, feed: dict):
        tensor = feed.get(self.input_name)
        if tensor is None and feed:
            tensor = next(iter(feed.values()))
        result = self.request.infer({self.input_port: tensor})
        return [np.asarray(result[port]) for port in self.output_ports]


class MocapEngine:
    """Resident ONNX session wrapper. Thread-safe ``infer`` via a lock."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._session = None
        self._model_id: Optional[str] = None
        self._provider: Optional[str] = None
        self._spec: Optional[dict] = None
        self._input_name: Optional[str] = None
        self._last_error = ""
        self._fallback_reason = ""

    # -- lifecycle ----------------------------------------------------------

    @property
    def ready(self) -> bool:
        return self._session is not None

    @property
    def model_id(self) -> Optional[str]:
        return self._model_id

    @property
    def provider(self) -> Optional[str]:
        return self._provider

    def status(self) -> dict:
        return {
            "ready": self.ready,
            "model": self._model_id,
            "provider": self._provider,
            "provider_human": runtime.human_name(self._provider) if self._provider else None,
            "last_error": self._last_error,
            "fallback_reason": self._fallback_reason,
        }
    def unload(self) -> None:
        """Release the ONNX session and its CPU/GPU allocations."""
        with self._lock:
            old_session = self._session
            self._session = None
            self._model_id = None
            self._provider = None
            self._spec = None
            self._input_name = None
            self._last_error = ""
            self._fallback_reason = ""
        del old_session
        gc.collect()
    def load(self, model_id: str) -> dict:
        """Select a working backend automatically: CUDA -> best OpenVINO -> ORT CPU."""
        self.unload()
        spec = registry.REGISTRY.get(model_id)
        if not spec:
            return {"ok": False, "error": f"Unknown backend: {model_id}"}
        if not registry.is_installed(model_id):
            return {"ok": False, "error": f"Backend not installed: {model_id}", "needs_download": True}

        ort = runtime.bootstrap_import()
        if ort is None:
            return {"ok": False, "error": "onnxruntime not available", "needs_runtime": True}
        runtime.preload_accelerator_libraries(ort)
        model_file = registry.model_dir(model_id) / spec["files"][0]["filename"]

        in_w, in_h = spec["input_size"]
        dummy_bgr = np.zeros((int(in_h), int(in_w), 3), dtype=np.uint8)
        tensor, _scale, _pad_x, _pad_y = self._preprocess(dummy_bgr, spec)

        def probe(session, input_name: str) -> float:
            # First execution catches missing CUDA/cuDNN and lazy OpenVINO init.
            session.run(None, {input_name: tensor})
            samples = []
            for _ in range(2):
                started = time.perf_counter()
                session.run(None, {input_name: tensor})
                samples.append((time.perf_counter() - started) * 1000.0)
            return sum(samples) / max(1, len(samples))

        def ort_session(provider: str):
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 2
            opts.inter_op_num_threads = 1
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            providers = [provider]
            provider_options = [runtime.provider_options(provider)]
            if provider != "CPUExecutionProvider":
                providers.append("CPUExecutionProvider")
                provider_options.append({})
            session = ort.InferenceSession(
                str(model_file),
                sess_options=opts,
                providers=providers,
                provider_options=provider_options,
            )
            input_name = session.get_inputs()[0].name
            measured = probe(session, input_name)
            active = session.get_providers()[0] if session.get_providers() else provider
            if provider == "CUDAExecutionProvider" and active != provider:
                raise RuntimeError(f"CUDA requested but session bound {active}")
            return session, input_name, active, measured

        def ov_session(device: str):
            session = _OpenVinoSession(model_file, device)
            input_name = session.get_inputs()[0].name
            measured = probe(session, input_name)
            return session, input_name, f"OpenVINO:{device}", measured

        failures = runtime.provider_failures()
        available = runtime.available_providers()
        fallback_notes: list[str] = []

        # CUDA gets first refusal. If its first real Conv cannot obtain cuDNN,
        # quarantine it once and never spam the camera loop with the same error.
        if "CUDAExecutionProvider" in available and "CUDAExecutionProvider" not in failures:
            try:
                session, input_name, active, measured = ort_session("CUDAExecutionProvider")
                with self._lock:
                    self._session = session
                    self._model_id = model_id
                    self._provider = active
                    self._spec = dict(spec)
                    self._input_name = input_name
                    self._last_error = ""
                    self._fallback_reason = ""
                runtime.log_provider(active, model_id)
                print(f"[XRA_BACKEND] CUDA warm-up {measured:.1f} ms", flush=True)
                return {"ok": True, **self.status()}
            except Exception as exc:
                message = f"{type(exc).__name__}: {exc}"
                runtime.mark_provider_unhealthy("CUDAExecutionProvider", message)
                fallback_notes.append(f"CUDA unavailable at execution: {message}")

        # On non-CUDA machines, benchmark the available Intel paths against ORT
        # CPU and choose the lower real inference latency. This handles 10th-gen
        # Intel systems where OpenVINO GPU can be faster OR slower than CPU.
        trials = []
        ov_devices = runtime.openvino_devices()
        for device in ov_devices:
            key = f"OpenVINO:{device}"
            if key in runtime.provider_failures():
                continue
            upper = str(device).upper()
            if not (upper.startswith("GPU") or upper.startswith("CPU")):
                continue
            try:
                candidate = ov_session(str(device))
                trials.append(candidate)
                print(f"[XRA_BACKEND] {key} warm-up {candidate[3]:.1f} ms", flush=True)
            except Exception as exc:
                message = f"{type(exc).__name__}: {exc}"
                runtime.mark_provider_unhealthy(key, message)
                fallback_notes.append(f"{key} failed: {message}")

        if "CPUExecutionProvider" in available:
            try:
                candidate = ort_session("CPUExecutionProvider")
                trials.append(candidate)
                print(f"[XRA_BACKEND] CPUExecutionProvider warm-up {candidate[3]:.1f} ms", flush=True)
            except Exception as exc:
                fallback_notes.append(f"CPUExecutionProvider failed: {type(exc).__name__}: {exc}")

        if not trials:
            self._last_error = "; ".join(fallback_notes) or "no usable inference provider"
            return {"ok": False, "error": self._last_error, "model": model_id}

        trials.sort(key=lambda item: item[3])
        session, input_name, active, measured = trials[0]
        # Drop non-selected trial sessions promptly (important on iGPU/CPU RAM).
        for other in trials[1:]:
            try:
                del other
            except Exception:
                pass
        gc.collect()

        with self._lock:
            self._session = session
            self._model_id = model_id
            self._provider = active
            self._spec = dict(spec)
            self._input_name = input_name
            self._last_error = ""
            self._fallback_reason = "; ".join(fallback_notes)
        runtime.log_provider(active, model_id)
        print(f"[XRA_BACKEND] Selected {active}: {measured:.1f} ms", flush=True)
        return {"ok": True, **self.status()}
    @staticmethod
    def _preprocess(frame_bgr: np.ndarray, spec: dict):
        """Letterbox BGR -> normalized NCHW.

        OpenCV is used when available: the previous NumPy bilinear path created
        several full-frame float64 temporaries and was often more expensive than
        the ONNX inference itself. The NumPy implementation remains a fallback.
        """
        in_w, in_h = spec["input_size"]
        h, w = frame_bgr.shape[:2]
        scale = min(in_w / w, in_h / h)
        new_w = max(1, int(round(w * scale)))
        new_h = max(1, int(round(h * scale)))
        pad_x, pad_y = (in_w - new_w) // 2, (in_h - new_h) // 2

        try:
            import cv2
            resized = cv2.resize(frame_bgr, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
            canvas = np.zeros((in_h, in_w, 3), dtype=np.uint8)
            canvas[pad_y:pad_y + new_h, pad_x:pad_x + new_w] = resized
            rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32, copy=False)
        except Exception:
            src = frame_bgr.astype(np.float32, copy=False)
            ys = np.clip((np.arange(new_h, dtype=np.float32) + 0.5) / scale - 0.5, 0, h - 1)
            xs = np.clip((np.arange(new_w, dtype=np.float32) + 0.5) / scale - 0.5, 0, w - 1)
            y0 = np.floor(ys).astype(np.int32); y1 = np.clip(y0 + 1, 0, h - 1)
            x0 = np.floor(xs).astype(np.int32); x1 = np.clip(x0 + 1, 0, w - 1)
            wy = (ys - y0)[:, None, None]; wx = (xs - x0)[None, :, None]
            top = src[y0][:, x0] * (1.0 - wx) + src[y0][:, x1] * wx
            bot = src[y1][:, x0] * (1.0 - wx) + src[y1][:, x1] * wx
            resized = top * (1.0 - wy) + bot * wy
            canvas = np.zeros((in_h, in_w, 3), dtype=np.float32)
            canvas[pad_y:pad_y + new_h, pad_x:pad_x + new_w] = resized
            rgb = canvas[..., ::-1]

        mean = np.asarray(spec["mean"], dtype=np.float32)
        std = np.asarray(spec["std"], dtype=np.float32)
        tensor = ((rgb - mean) / std).transpose(2, 0, 1)[None].astype(np.float32, copy=False)
        return np.ascontiguousarray(tensor), scale, pad_x, pad_y
    @staticmethod
    def _decode_simcc(simcc_x: np.ndarray, simcc_y: np.ndarray, split: float):
        """Decode SimCC coordinates and turn normalized-Gaussian peaks into 0..1.

        MMPose's SimCC codec normally trains with ``normalize=True`` and sigma=6.
        Its ideal peak is therefore 1/(sigma*sqrt(2*pi)) ~= 0.06649, not 1.0.
        A raw DWPose peak around 0.044 is consequently a plausible ~0.67 score.
        For exports that expose logits instead, a sigmoid fallback is used.
        """
        xs = np.asarray(simcc_x, dtype=np.float32)
        ys = np.asarray(simcc_y, dtype=np.float32)
        if xs.ndim == 3:
            xs = xs[0]
            ys = ys[0]
        x_idx = np.argmax(xs, axis=1).astype(np.float32)
        y_idx = np.argmax(ys, axis=1).astype(np.float32)
        x = (x_idx + 0.5) / float(split)
        y = (y_idx + 0.5) / float(split)

        raw = (np.max(xs, axis=1) + np.max(ys, axis=1)) * 0.5
        finite_raw = raw[np.isfinite(raw)]
        p95 = float(np.percentile(finite_raw, 95)) if finite_raw.size else 0.0
        p05 = float(np.percentile(finite_raw, 5)) if finite_raw.size else 0.0
        if p05 >= -1e-6 and p95 <= 0.25:
            sigma = max(0.1, float(os.environ.get("XRA_SIMCC_SIGMA", "6.0")))
            peak_ref = float(os.environ.get(
                "XRA_SIMCC_PEAK_REF", str(1.0 / (sigma * math.sqrt(2.0 * math.pi)))
            ))
            scores = np.clip(raw / max(peak_ref, 1e-6), 0.0, 1.0)
        else:
            scores = 1.0 / (1.0 + np.exp(-np.clip(raw, -20.0, 20.0)))

        coords = np.stack([x, y], axis=1)
        return coords, scores.astype(np.float32, copy=False)
    def infer(self, frame_bgr: np.ndarray) -> Optional[dict]:
        """Run one pose inference and perform at most one provider failover."""
        if not self.ready:
            return None
        with self._lock:
            session = self._session
            input_name = self._input_name
            spec = self._spec
            model_id = self._model_id
            provider = self._provider
        try:
            tensor, scale, pad_x, pad_y = self._preprocess(frame_bgr, spec)
            outputs = session.run(None, {input_name: tensor})
            simcc_x, simcc_y = outputs[0], outputs[1]
            split = float(spec["simcc_split_ratio"])
            coords, scores = self._decode_simcc(simcc_x, simcc_y, split)
            coords[:, 0] = (coords[:, 0] - pad_x) / scale
            coords[:, 1] = (coords[:, 1] - pad_y) / scale
            if spec["layout"] == "coco17":
                return self._assemble_coco17(coords, scores)
            return self._assemble_wholebody133(coords, scores)
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            with self._lock:
                self._last_error = message
            if provider and provider != "CPUExecutionProvider" and model_id:
                runtime.mark_provider_unhealthy(provider, message)
                print(f"[XRA_BACKEND] {provider} failed; reselecting provider", flush=True)
                result = self.load(model_id)
                if result.get("ok") and self.provider != provider:
                    with self._lock:
                        self._fallback_reason = (
                            f"{provider} failed during inference; switched to {self.provider}: {message}"
                        )
                    # One retry after a provider change only.
                    try:
                        tensor, scale, pad_x, pad_y = self._preprocess(frame_bgr, self._spec)
                        outputs = self._session.run(None, {self._input_name: tensor})
                        simcc_x, simcc_y = outputs[0], outputs[1]
                        coords, scores = self._decode_simcc(
                            simcc_x, simcc_y, float(self._spec["simcc_split_ratio"])
                        )
                        coords[:, 0] = (coords[:, 0] - pad_x) / scale
                        coords[:, 1] = (coords[:, 1] - pad_y) / scale
                        if self._spec["layout"] == "coco17":
                            return self._assemble_coco17(coords, scores)
                        return self._assemble_wholebody133(coords, scores)
                    except Exception as retry_exc:
                        message = f"{type(retry_exc).__name__}: {retry_exc}"
            self.unload()
            with self._lock:
                self._last_error = message
            return None
    def _build_body(self, coords, scores):
        """BlazePose-33 (x, y, score) skeleton from the wholebody body/foot slots."""
        kp = [{"x": 0.0, "y": 0.0, "score": 0.0} for _ in range(33)]

        def put(blaze_name, idx):
            if idx is None or idx >= len(coords):
                return
            bi = _BLAZE_INDEX.get(blaze_name)
            if bi is None:
                return
            kp[bi] = {"x": float(coords[idx][0]), "y": float(coords[idx][1]),
                      "score": float(scores[idx])}

        for src, name in _WB133_BODY_TO_BLAZE.items():
            put(name, src)
        for src, name in _WB133_FOOT_TO_BLAZE.items():
            put(name, src)
        for side, base in (("left", _WB133_HAND_LEFT_ROOT),
                           ("right", _WB133_HAND_RIGHT_ROOT)):
            for joint, off in _HAND_OFFSETS.items():
                put(f"{side}_{joint}", base + off)
        return kp

    @staticmethod
    def _wrap_body(kp):
        z_values = MocapEngine._synthesize_z(kp)
        keypoints = [{
            "position": {"x": p["x"], "y": p["y"], "z": z_values[i]},
            "score": p["score"],
            "part": _camel(BLAZEPOSE_NAMES[i]),
        } for i, p in enumerate(kp)]
        keypoints3D = [{
            "x": p["x"], "y": p["y"], "z": z_values[i],
            "score": p["score"], "name": BLAZEPOSE_NAMES[i],
        } for i, p in enumerate(kp)]
        return keypoints, keypoints3D

    def _assemble_coco17(self, coords, scores) -> dict:
        kp = [{"x": 0.0, "y": 0.0, "score": 0.0} for _ in range(33)]
        for src, name in _COCO17_TO_BLAZE.items():
            bi = _BLAZE_INDEX.get(name)
            if bi is not None and src < len(coords):
                kp[bi] = {"x": float(coords[src][0]), "y": float(coords[src][1]),
                          "score": float(scores[src])}
        keypoints, keypoints3D = self._wrap_body(kp)
        return {
            "score": 1.0, "keypoints": keypoints, "keypoints3D": keypoints3D,
            "face": {"landmarks": [], "blendshapes": _empty_blendshapes()},
            "leftHand": [], "rightHand": [],
        }

    def _assemble_wholebody133(self, coords, scores) -> dict:
        kp = self._build_body(coords, scores)
        keypoints, keypoints3D = self._wrap_body(kp)

        # Decode the full 133 layout instead of discarding face + hands.
        face_pts = _slice(coords, scores, _WB133_FACE_START, _WB133_FACE_END)
        left_hand = _slice(coords, scores, _WB133_LHAND_START, _WB133_LHAND_END)
        right_hand = _slice(coords, scores, _WB133_RHAND_START, _WB133_RHAND_END)

        return {
            "score": 1.0, "keypoints": keypoints, "keypoints3D": keypoints3D,
            "face": {
                "landmarks": _as_landmarks(face_pts),
                "blendshapes": _blendshapes_from_dwpose_face(face_pts),
                "layout": "coco_face_68",
            },
            "leftHand": _as_hand(left_hand),
            "rightHand": _as_hand(right_hand),
        }

    @staticmethod
    def _synthesize_z(kp) -> list[float]:
        """Relative depth cue for 2D models (torso-anchored, scale-normalized).

        Heuristic only: it keeps the 3D pipeline well-conditioned when the model
        has no true metric Z. Not a measurement.
        """
        n = len(kp)

        def pt(name):
            i = _BLAZE_INDEX.get(name)
            if i is None or i >= n:
                return None
            p = kp[i]
            return (p["x"], p["y"], p["score"])

        z = [0.0] * n
        shoulders = [pt("left_shoulder"), pt("right_shoulder")]
        hips = [pt("left_hip"), pt("right_hip")]
        valid = lambda p: p is not None and p[2] > 0.0

        pts = [p for p in (shoulders + hips) if valid(p)]
        if not pts:
            return z
        ref_x = sum(p[0] for p in pts) / len(pts)
        ref_y = sum(p[1] for p in pts) / len(pts)

        span = 0.0
        if valid(shoulders[0]) and valid(shoulders[1]):
            span = float(np.hypot(shoulders[0][0] - shoulders[1][0],
                                  shoulders[0][1] - shoulders[1][1]))
        if span <= 1e-3:
            span = float(np.hypot(pts[0][0] - ref_x, pts[0][1] - ref_y)) * 2.0
        if span <= 1e-3:
            return z

        for i, p in enumerate(kp):
            if p["score"] <= 0.0:
                continue
            dx = (p["x"] - ref_x) / span
            dy = (p["y"] - ref_y) / span
            radial = 1.0 - min(np.hypot(dx, dy), 2.0)
            vertical = -dy
            z[i] = float((radial * 0.6 + vertical * 0.4) * span)
        return z


# ---------------------------------------------------------------------------
# Wholebody-133 helpers
# ---------------------------------------------------------------------------

def _empty_blendshapes() -> dict:
    return {"eyeBlinkLeft": 0.0, "eyeBlinkRight": 0.0,
            "jawOpen": 0.0, "mouthSmile": 0.0, "mouthFrown": 0.0}


def _slice(coords, scores, start, end):
    """Return [(x, y, score), ...] for wholebody slots ``[start, end)``."""
    out = []
    for i in range(start, min(end, len(coords))):
        out.append((float(coords[i][0]), float(coords[i][1]), float(scores[i])))
    return out


def _as_landmarks(pts):
    return [{"x": x, "y": y, "score": s} for (x, y, s) in pts]


def _as_hand(pts):
    """Tag each hand landmark with its COCO-hand name (wrist, thumb1..pinky4)."""
    out = []
    for i, (x, y, s) in enumerate(pts):
        name = _HAND_NAMES[i] if i < len(_HAND_NAMES) else f"pt{i}"
        out.append({"x": x, "y": y, "score": s, "name": name})
    return out


# DWPose face-68 index map -> the (eye/mouth) points needed for blendshape math.
# face-68: 0-16 jaw, 17-21 R brow, 22-26 L brow, 27-35 nose, 36-41 R eye,
# 42-47 L eye, 48-59 outer lip, 60-67 inner lip.
_DW_FACE_L_EYE = (42, 43, 44, 45, 46, 47)
_DW_FACE_R_EYE = (36, 37, 38, 39, 40, 41)
_DW_FACE_MOUTH_V = (62, 66)     # inner upper / lower lip
_DW_FACE_MOUTH_CORNERS = (48, 54)


def _blendshapes_from_dwpose_face(pts) -> dict:
    """Derive blink/jaw/smile scalars from DWPose face-68 points."""
    if len(pts) < 68:
        return _empty_blendshapes()

    def ear(ring):
        try:
            p = [pts[i] for i in ring]
            v1 = np.hypot(p[1][0] - p[5][0], p[1][1] - p[5][1])
            v2 = np.hypot(p[2][0] - p[4][0], p[2][1] - p[4][1])
            h = np.hypot(p[0][0] - p[3][0], p[0][1] - p[3][1])
            return float((v1 + v2) / (2.0 * h)) if h > 1e-6 else 0.0
        except Exception:
            return 0.0

    blink_l = float(np.clip(1.0 - ear(_DW_FACE_L_EYE) / 0.30, 0.0, 1.0)) ** 0.7
    blink_r = float(np.clip(1.0 - ear(_DW_FACE_R_EYE) / 0.30, 0.0, 1.0)) ** 0.7
    try:
        upper = np.array(pts[_DW_FACE_MOUTH_V[0]])
        lower = np.array(pts[_DW_FACE_MOUTH_V[1]])
        mouth_h = float(np.hypot(*(upper - lower)))
        corner_l = np.array(pts[_DW_FACE_MOUTH_CORNERS[0]])
        corner_r = np.array(pts[_DW_FACE_MOUTH_CORNERS[1]])
        corner_w = float(np.hypot(*(corner_l - corner_r)))
        jaw = float(np.clip(mouth_h / (corner_w + 1e-6) * 2.5, 0.0, 1.0))
        mid_y = (upper[1] + lower[1]) * 0.5
        corner_y = (corner_l[1] + corner_r[1]) * 0.5
        lift = (mid_y - corner_y) / (corner_w + 1e-6)
        smile = float(np.clip(lift * 2.0, 0.0, 1.0))
        frown = float(np.clip(-lift * 2.0, 0.0, 1.0))
    except Exception:
        jaw = smile = frown = 0.0
    return {"eyeBlinkLeft": blink_l, "eyeBlinkRight": blink_r,
            "jawOpen": jaw, "mouthSmile": smile, "mouthFrown": frown}


def _camel(name: str) -> str:
    """``left_eye_inner`` -> ``leftEyeInner`` (lowerCamelCase, MediaPipe-style)."""
    head, *rest = name.split("_")
    if not rest:
        return head
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


# ---------------------------------------------------------------------------
# Wire normalization
# XRA_ONNX_STABILITY_V2: explicit 2D image / 3D body-space wire contract.
# ---------------------------------------------------------------------------

def to_wire(payload: dict, capture_hint: Optional[tuple[int, int]] = None) -> dict:
    """Build the explicit browser wire contract.

    2D landmarks are normalized image coordinates. 3D landmarks are bounded,
    hip-centred body/world units; pixel coordinates are never placed in the 3D
    fields consumed by the XR Animator stabilizer and IK.
    """
    if not payload:
        return {}

    def _float(value, fallback=0.0):
        try:
            result = float(value)
            return result if result == result and abs(result) != float("inf") else fallback
        except Exception:
            return fallback

    def _clamp(value, lo, hi):
        return max(lo, min(hi, _float(value)))

    def _pos(point):
        position = point.get("position") if isinstance(point, dict) else None
        return position if isinstance(position, dict) else (point if isinstance(point, dict) else {})

    source_2d = payload.get("keypoints") or []
    source_3d = payload.get("keypoints3D") or []
    width, height = capture_hint or (0, 0)
    width = _float(width)
    height = _float(height)
    if width <= 0 or height <= 0:
        max_x = max((_float(_pos(point).get("x")) for point in source_2d), default=1.0)
        max_y = max((_float(_pos(point).get("y")) for point in source_2d), default=1.0)
        width = max(abs(max_x), 1.0)
        height = max(abs(max_y), 1.0)

    def _normalized_point(point):
        position = _pos(point)
        result = dict(point) if isinstance(point, dict) else {}
        normalized = {
            "x": _float(position.get("x")) / width,
            "y": _float(position.get("y")) / height,
            "z": _float(position.get("z")) / width,
        }
        if isinstance(result.get("position"), dict):
            result["position"] = normalized
        else:
            result.update(normalized)
        return result

    keypoints = [_normalized_point(point) for point in source_2d]
    aspect = width / height

    def _norm_xy(index):
        if index >= len(keypoints):
            return 0.0, 0.0
        point = _pos(keypoints[index])
        return _float(point.get("x")), _float(point.get("y"))

    def _span(a, b):
        ax, ay = _norm_xy(a)
        bx, by = _norm_xy(b)
        return (((ax - bx) * aspect) ** 2 + (ay - by) ** 2) ** 0.5

    shoulder_span = _span(11, 12)
    hip_span = _span(23, 24)
    ls = _norm_xy(11); rs = _norm_xy(12); lh = _norm_xy(23); rh = _norm_xy(24)
    shoulder_mid = ((ls[0] + rs[0]) * 0.5 * aspect, (ls[1] + rs[1]) * 0.5)
    hip_mid_norm = ((lh[0] + rh[0]) * 0.5 * aspect, (lh[1] + rh[1]) * 0.5)
    torso_span = ((shoulder_mid[0] - hip_mid_norm[0]) ** 2
                  + (shoulder_mid[1] - hip_mid_norm[1]) ** 2) ** 0.5

    def _score(point):
        if not isinstance(point, dict):
            return 0.5
        for key in ("score", "visibility", "confidence"):
            if key in point:
                return _clamp(point.get(key), 0.0, 1.0)
        return 0.5

    core_scores = [_score(keypoints[i]) if i < len(keypoints) else 0.0
                   for i in (11, 12, 23, 24)]
    core_score_min = min(core_scores) if core_scores else 0.0
    core_score_median = float(np.median(core_scores)) if core_scores else 0.0
    core_valid_count = sum(score >= 0.15 for score in core_scores)
    reason = "ok"
    if len(keypoints) != 33:
        reason = f"expected_33_got_{len(keypoints)}"
    elif core_valid_count < 3 or core_score_median < 0.25:
        reason = "low_torso_confidence"
    elif shoulder_span < 0.025:
        reason = "shoulder_span"
    elif hip_span < 0.015:
        reason = "hip_span"
    elif torso_span < 0.035:
        reason = "torso_span"

    declared_space = str(payload.get("keypoints3d_space") or "").lower()
    already_body_space = any(token in declared_space for token in
                             ("world", "meter", "metre", "body", "camera", "hip"))

    raw_for_3d = source_3d if len(source_3d) == len(source_2d) else source_2d
    if raw_for_3d:
        left_hip = _pos(raw_for_3d[23]) if len(raw_for_3d) > 24 else {"x": 0, "y": 0, "z": 0}
        right_hip = _pos(raw_for_3d[24]) if len(raw_for_3d) > 24 else left_hip
        origin = {
            axis: (_float(left_hip.get(axis)) + _float(right_hip.get(axis))) * 0.5
            for axis in ("x", "y", "z")
        }
    else:
        origin = {"x": 0.0, "y": 0.0, "z": 0.0}

    reference_pixels = shoulder_span * height
    if reference_pixels < 1.0:
        reference_pixels = hip_span * height
    if reference_pixels < 1.0:
        reference_pixels = max(height * 0.18, 1.0)
    metres_per_pixel = _clamp(0.36 / reference_pixels, 0.0001, 0.05)

    keypoints3d = []
    for index, point in enumerate(raw_for_3d):
        position = _pos(point)
        if already_body_space:
            x = _float(position.get("x"))
            y = _float(position.get("y"))
            z = _float(position.get("z"))
        else:
            x = (_float(position.get("x")) - origin["x"]) * metres_per_pixel
            y = (_float(position.get("y")) - origin["y"]) * metres_per_pixel
            z = (_float(position.get("z")) - origin["z"]) * metres_per_pixel
        x = _clamp(x, -4.0, 4.0)
        y = _clamp(y, -4.0, 4.0)
        z = _clamp(z, -4.0, 4.0)
        score = _score(point)
        entry = dict(point) if isinstance(point, dict) else {}
        entry.update({"x": x, "y": y, "z": z, "score": score, "visibility": score})
        entry["position"] = {"x": x, "y": y, "z": z}
        keypoints3d.append(entry)

    def _normalise_group(group):
        return [_normalized_point(point) for point in (group or [])]

    face = payload.get("face")
    wire_face = None
    if isinstance(face, dict):
        wire_face = dict(face)
        wire_face["landmarks"] = _normalise_group(face.get("landmarks"))

    return {
        "keypoints": keypoints,
        "keypoints3D": keypoints3d,
        "keypoints2d_space": "normalized",
        "keypoints3d_space": declared_space if already_body_space else "body_relative",
        "geometry": {
            "valid": reason == "ok",
            "reason": reason,
            "core_score_min": core_score_min,
            "core_score_median": core_score_median,
            "core_valid_count": core_valid_count,
            "shoulder_span": shoulder_span,
            "hip_span": hip_span,
            "torso_span": torso_span,
            "max_abs_3d": max((max(abs(p["x"]), abs(p["y"]), abs(p["z"]))
                               for p in keypoints3d), default=0.0),
        },
        "face": wire_face,
        "leftHand": _normalise_group(payload.get("leftHand")),
        "rightHand": _normalise_group(payload.get("rightHand")),
    }
# ---------------------------------------------------------------------------
# Dispatcher: one object the server talks to regardless of backend family
# ---------------------------------------------------------------------------

class EngineDispatcher:
    """Single serialized lifecycle for ONNX/native engines.

    ``infer`` holds the same RLock used by ``load``/``unload``. A hot-swap waits
    for the current inference to finish and capture sees ready=False while the
    new model is built; no session can be destroyed under an active inference.
    """
    def __init__(self) -> None:
        self._onnx = MocapEngine()
        self._native_legacy = _native.HolisticLegacyEngine()
        self._native_tasks = _native.HolisticTasksEngine()
        self._active_native = None
        self._active_id: Optional[str] = None
        self._model_complexity = 1
        self._lifecycle_lock = threading.RLock()
        self._loading = False
        self._requested_id: Optional[str] = None
        self._last_error = ""
        self._generation = 0

    @property
    def ready(self) -> bool:
        if self._loading:
            return False
        if self._active_native is not None:
            return bool(self._active_native.ready)
        return bool(self._onnx.ready)

    @property
    def model_id(self) -> Optional[str]:
        return self._active_id or self._onnx.model_id

    @property
    def provider(self) -> Optional[str]:
        if self._active_native is not None:
            return f"Native/{self._active_native.name}"
        return self._onnx.provider

    def status(self) -> dict:
        if self._active_native is not None:
            st = {
                "ready": self.ready,
                "model": self._active_id,
                "provider": self.provider,
                "provider_human": self._active_native.name,
                "model_complexity": self._model_complexity,
                "last_error": getattr(self._active_native, "last_error", ""),
            }
        else:
            st = self._onnx.status()
            st["ready"] = self.ready
            st["model"] = self._active_id or st.get("model")
        provider = st.get("provider") or ""
        st.update({
            "loading": self._loading,
            "requested_model": self._requested_id,
            "generation": self._generation,
            "last_error": self._last_error or st.get("last_error", ""),
            "accelerated": bool(provider and "CPUExecutionProvider" not in provider),
        })
        return st

    def _unload_all(self) -> None:
        self._onnx.unload()
        if self._native_legacy.ready:
            self._native_legacy.unload()
        if self._native_tasks.ready:
            self._native_tasks.unload()
        self._active_native = None
        self._active_id = None
        gc.collect()

    def unload(self) -> None:
        with self._lifecycle_lock:
            self._loading = True
            self._requested_id = None
            try:
                self._unload_all()
                self._last_error = ""
                self._generation += 1
            finally:
                self._loading = False

    def load(self, model_id: str, model_complexity: Optional[int] = None) -> dict:
        with self._lifecycle_lock:
            if (model_id and model_id == self.model_id and self.ready and
                    (model_complexity is None or int(model_complexity) == self._model_complexity)):
                return {"ok": True, "unchanged": True, **self.status()}

            self._loading = True
            self._requested_id = model_id
            self._last_error = ""
            try:
                if not model_id or model_id == registry.MEDIAPIPE_ID:
                    self._unload_all()
                    self._generation += 1
                    return {"ok": True, **self.status()}

                spec = registry.REGISTRY.get(model_id)
                if not spec:
                    raise ValueError(f"Unknown backend: {model_id}")
                if not registry.is_installed(model_id):
                    self._unload_all()
                    return {"ok": False, "error": "backend not installed",
                            "needs_download": True, "model": model_id}

                self._unload_all()
                if spec.get("engine") == "native-mediapipe":
                    engine_name = spec.get("native_engine")
                    if engine_name == "holistic-legacy":
                        if model_complexity is not None:
                            self._model_complexity = int(model_complexity)
                        elif spec.get("model_complexity") is not None:
                            self._model_complexity = int(spec["model_complexity"])
                        result = self._native_legacy.load(self._model_complexity)
                        candidate = self._native_legacy
                    elif engine_name == "holistic-tasks":
                        result = self._native_tasks.load()
                        candidate = self._native_tasks
                    else:
                        raise ValueError(f"unknown native engine {engine_name}")
                    if not result.get("ok"):
                        self._last_error = str(result.get("error") or "native load failed")
                        return result
                    self._active_native = candidate
                    self._active_id = model_id
                else:
                    result = self._onnx.load(model_id)
                    if not result.get("ok"):
                        self._last_error = str(result.get("error") or "ONNX load failed")
                        return result
                    self._active_native = None
                    self._active_id = model_id
                    require_gpu = os.environ.get("XRA_REQUIRE_GPU", "0").lower() in {"1", "true", "yes", "on"}
                    if require_gpu and self.provider == "CPUExecutionProvider":
                        self._unload_all()
                        self._last_error = (
                            "XRA_REQUIRE_GPU=1 but ONNX Runtime bound CPUExecutionProvider. "
                            "Install/configure onnxruntime-gpu and its CUDA/cuDNN libraries."
                        )
                        return {"ok": False, "error": self._last_error, "model": model_id}

                self._generation += 1
                return {"ok": True, **self.status()}
            except Exception as exc:
                self._last_error = str(exc)
                self._unload_all()
                return {"ok": False, "error": self._last_error, "model": model_id}
            finally:
                self._loading = False
                self._requested_id = None

    def infer(self, frame_bgr: np.ndarray) -> Optional[dict]:
        with self._lifecycle_lock:
            if self._loading:
                return None
            if self._active_native is not None:
                return self._active_native.infer(frame_bgr)
            return self._onnx.infer(frame_bgr)
ENGINE = EngineDispatcher()
