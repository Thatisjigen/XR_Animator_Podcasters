"""Lightweight, asynchronous object detector for webcam props.

Uses MediaPipe Tasks ObjectDetector with lazy loading and throttled execution
(1-5 Hz) to limit contention with mocap. Maps detected real-world objects
(e.g., cell phone, cup, bottle, book) to user hands based on proximity to wrist/hand
landmarks.
"""

from __future__ import annotations

import logging
import os
import queue
import threading
import time
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from . import registry

TAG = "[XRA_OBJ_DETECT]"

# Classes commonly used as 3D props in desktop/streaming setups
DEFAULT_PROP_CLASSES = {
    "cell phone",
    "cup",
    "bottle",
    "wine glass",
    "book",
    "laptop",
    "mouse",
    "scissors",
    "apple",
    "banana",
}


class ObjectDetectorWorker:
    """Asynchronous, lazy-loaded object detector running in a background thread."""

    def __init__(self, callback: Optional[Callable[[dict], None]] = None) -> None:
        self.callback = callback
        self.enabled = False
        self.min_score = 0.45
        self.interval_ms = 350.0  # ~3 FPS; asynchronous, but still consumes CPU
        self.allowed_classes = set(DEFAULT_PROP_CLASSES)

        self._detector = None
        self._thread: Optional[threading.Thread] = None
        self._queue: queue.Queue = queue.Queue(maxsize=1)
        self._running = False
        self._last_detect_time = 0.0
        self._lock = threading.Lock()

    def set_enabled(self, enabled: bool) -> bool:
        with self._lock:
            if self.enabled == enabled:
                return self.enabled
            self.enabled = enabled
            if self.enabled:
                self._start()
            else:
                self._stop()
            return self.enabled

    def configure(
        self,
        min_score: Optional[float] = None,
        interval_ms: Optional[float] = None,
        allowed_classes: Optional[list[str]] = None,
    ) -> dict:
        with self._lock:
            if min_score is not None:
                self.min_score = max(0.1, min(0.95, float(min_score)))
            if interval_ms is not None:
                self.interval_ms = max(100.0, min(2000.0, float(interval_ms)))
            if allowed_classes is not None:
                self.allowed_classes = set(allowed_classes)
        return {
            "enabled": self.enabled,
            "min_score": self.min_score,
            "interval_ms": self.interval_ms,
            "allowed_classes": list(self.allowed_classes),
        }

    def _get_model_path(self) -> Optional[Path]:
        model_dir = registry.model_dir(registry.MEDIAPIPE_TASKS_ID)
        candidate = model_dir / "efficientdet_lite0.tflite"
        if candidate.is_file():
            return candidate
        # Also check root models dir
        candidate = registry.MODELS_DIR / "efficientdet_lite0.tflite"
        if candidate.is_file():
            return candidate
        return None

    def _init_detector(self) -> bool:
        if self._detector is not None:
            return True
        model_path = self._get_model_path()
        if not model_path:
            print(f"{TAG} efficientdet_lite0.tflite not found, object detection unavailable", flush=True)
            return False
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision

            base_options = mp_python.BaseOptions(
                model_asset_path=str(model_path),
                delegate=mp_python.BaseOptions.Delegate.CPU,
            )
            options = vision.ObjectDetectorOptions(
                base_options=base_options,
                running_mode=vision.RunningMode.IMAGE,
                max_results=5,
                # Keep the graph threshold low and apply the live UI threshold
                # below. MediaPipe options are immutable after construction;
                # using self.min_score here made lowering the slider ineffective
                # until the detector was disabled and loaded again.
                score_threshold=0.1,
            )
            self._detector = vision.ObjectDetector.create_from_options(options)
            print(f"{TAG} ObjectDetector initialized successfully from {model_path.name}", flush=True)
            return True
        except Exception as exc:
            print(f"{TAG} Failed to initialize ObjectDetector: {exc}", flush=True)
            self._detector = None
            return False

    def _start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._worker_loop, daemon=True, name="xra-object-detector")
        self._thread.start()

    def _stop(self) -> None:
        self._running = False
        try:
            self._queue.put_nowait(None)
        except Exception:
            pass
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        self._thread = None
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
        if self._detector is not None:
            try:
                self._detector.close()
            except Exception:
                pass
            self._detector = None
        print(f"{TAG} Object detector stopped and resources released", flush=True)

    def submit(self, frame_rgb: np.ndarray, hands_info: Optional[dict] = None) -> bool:
        """Submit a frame for detection.

        Drops the frame immediately if disabled, throttled, or busy.
        """
        if not self.enabled or not self._running:
            return False

        now = time.monotonic() * 1000.0
        if now - self._last_detect_time < self.interval_ms:
            return False  # Throttled

        # Pass a copy to avoid threading race on underlying buffer
        try:
            self._queue.put_nowait((frame_rgb.copy(), hands_info, now))
            self._last_detect_time = now
            return True
        except queue.Full:
            return False

    def _worker_loop(self) -> None:
        if not self._init_detector():
            self._running = False
            return

        import mediapipe as mp

        while self._running:
            try:
                item = self._queue.get(timeout=1.0)
                if item is None:
                    break
                frame_rgb, hands_info, submit_time = item
                h, w = frame_rgb.shape[:2]
                if h <= 0 or w <= 0:
                    continue

                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)
                detection_result = self._detector.detect(mp_image)

                # Disabling can race with an inference already running.  Never
                # publish its stale result after OFF has been acknowledged.
                if not self.enabled or not self._running:
                    continue

                detections = []
                for det in detection_result.detections:
                    if not det.categories:
                        continue
                    top_cat = det.categories[0]
                    category_name = (top_cat.category_name or "").lower()
                    score = float(top_cat.score)

                    if self.allowed_classes and category_name not in self.allowed_classes:
                        continue
                    if score < self.min_score:
                        continue

                    bbox = det.bounding_box
                    norm_bbox = [
                        round(bbox.origin_x / w, 4),
                        round(bbox.origin_y / h, 4),
                        round(bbox.width / w, 4),
                        round(bbox.height / h, 4),
                    ]
                    center_x = (bbox.origin_x + bbox.width / 2.0) / w
                    center_y = (bbox.origin_y + bbox.height / 2.0) / h

                    # Determine hand proximity if hand landmarks are available
                    assigned_hand = None
                    if hands_info:
                        min_dist = 0.35  # Threshold in normalized screen distance
                        for hand_side in ("right", "left"):
                            wrist = hands_info.get(f"{hand_side}_wrist")
                            if wrist:
                                wx, wy = wrist[0], wrist[1]
                                dist = np.hypot(center_x - wx, center_y - wy)
                                if dist < min_dist:
                                    min_dist = dist
                                    assigned_hand = hand_side

                    detections.append({
                        "category": category_name,
                        "score": round(score, 3),
                        "bbox": norm_bbox,
                        "hand": assigned_hand,
                    })

                payload = {
                    "type": "object_detection",
                    "detections": detections,
                    "timestamp": round(submit_time, 2),
                }

                if self.callback:
                    try:
                        self.callback(payload)
                    except Exception as e:
                        print(f"{TAG} Callback error: {e}", flush=True)

            except queue.Empty:
                continue
            except Exception as exc:
                print(f"{TAG} Worker detection error: {exc}", flush=True)

        if self._detector is not None:
            try:
                self._detector.close()
            except Exception:
                pass
            self._detector = None
