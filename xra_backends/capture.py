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


def _pin_thread_to_physical_cores(enabled: bool = True) -> None:
    """Pin the calling thread to physical high-performance cores (Linux only).

    - If enabled is True: pins to high-performance P-cores (or physical cores on non-hybrid CPUs).
    - If enabled is False: resets affinity to all online logical CPUs (OS default).
    - Fails silently on non-Linux, containers, or restricted environments.
    """
    try:
        import os
        if not hasattr(os, "sched_setaffinity"):
            return
        if not enabled:
            all_cpus = set(range(os.cpu_count() or 1))
            os.sched_setaffinity(0, all_cpus)
            return

        import glob
        import re

        raw_paths = glob.glob("/sys/devices/system/cpu/cpu[0-9]*/topology/core_id")
        if not raw_paths:
            return

        def _cpu_num(p: str) -> int:
            m = re.search(r"/cpu(\d+)/", p)
            return int(m.group(1)) if m else -1

        cpu_dirs = sorted(raw_paths, key=_cpu_num)

        # Map each CPU to its max hardware frequency
        cpu_freqs = {}
        for p in cpu_dirs:
            cpu = _cpu_num(p)
            freq_path = f"/sys/devices/system/cpu/cpu{cpu}/cpufreq/cpuinfo_max_freq"
            try:
                with open(freq_path, "r") as f:
                    cpu_freqs[cpu] = int(f.read().strip())
            except Exception:
                cpu_freqs[cpu] = 0

        max_freq = max(cpu_freqs.values()) if cpu_freqs else 0
        seen: dict = {}
        target_cpus: list = []

        for path in cpu_dirs:
            try:
                logical = _cpu_num(path)
                with open(path, "r") as f:
                    core_id = int(f.read().strip())

                pkg_path = path.replace("core_id", "physical_package_id")
                try:
                    with open(pkg_path, "r") as f:
                        pkg_id = int(f.read().strip())
                except Exception:
                    pkg_id = 0

                key = (pkg_id, core_id)
                if key not in seen:
                    seen[key] = logical
                    freq = cpu_freqs.get(logical, 0)
                    # On hybrid CPUs (e.g. 13900H / Core Ultra), exclude E-cores (<85% max clock)
                    if max_freq > 0 and freq > 0 and freq < (max_freq * 0.85):
                        continue
                    target_cpus.append(logical)
            except Exception:
                continue

        # Fall back to all physical cores if filter left fewer than 2
        if len(target_cpus) < 2:
            target_cpus = list(seen.values())

        if len(target_cpus) >= 2:
            os.sched_setaffinity(0, set(target_cpus))
    except Exception:
        pass


_DEFAULT_WIDTH = 384
_DEFAULT_HEIGHT = 216
_DEFAULT_FPS = 30.0
_DEFAULT_DEVICE = os.environ.get("XRA_CAMERA_DEVICE", "/dev/video0")


# Acquisition follows the resolution selected in the UI. Keep only a generous
# safety ceiling here; inference has its own lower geometry cap below.
_MAX_CAPTURE_WIDTH = int(os.environ.get("XRA_MAX_CAPTURE_WIDTH", "1920"))
_MAX_CAPTURE_HEIGHT = int(os.environ.get("XRA_MAX_CAPTURE_HEIGHT", "1080"))
# Default inference geometry: 640x480 (scales 720p/1080p to 640x360) cuts CPU inference time
# from ~50ms to ~20ms, preventing fan revving and CPU core saturation.
_MAX_INFER_WIDTH = int(os.environ.get("XRA_MAX_INFER_WIDTH", "640"))
_MAX_INFER_HEIGHT = int(os.environ.get("XRA_MAX_INFER_HEIGHT", "480"))
try:
    # Overhead headroom for inference throttling. Default is 1.0 (unconstrained up to target FPS).
    # Power users can override it explicitly via XRA_INFERENCE_HEADROOM (e.g. 1.25).
    _INFERENCE_HEADROOM = max(1.0, min(3.0, float(os.environ.get("XRA_INFERENCE_HEADROOM", "1.0"))))
except (TypeError, ValueError):
    _INFERENCE_HEADROOM = 1.0


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

def _optimize_v4l2_device(device_spec: str) -> None:
    """Safely disable dynamic framerate throttling on Linux V4L2 webcams.

    Many USB webcams default to exposure_dynamic_framerate=1, which halves
    the sensor framerate from 30 to 15 FPS in standard indoor lighting.
    Setting it to 0 forces the hardware sensor to maintain the negotiated 30 FPS.

    Gracefully no-ops on Windows/macOS or if v4l2-ctl is unavailable.
    """
    import sys
    if not sys.platform.startswith("linux"):
        return
    dev_str = str(device_spec or "").strip()
    if dev_str.isdigit():
        dev_str = f"/dev/video{dev_str}"
    elif not dev_str.startswith("/dev/video"):
        return
    try:
        v4l2_ctl = shutil.which("v4l2-ctl")
        if not v4l2_ctl:
            return
        subprocess.run(
            [v4l2_ctl, "-d", dev_str, "-c", "exposure_dynamic_framerate=0"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=0.6,
            check=False,
        )
    except Exception:
        pass


def check_camera_in_use(device_path: str = "/dev/video0") -> dict:
    """Check if the camera device is currently held open by another process."""
    import sys
    if not sys.platform.startswith("linux"):
        return {"busy": False, "pids": [], "processes": []}

    dev = str(device_path or "/dev/video0")
    if dev.isdigit():
        dev = f"/dev/video{dev}"

    if not os.path.exists(dev):
        return {"busy": False, "pids": [], "processes": []}

    my_pid = os.getpid()
    busy_pids: list[int] = []
    # 1. Try fuser
    try:
        fuser_bin = shutil.which("fuser") or "/usr/sbin/fuser"
        if os.path.exists(fuser_bin):
            proc = subprocess.run([fuser_bin, dev], capture_output=True, text=True, timeout=1.0)
            raw = (proc.stdout + " " + proc.stderr).strip()
            for token in raw.split():
                if token.isdigit():
                    pid = int(token)
                    if pid != my_pid and pid not in busy_pids:
                        busy_pids.append(pid)
    except Exception:
        pass

    # 2. Fallback to lsof if fuser didn't find any external PIDs
    if not busy_pids:
        try:
            lsof_bin = shutil.which("lsof") or "/usr/sbin/lsof"
            if os.path.exists(lsof_bin):
                proc = subprocess.run([lsof_bin, "-t", dev], capture_output=True, text=True, timeout=1.0)
                raw = proc.stdout.strip()
                for token in raw.split():
                    if token.isdigit():
                        pid = int(token)
                        if pid != my_pid and pid not in busy_pids:
                            busy_pids.append(pid)
        except Exception:
            pass

    proc_names: list[str] = []
    for pid in busy_pids:
        name = ""
        try:
            with open(f"/proc/{pid}/comm", "r", encoding="utf-8") as f:
                name = f.read().strip()
        except Exception:
            pass
        if not name:
            try:
                with open(f"/proc/{pid}/cmdline", "r", encoding="utf-8") as f:
                    cmd = f.read().split("\0")[0]
                    name = os.path.basename(cmd)
            except Exception:
                pass
        if name and name not in proc_names:
            proc_names.append(name)

    return {
        "busy": bool(busy_pids),
        "pids": busy_pids,
        "processes": proc_names,
    }


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
        # Background asynchronous grabber (Producer-Consumer)
        self._grab_thread: Optional[threading.Thread] = None
        self._grab_stop = threading.Event()
        self._frame_lock = threading.Lock()
        self._latest_frame: Optional[np.ndarray] = None
        self._new_frame_event = threading.Event()

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
            busy_info = check_camera_in_use(self.device)
            if busy_info.get("busy"):
                procs = ", ".join(busy_info["processes"]) or "un'altra applicazione"
                self.last_error = f"Webcam occupata da: {procs}. Chiudila per avviare il tracking."
            else:
                self.last_error = f"camera open failed ({self.device}): {exc}"
            try:
                cap.release()
            except Exception:
                pass
            return False
        if not opened or not cap.isOpened():
            busy_info = check_camera_in_use(self.device)
            if busy_info.get("busy"):
                procs = ", ".join(busy_info["processes"]) or "un'altra applicazione"
                self.last_error = f"Webcam occupata da: {procs}. Chiudila per avviare il tracking."
            else:
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
        if sys.platform.startswith("linux"):
            _optimize_v4l2_device(self.device)
            try:
                cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            except Exception:
                pass
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

        # Launch background grabber thread to decouple camera wait time from inference
        self._grab_stop.clear()
        self._latest_frame = None
        self._new_frame_event.clear()
        self._grab_thread = threading.Thread(
            target=self._grab_loop, name="xra-v4l2-grab", daemon=True
        )
        self._grab_thread.start()
        return True

    def _grab_loop(self) -> None:
        cap = self._cap
        if cap is None:
            return
        failures = 0
        while not self._grab_stop.is_set():
            try:
                ok, frame = cap.read()
            except Exception as exc:
                ok, frame = False, None
                self.last_error = f"grabber read exception: {exc}"

            if ok and frame is not None:
                failures = 0
                with self._frame_lock:
                    self._latest_frame = frame
                self._new_frame_event.set()
            else:
                failures += 1
                if failures >= 10:
                    self.last_error = "camera disconnected or read failure"
                    self._grab_stop.wait(0.05)
                else:
                    self._grab_stop.wait(0.005)

    def read(self, timeout: Optional[float] = None) -> Optional[np.ndarray]:
        if not self._ensure():
            return None
        if timeout is None:
            # If waiting for the first frame of a camera session, allow up to
            # 2.5s for V4L2/USB hardware endpoint negotiation and auto-exposure.
            if self._latest_frame is None:
                timeout = 2.5
            else:
                timeout = max(0.04, 1.2 / max(1.0, self.fps))
        # Wait for a fresh frame from the background grabber (0ms if already waiting)
        if self._new_frame_event.wait(timeout=timeout):
            with self._frame_lock:
                self._new_frame_event.clear()
                return self._latest_frame
        with self._frame_lock:
            return self._latest_frame

    def release(self) -> None:
        self._grab_stop.set()
        grab_thread, self._grab_thread = self._grab_thread, None
        if grab_thread is not None and grab_thread.is_alive() and grab_thread is not threading.current_thread():
            try:
                grab_thread.join(timeout=1.0)
            except Exception:
                pass
        cap, self._cap = self._cap, None
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass
        with self._frame_lock:
            self._latest_frame = None
        self._new_frame_event.clear()


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



_PROBED_HARDWARE_INFO = {}

def probe_hardware_info(device_path: str = "/dev/video0") -> dict:
    cache_key = str(device_path or "/dev/video0")
    if cache_key in _PROBED_HARDWARE_INFO:
        return _PROBED_HARDWARE_INFO[cache_key]

    # 1. Probe GPUs via sysfs DRM cards
    gpus = []
    try:
        import glob
        cards = sorted(glob.glob('/sys/class/drm/card[0-9]'))
        for c in cards:
            dev_dir = os.path.realpath(os.path.join(c, 'device'))
            vendor_file = os.path.join(dev_dir, 'vendor')
            dev_file = os.path.join(dev_dir, 'device')
            if not os.path.exists(vendor_file):
                continue
            with open(vendor_file, encoding="ascii") as vendor_stream:
                vendor = vendor_stream.read().strip().lower()
            if os.path.exists(dev_file):
                with open(dev_file, encoding="ascii") as device_stream:
                    dev_id = device_stream.read().strip().lower()
            else:
                dev_id = ''
            card_name = os.path.basename(c)

            if '0x10de' in vendor:
                name = 'NVIDIA Dedicated (RTX)'
                is_dedicated = True
                gpu_id = 'high-performance'
            elif '0x8086' in vendor:
                name = 'Intel Graphics (Integrata)'
                is_dedicated = False
                gpu_id = 'low-power'
            elif '0x1002' in vendor:
                name = 'AMD Radeon'
                is_dedicated = True
                gpu_id = 'high-performance'
            else:
                name = f'GPU ({vendor}:{dev_id})'
                is_dedicated = False
                gpu_id = card_name

            gpus.append({
                'id': gpu_id,
                'name': name,
                'vendor': vendor,
                'device': dev_id,
                'is_dedicated': is_dedicated,
                'card': card_name
            })
    except Exception:
        gpus = [{'id': 'default', 'name': 'GPU Sistema', 'is_dedicated': False}]

    # 2. Probe Webcam formats & max FPS via v4l2-ctl
    resolutions = []
    max_fps = 30
    try:
        import subprocess, re
        cmd = ['v4l2-ctl', '--list-formats-ext', '-d', device_path]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1.5)
        out = proc.stdout or ''
        sizes = set(re.findall(r'Size:\s*Discrete\s*(\d+)x(\d+)', out))
        for w, h in sorted(((int(x), int(y)) for x, y in sizes), key=lambda s: s[0]*s[1]):
            resolutions.append([w, h])
        fps_matches = [float(f) for f in re.findall(r'\((\d+(?:\.\d+)?)\s*fps\)', out)]
        if fps_matches:
            max_fps = int(round(max(fps_matches)))
    except Exception:
        pass

    if not resolutions:
        resolutions = [[424, 240], [640, 360], [640, 480], [1280, 720]]
    resolutions.sort(key=lambda s: s[0]*s[1])

    result = {
        'gpus': gpus,
        'camera': {
            'supported_resolutions': resolutions,
            'max_hardware_fps': max(15, min(max_fps, 120))
        }
    }
    _PROBED_HARDWARE_INFO[cache_key] = result
    return result


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
        self._infer_ms_ema = 0.0
        self._last_work_ms = 0.0
        self._work_ms_ema = 0.0
        self._last_capture_ms = 0.0
        self._last_raw_geometry = (0, 0)
        self._last_inference_geometry = (0, 0)
        self._infer_width: Optional[int] = None
        self._infer_height: Optional[int] = None
        self._infer_mode: str = "native"
        self._stabilizer_model = None
        self._body_last_good = [None] * 33
        self._body_last_good_at = [0.0] * 33
        self._hand_last_good = {"leftHand": None, "rightHand": None}
        self._hand_last_good_at = {"leftHand": 0.0, "rightHand": 0.0}
        self._held_joints = 0
        self._dropped_hands = 0
        self._phantom_counter = 0
        self._last_unstick_at = 0.0
        self._last_landmark_stats = {}
        self._last_frame_log_at = 0.0
        self._last_log_geometry_reason = None
        self._rate_window_at = time.monotonic()
        self._rate_window_frames = 0
        self._measured_fps = 0.0
        self._deadline_misses = 0
        self._selfie_mode = False
        self._mocap_mode = "holistic"
        self._arm_steady_hold: bool = os.environ.get("XRA_ARM_STEADY_HOLD", "0") in {"1", "true", "yes", "on"}
        self._desk_wrist_guard: bool = os.environ.get("XRA_DESK_WRIST_GUARD", "1") not in {"0", "false", "no", "off"}
        self._last_busy_check_at: float = 0.0
        self._last_busy_info: dict = {"busy": False, "pids": [], "processes": []}
        self._smart_arm_sync: bool = os.environ.get("XRA_SMART_ARM_SYNC", "1") not in {"0", "false", "no", "off"}
        engine.ENGINE._smart_arm_sync = self._smart_arm_sync
        engine.ENGINE._desk_wrist_guard = self._desk_wrist_guard
        # Adaptive frame skip: when True, skips MediaPipe inference for 1 frame
        # after a deadline miss, sending cached pose to prevent latency pileup.
        self._adaptive_frame_skip: bool = os.environ.get("XRA_ADAPTIVE_FRAME_SKIP", "0") in {"1", "true", "yes", "on"}
        self._cpu_affinity: bool = True
        self._last_wire: Optional[dict] = None
        # Set when infer_mode/dimensions change while the engine is already running.
        # _run_inference will reload ENGINE before the next inference to avoid
        # the MediaPipe graph dimension-mismatch freeze.
        self._needs_engine_reload: bool = False
        # Geometry (w, h) that was in effect when the landmarker was last (re)loaded.
        self._committed_infer_geometry: tuple = (0, 0)

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
            self._rate_window_at = time.monotonic()
            self._rate_window_frames = 0
            self._measured_fps = 0.0
            self._deadline_misses = 0
            self._last_infer_ms = 0.0
            self._infer_ms_ema = 0.0
            self._last_work_ms = 0.0
            self._work_ms_ema = 0.0
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

    def configure(self, *, index=None, device=None, width=None, height=None, fps=None, selfie_mode=None, mocap_mode=None, infer_width=None, infer_height=None, infer_mode=None, arm_steady_hold=None, smart_arm_sync=None, desk_wrist_guard=None, adaptive_frame_skip=None, cpu_affinity=None) -> dict:
        requested_mode = None
        previous_mode = None
        needs_reopen = False
        if device is None and index is not None:
            try:
                index = int(index)
                import sys
                device = f"/dev/video{index}" if sys.platform.startswith("linux") else str(index)
            except Exception:
                device = str(index)
        with self._lock:
            if cpu_affinity is not None:
                self._cpu_affinity = bool(cpu_affinity)
                _pin_thread_to_physical_cores(self._cpu_affinity)
            if adaptive_frame_skip is not None:
                self._adaptive_frame_skip = bool(adaptive_frame_skip)
            if smart_arm_sync is not None:
                self._smart_arm_sync = bool(smart_arm_sync)
                engine.ENGINE._smart_arm_sync = self._smart_arm_sync
            if desk_wrist_guard is not None:
                self._desk_wrist_guard = bool(desk_wrist_guard)
                engine.ENGINE._desk_wrist_guard = self._desk_wrist_guard
            if arm_steady_hold is not None:
                self._arm_steady_hold = bool(arm_steady_hold)
            if index is not None and getattr(self, "_index", None) != int(index):
                self._index = int(index)
                needs_reopen = True
            if device is not None and self._device != str(device):
                self._device = str(device)
                needs_reopen = True
            if selfie_mode is not None:
                self._selfie_mode = bool(selfie_mode)
            if mocap_mode is not None:
                requested_mode = "face" if str(mocap_mode).strip().lower() == "face" else "holistic"
                previous_mode = self._mocap_mode
                self._mocap_mode = requested_mode

            if infer_mode is not None:
                inf_m = str(infer_mode).strip().lower()
                if inf_m == "native":
                    if self._infer_mode != "native" or self._infer_width is not None:
                        self._infer_mode = "native"
                        self._infer_width = None
                        self._infer_height = None
                        self._needs_engine_reload = True
                else:
                    if self._infer_mode != inf_m:
                        self._infer_mode = inf_m
                        self._needs_engine_reload = True
            if infer_width is not None and infer_height is not None:
                try:
                    iw = int(infer_width)
                    ih = int(infer_height)
                    if iw > 0 and ih > 0:
                        if self._infer_width != iw or self._infer_height != ih:
                            self._infer_width = iw
                            self._infer_height = ih
                            self._infer_mode = f"{iw}x{ih}"
                            self._needs_engine_reload = True
                except Exception:
                    pass

            if width is not None or height is not None:
                next_width = self._width if width is None else max(160, int(width))
                next_height = self._height if height is None else max(120, int(height))
                bound = min(
                    1.0,
                    _MAX_CAPTURE_WIDTH / max(1, next_width),
                    _MAX_CAPTURE_HEIGHT / max(1, next_height),
                )
                target_w = max(160, int(round(next_width * bound)))
                target_h = max(120, int(round(next_height * bound)))
                if target_w != self._width or target_h != self._height:
                    self._width = target_w
                    self._height = target_h
                    needs_reopen = True
                    self._needs_engine_reload = True
            if fps is not None:
                tfps = max(1.0, min(30.0, float(fps)))
                if abs(tfps - self._target_fps) > 0.5:
                    self._target_fps = tfps
                    needs_reopen = True

        if requested_mode is not None:
            mode_result = engine.ENGINE.configure_mode(requested_mode)
            if not mode_result.get("ok"):
                with self._lock:
                    self._mocap_mode = previous_mode or "holistic"
                raise RuntimeError(mode_result.get("error") or "mocap mode switch failed")
        if needs_reopen:
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

    def camera_busy_info(self) -> dict:
        if self._grabber is not None and not self._paused.is_set():
            return {"busy": False, "pids": [], "processes": []}
        now = time.monotonic()
        if now - self._last_busy_check_at < 1.5:
            return self._last_busy_info
        self._last_busy_check_at = now
        self._last_busy_info = check_camera_in_use(self._device or "/dev/video0")
        return self._last_busy_info

    def status(self) -> dict:
        with self._lock:
            count = len(self._subscribers)
            busy_info = self.camera_busy_info()
            return {
                "running": self._running and not self._stop.is_set(),
                "paused": self._paused.is_set(),
                "available": self._available,
                "camera_open": self._grabber is not None and not self._paused.is_set(),
                "camera_busy": bool(busy_info.get("busy", False)),
                "busy_processes": list(busy_info.get("processes", [])),
                "busy_process": str(busy_info.get("processes", [""])[0] if busy_info.get("processes") else ""),
                "publishing": (
                    self._running
                    and not self._paused.is_set()
                    and self._grabber is not None
                    and count > 0
                    and engine.ENGINE.ready
                ),
                "device": self._device,
                "selfie_mode": self._selfie_mode,
                "mocap_mode": self._mocap_mode,
                "backend": getattr(self._grabber, "name", None),
                "geometry": [self._width, self._height],
                "infer_mode": self._infer_mode,
                "infer_geometry": [self._infer_width, self._infer_height] if self._infer_width and self._infer_height else "native",
                "capture_geometry": list(self._last_raw_geometry),
                "inference_geometry": list(self._last_inference_geometry),
                "effective_fps": self._effective_fps(),
                "measured_fps": round(self._measured_fps if (time.monotonic() - self._rate_window_at) < 3.0 else 0.0, 2),
                "deadline_misses": self._deadline_misses,
                "held_joints": self._held_joints,
                "dropped_hands": self._dropped_hands,
                "landmarks": copy.deepcopy(self._last_landmark_stats),
                "target_fps": self._target_fps,
                "subscribers": count,
                "frames": self._frames,
                "last_infer_ms": self._last_infer_ms,
                "inference_ema_ms": round(self._infer_ms_ema, 3),
                "processing_ema_ms": round(self._work_ms_ema, 3),
                "inference_headroom": _INFERENCE_HEADROOM,
                "last_capture_ms": self._last_capture_ms,
                "last_frame_age_ms": (
                    round((time.time() - self._last_frame_at) * 1000.0, 1)
                    if self._last_frame_at else None
                ),
                "last_error": self._last_error,
                "arm_steady_hold": self._arm_steady_hold,
                "smart_arm_sync": self._smart_arm_sync,
                "desk_wrist_guard": self._desk_wrist_guard,
                "adaptive_frame_skip": self._adaptive_frame_skip,
                "cpu_affinity": self._cpu_affinity,
                "hardware": probe_hardware_info(self._device or "/dev/video0"),
            }

    def _loop(self) -> None:
        # Pin this thread to high-performance cores to reduce HT jitter and E-core latency spikes.
        # No-op on non-Linux / containers / when permissions are insufficient.
        _pin_thread_to_physical_cores(self._cpu_affinity)
        grabber = None
        failures = 0
        last_missed_deadline = False
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
                        self._stop.wait(0.12)
                    # After a camera reopen (resolution/device change), force the
                    # engine to reload so MediaPipe's input geometry is reset.
                    # We set the flag here rather than waiting for _run_inference
                    # because the first read() after reopen often returns None on
                    # V4L2 (format renegotiation), which would skip _run_inference
                    # entirely and leave the engine running with the old geometry.
                    self._needs_engine_reload = True

                if not engine.ENGINE.ready:
                    # Auto-recover if engine lost ready state (e.g. model reloaded or dimension switch)
                    try:
                        active_id = getattr(engine.ENGINE, "active_id", None) or getattr(
                            registry, "MEDIAPIPE_TASKS_ID", "mediapipe-tasks-landmarker"
                        )
                        engine.ENGINE.load(active_id, force=True)
                    except Exception:
                        pass
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
                    self._available = True

                # Keep the device open, but do not run inference when no pose
                # client is listening. The worker subscription wakes this loop.
                if self.subscriber_count == 0:
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
                    if failures >= 15:
                        self._release_camera(); grabber = None; failures = 0
                        self._stop.wait(0.5)
                    else:
                        self._stop.wait(0.04)
                    continue

                failures = 0
                self._available = True
                self._last_error = ""
                # XR Animator's mocap solver works on raw (non-mirrored) frames.
                # Webcam hardware produces non-mirrored frames (camera/audience convention).
                # When selfie_mode is true the user wants a mirror view: flip the frame horizontally
                # so the avatar follows the mirror convention (raise right hand → avatar right hand up).
                # When selfie_mode is false keep the raw frame for direct/audience view.
                if self._selfie_mode:
                    try:
                        import cv2
                        frame = cv2.flip(frame, 1)
                    except Exception:
                        frame = np.ascontiguousarray(frame[:, ::-1, :])

                # Optional adaptive frame skip: if previous frame missed deadline,
                # skip heavy MediaPipe inference once and dispatch the cached wireframe
                # to allow the CPU/pipeline to recover without freezing avatar movement.
                if self._adaptive_frame_skip and last_missed_deadline and self._last_wire is not None:
                    self._dispatch_cached_wire()
                    last_missed_deadline = False
                else:
                    self._run_inference(frame)

                self._last_work_ms = (time.perf_counter() - loop_started) * 1000.0
                if self._work_ms_ema <= 0.0:
                    self._work_ms_ema = self._last_work_ms
                else:
                    self._work_ms_ema += 0.25 * (self._last_work_ms - self._work_ms_ema)
                eff_fps = self._effective_fps()
                interval = 1.0 / max(1.0, eff_fps)
                elapsed = time.perf_counter() - loop_started
                slack = interval - elapsed
                # If target/effective FPS is close to camera hardware rate (>= 27.5 Hz),
                # the background grabber thread already paces frames at hardware speed.
                # Sleeping extra slack causes double-pacing and drops framerate to ~15 fps.
                if eff_fps >= 27.5:
                    if elapsed > (interval + 0.008):
                        self._deadline_misses += 1
                        last_missed_deadline = True
                    else:
                        last_missed_deadline = False
                    # grabber.read() at top of loop already blocks cooperatively on the new-frame event
                else:
                    if slack > 0.001:
                        self._stop.wait(slack)
                        last_missed_deadline = False
                    else:
                        self._stop.wait(0.001)
                        if elapsed > (interval + 0.005):
                            self._deadline_misses += 1
                            last_missed_deadline = True
                        else:
                            last_missed_deadline = False
        finally:
            self._release_camera()
            with self._lock:
                self._running = False
                self._thread = None

    def _effective_fps(self) -> float:
        with self._lock:
            target = max(1.0, min(30.0, float(self._target_fps)))
            if self._infer_ms_ema > 0.0 and _INFERENCE_HEADROOM > 1.0:
                sustainable = 1000.0 / (self._infer_ms_ema * _INFERENCE_HEADROOM)
                target = min(target, sustainable)
            elif self._infer_ms_ema > 0.0:
                sustainable = 1000.0 / self._infer_ms_ema
                target = min(target, sustainable)
            return max(1.0, target)
    def _prepare_inference_frame(self, frame: np.ndarray) -> np.ndarray:
        raw_h, raw_w = frame.shape[:2]
        self._last_raw_geometry = (int(raw_w), int(raw_h))

        infer_mode = getattr(self, "_infer_mode", "native")
        if infer_mode == "native":
            self._last_inference_geometry = (int(raw_w), int(raw_h))
            return frame

        infer_w = getattr(self, "_infer_width", None)
        infer_h = getattr(self, "_infer_height", None)
        if infer_w is not None and infer_h is not None and infer_w > 0 and infer_h > 0:
            target_w = int(infer_w)
            target_h = int(infer_h)
        else:
            scale = min(
                1.0,
                _MAX_INFER_WIDTH / max(1, raw_w),
                _MAX_INFER_HEIGHT / max(1, raw_h),
            )
            if scale >= 0.999:
                self._last_inference_geometry = (int(raw_w), int(raw_h))
                return frame
            target_w = max(2, int(round(raw_w * scale)))
            target_h = max(2, int(round(raw_h * scale)))

        if raw_w == target_w and raw_h == target_h:
            self._last_inference_geometry = (int(raw_w), int(raw_h))
            return frame

        try:
            import cv2
            reduced = cv2.resize(frame, (target_w, target_h), interpolation=cv2.INTER_AREA)
        except Exception:
            xs = np.linspace(0, raw_w - 1, target_w).astype(np.int32)
            ys = np.linspace(0, raw_h - 1, target_h).astype(np.int32)
            reduced = np.ascontiguousarray(frame[ys][:, xs])
        self._last_inference_geometry = (target_w, target_h)
        return reduced

    @staticmethod
    def _point_score(point) -> float:
        if isinstance(point, (list, tuple)):
            return float(point[3]) if len(point) > 3 else 1.0
        if not isinstance(point, dict):
            return 0.0
        try:
            return float(point.get("score", point.get("visibility", 0.0)) or 0.0)
        except Exception:
            return 0.0

    @staticmethod
    def _point_xy(point):
        if isinstance(point, (list, tuple)):
            if len(point) >= 2:
                try:
                    x, y = float(point[0]), float(point[1])
                    if np.isfinite(x) and np.isfinite(y):
                        return x, y
                except Exception:
                    pass
            return None
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

    @staticmethod
    def _point_xyz(point):
        if isinstance(point, (list, tuple)):
            if len(point) >= 3:
                try:
                    x, y, z = float(point[0]), float(point[1]), float(point[2])
                    if np.isfinite(x) and np.isfinite(y) and np.isfinite(z):
                        return x, y, z
                except Exception:
                    pass
            return None
        if not isinstance(point, dict):
            return None
        pos = point.get("position") if isinstance(point.get("position"), dict) else point
        try:
            x, y = float(pos.get("x")), float(pos.get("y"))
            z = float(pos.get("z", 0.0))
            if not (np.isfinite(x) and np.isfinite(y) and np.isfinite(z)):
                return None
            return x, y, z
        except Exception:
            return None

    def _reset_landmark_stabilizer(self, model_id=None) -> None:
        self._stabilizer_model = model_id
        self._body_last_good = [None] * 33
        self._body_last_good_at = [0.0] * 33
        self._joint_recovery = [0] * 33
        self._wrist_elbow_rel = {15: None, 16: None}
        self._hand_wrist_rel = {17: None, 18: None, 19: None, 20: None, 21: None, 22: None}
        self._hand_last_good = {"leftHand": None, "rightHand": None}
        self._hand_last_good_at = {"leftHand": 0.0, "rightHand": 0.0}
        self._held_joints = 0
        self._dropped_hands = 0

    @staticmethod
    def _fast_copy_point(point):
        if not isinstance(point, dict):
            return point
        out = dict(point)
        pos = point.get("position")
        if isinstance(pos, dict):
            out["position"] = dict(pos)
        return out

    def _stabilize_payload(self, payload: dict, width: int, height: int) -> dict:
        """Reject low-confidence/kinematically implausible limb hallucinations.

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
        copy_fn = self._fast_copy_point
        body = payload.get("keypoints")
        body3 = payload.get("keypoints3D")
        def _is_active_hand(h):
            if isinstance(h, list) and len(h) >= 21:
                return self._point_score(h[0]) >= 0.18
            return False
        has_left_hand = _is_active_hand(payload.get("leftHand"))
        has_right_hand = _is_active_hand(payload.get("rightHand"))

        if isinstance(body, list) and len(body) == 33:
            parent = {
                13: 11, 15: 13, 17: 15, 19: 15, 21: 15,
                14: 12, 16: 14, 18: 16, 20: 16, 22: 16,
                25: 23, 27: 25, 29: 27, 31: 27,
                26: 24, 28: 26, 30: 28, 32: 28,
            }
            thresholds = {
                13: 0.30, 14: 0.30,
                15: 0.40, 16: 0.40,
                17: 0.45, 18: 0.45, 19: 0.45, 20: 0.45, 21: 0.45, 22: 0.45,
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

                # If hands are active and detected, accept wrist flexibly so tracking never drops
                if index in {15, 17, 19, 21} and has_left_hand:
                    threshold = 0.12
                elif index in {16, 18, 20, 22} and has_right_hand:
                    threshold = 0.12

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
                        # Wrists (15, 16): If smart_arm_sync is enabled, real 21-pt hand is detected,
                        # and wrist is confident, synthesize elbow.
                        # Never synthesize when smart_arm_sync is False or when hands are absent (prevents phantom desk wrists).
                        is_smart_sync = getattr(self, "_smart_arm_sync", True)
                        has_hand = has_left_hand if index == 15 else has_right_hand
                        sh_idx = 11 if index == 15 else 12
                        sh_score = self._point_score(body[sh_idx])
                        sh_xy = self._point_xy(body[sh_idx])
                        if is_smart_sync and has_hand and index in {15, 16} and sh_score >= 0.25 and sh_xy is not None and score >= 0.35:
                            synth_x = (sh_xy[0] + xy[0]) * 0.5
                            synth_y = (sh_xy[1] + xy[1]) * 0.5
                            if body[pidx] is None or self._point_score(body[pidx]) < 0.20:
                                body[pidx] = {
                                    "position": {"x": synth_x, "y": synth_y, "z": 0.0},
                                    "x": synth_x, "y": synth_y, "z": 0.0,
                                    "score": 0.35, "visibility": 0.35,
                                    "part": "leftElbow" if pidx == 13 else "rightElbow"
                                }
                                accepted[pidx] = True
                        else:
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

                # Recovering a distal point after it was absent
                if sane and previous is None and index in distal:
                    self._joint_recovery[index] += 1
                    target_rec = 1 if (index in {15, 16} or score >= 0.50 or ((index in {15,17,19,21} and has_left_hand) or (index in {16,18,20,22} and has_right_hand))) else 2
                    if self._joint_recovery[index] < target_rec:
                        sane = False
                elif sane:
                    self._joint_recovery[index] = 3
                else:
                    self._joint_recovery[index] = 0

                if sane:
                    saved3 = copy_fn(body3[index]) if isinstance(body3, list) and len(body3) == 33 else None
                    self._body_last_good[index] = (copy_fn(point), saved3)
                    self._body_last_good_at[index] = now
                    accepted[index] = True
                    # Record relative wrist->elbow and hand->wrist offsets when sane
                    if index in {15, 16}:
                        el_idx = 13 if index == 15 else 14
                        el_xy = self._point_xy(body[el_idx]) if 0 <= el_idx < len(body) else None
                        if el_xy is not None and xy is not None:
                            rel_2d = (xy[0] - el_xy[0], xy[1] - el_xy[1])
                            rel_3d = None
                            if isinstance(body3, list) and len(body3) == 33:
                                w_xyz3 = self._point_xyz(body3[index])
                                e_xyz3 = self._point_xyz(body3[el_idx])
                                if w_xyz3 is not None and e_xyz3 is not None:
                                    rel_3d = (w_xyz3[0] - e_xyz3[0], w_xyz3[1] - e_xyz3[1], w_xyz3[2] - e_xyz3[2])
                            self._wrist_elbow_rel[index] = (rel_2d, rel_3d)
                    elif index in {17, 18, 19, 20, 21, 22}:
                        w_idx = 15 if index in {17, 19, 21} else 16
                        w_xy = self._point_xy(body[w_idx]) if 0 <= w_idx < len(body) else None
                        if w_xy is not None and xy is not None:
                            self._hand_wrist_rel[index] = (xy[0] - w_xy[0], xy[1] - w_xy[1])
                    continue

                # When sane is False: handle invalid or occluded joint
                age = now - self._body_last_good_at[index] if previous is not None else 999.0

                # Wrists (15, 16): Kinematic tracking
                if index in {15, 16}:
                    is_left = (index == 15)
                    sh_idx = 11 if is_left else 12
                    el_idx = 13 if is_left else 14
                    part_name = "leftWrist" if is_left else "rightWrist"
                    name3 = "left_wrist" if is_left else "right_wrist"
                    side_sign = -1.0 if is_left else 1.0

                    sh_pt = body[sh_idx] if 0 <= sh_idx < len(body) else None
                    el_pt = body[el_idx] if 0 <= el_idx < len(body) else None
                    sh_xy = self._point_xy(sh_pt)
                    el_xy = self._point_xy(el_pt)
                    sh_score = self._point_score(sh_pt)
                    el_score = self._point_score(el_pt)

                    # Determine if upper arm is truly active in space (pointing up, far lateral, or forearm raised)
                    # When smart_arm_sync is False, never synthesize or inject phantom arm postures.
                    is_smart_sync = getattr(self, "_smart_arm_sync", True)
                    arm_active = False
                    has_hand = has_left_hand if is_left else has_right_hand
                    rel = self._wrist_elbow_rel.get(index)

                    if is_smart_sync and sh_xy is not None and el_xy is not None and sh_score >= 0.25:
                        el_thresh = 0.25 if has_hand else 0.35
                        if el_score >= el_thresh:
                            dx_se = el_xy[0] - sh_xy[0]
                            dy_se = el_xy[1] - sh_xy[1]
                            se_len = max(1.0, (dx_se * dx_se + dy_se * dy_se) ** 0.5)
                            u_y = dy_se / se_len
                            u_x = abs(dx_se) / se_len
                            # Active upper arm: raised above shoulder (dy_se <= 0),
                            # or angled away from vertical resting pose (u_y <= 0.85 or dy_se <= torso * 0.45 or u_x >= 0.38)
                            if dy_se <= 0.0 or (u_y <= 0.85 and dy_se <= torso * 0.50) or (u_x >= 0.38 and dy_se <= torso * 0.40) or (abs(dx_se) >= max(35.0, torso * 0.45) and dy_se <= torso * 0.35):
                                arm_active = True
                            elif has_hand and rel and rel[0] is not None and rel[0][1] < -torso * 0.15 and age <= 0.30:
                                arm_active = True

                    if is_smart_sync and arm_active and el_xy is not None:
                        # 1. Arm is active in space: DO NOT put to rest!
                        # Wrist dynamically tracks relative to elbow (forearm follows elbow movement)
                        se_len = max(1.0, (dx_se * dx_se + dy_se * dy_se) ** 0.5)
                        forearm_len = max(35.0, torso * 0.65)
                        if rel and rel[0] is not None:
                            f_dx, f_dy = rel[0]
                            rel_3d = rel[1]
                            # If upper arm is pointing down and not active, transition downward directly.
                            if dy_se > 0 and f_dy < 0 and not arm_active:
                                f_dx = (dx_se / se_len) * forearm_len
                                f_dy = abs(dy_se / se_len) * forearm_len
                                rel_3d = None
                        else:
                            f_dx = (dx_se / se_len) * forearm_len
                            f_dy = (dy_se / se_len) * forearm_len
                            rel_3d = None

                        cur_w_x = el_xy[0] + f_dx
                        cur_w_y = el_xy[1] + f_dy
                        wrist_score = 0.55
                        body[index] = {
                            "position": {"x": cur_w_x, "y": cur_w_y, "z": 0.0},
                            "x": cur_w_x, "y": cur_w_y, "z": 0.0,
                            "score": wrist_score, "visibility": wrist_score,
                            "part": part_name
                        }
                        if isinstance(body3, list) and len(body3) == 33:
                            el_xyz3 = self._point_xyz(body3[el_idx]) if 0 <= el_idx < len(body3) else None
                            sh_xyz3 = self._point_xyz(body3[sh_idx]) if 0 <= sh_idx < len(body3) else None
                            if el_xyz3 is not None:
                                if rel_3d is not None:
                                    w3_x = el_xyz3[0] + rel_3d[0]
                                    w3_y = el_xyz3[1] + rel_3d[1]
                                    w3_z = el_xyz3[2] + rel_3d[2]
                                elif sh_xyz3 is not None:
                                    v3_dx, v3_dy, v3_dz = el_xyz3[0] - sh_xyz3[0], el_xyz3[1] - sh_xyz3[1], el_xyz3[2] - sh_xyz3[2]
                                    v3_len = max(1e-4, (v3_dx*v3_dx + v3_dy*v3_dy + v3_dz*v3_dz) ** 0.5)
                                    w3_x = el_xyz3[0] + (v3_dx / v3_len) * 0.25
                                    w3_y = el_xyz3[1] + (v3_dy / v3_len) * 0.25
                                    w3_z = el_xyz3[2] + (v3_dz / v3_len) * 0.25
                                else:
                                    w3_x, w3_y, w3_z = el_xyz3[0], el_xyz3[1] + 0.25, el_xyz3[2]
                                body3[index] = {
                                    "position": {"x": w3_x, "y": w3_y, "z": w3_z},
                                    "x": w3_x, "y": w3_y, "z": w3_z,
                                    "score": wrist_score, "visibility": wrist_score,
                                    "name": name3
                                }
                        self._held_joints += 1
                        accepted[index] = True
                    elif previous is not None and age <= 0.25:
                        # 2. Arm is occluded, within 250ms grace period (absorbs transient webcam jitter)
                        held2, held3 = previous
                        body[index] = copy_fn(held2)
                        body[index]["score"] = 0.08
                        if isinstance(body[index].get("position"), dict):
                            body[index]["visibility"] = 0.08
                        if isinstance(body3, list) and len(body3) == 33 and held3 is not None:
                            body3[index] = copy_fn(held3)
                            if isinstance(body3[index], dict):
                                body3[index]["score"] = 0.08
                        self._held_joints += 1
                    else:
                        # 3. Arm downward and occluded > 180ms: naturally transition to rest!
                        self._body_last_good[index] = None
                        if el_xy is not None and el_score >= 0.20:
                            # Live elbow visible: anchor wrist downward from live elbow
                            proj_x = el_xy[0]
                            proj_y = el_xy[1] + max(35.0, torso * 0.65)
                        elif sh_xy is not None:
                            # Elbow also occluded: project downward along torso flank
                            proj_x = sh_xy[0] + side_sign * 25.0
                            proj_y = sh_xy[1] + max(torso * 1.70, 140.0)
                        else:
                            proj_x, proj_y = 0.0, 0.0

                        body[index] = {
                            "position": {"x": proj_x, "y": proj_y, "z": 0.0},
                            "x": proj_x, "y": proj_y, "z": 0.0,
                            "score": 0.0, "visibility": 0.0, "part": part_name
                        }
                        if isinstance(body3, list) and len(body3) == 33:
                            el_xyz3 = self._point_xyz(body3[el_idx]) if 0 <= el_idx < len(body3) else None
                            sh_xyz3 = self._point_xyz(body3[sh_idx]) if 0 <= sh_idx < len(body3) else None
                            if el_xyz3 is not None and el_score >= 0.20:
                                res_x, res_y, res_z = el_xyz3[0], el_xyz3[1] + 0.25, el_xyz3[2]
                            elif sh_xyz3 is not None:
                                res_x = sh_xyz3[0] + side_sign * 0.05
                                res_y = sh_xyz3[1] + 0.52
                                res_z = sh_xyz3[2]
                            else:
                                res_x, res_y, res_z = 0.0, 0.0, 0.0
                            body3[index] = {
                                "position": {"x": res_x, "y": res_y, "z": res_z},
                                "x": res_x, "y": res_y, "z": res_z,
                                "score": 0.0, "visibility": 0.0, "name": name3
                            }
                    continue

                # Elbows (13, 14): Kinematic tracking
                if index in {13, 14}:
                    is_left = (index == 13)
                    sh_idx = 11 if is_left else 12
                    part_name = "leftElbow" if is_left else "rightElbow"
                    name3 = "left_elbow" if is_left else "right_elbow"
                    side_sign = -1.0 if is_left else 1.0

                    if previous is not None and age <= 0.18:
                        held2, held3 = previous
                        body[index] = copy_fn(held2)
                        body[index]["score"] = 0.08
                        if isinstance(body[index].get("position"), dict):
                            body[index]["visibility"] = 0.08
                        if isinstance(body3, list) and len(body3) == 33 and held3 is not None:
                            body3[index] = copy_fn(held3)
                            if isinstance(body3[index], dict):
                                body3[index]["score"] = 0.08
                        self._held_joints += 1
                    else:
                        self._body_last_good[index] = None
                        sh_pt = body[sh_idx] if 0 <= sh_idx < len(body) else None
                        sh_xy = self._point_xy(sh_pt)
                        if sh_xy:
                            proj_x = sh_xy[0] + side_sign * 15.0
                            proj_y = sh_xy[1] + max(torso * 0.85, 70.0)
                            body[index] = {
                                "position": {"x": proj_x, "y": proj_y, "z": 0.0},
                                "x": proj_x, "y": proj_y, "z": 0.0,
                                "score": 0.0, "visibility": 0.0, "part": part_name
                            }
                        if isinstance(body3, list) and len(body3) == 33:
                            sh_pt3 = body3[sh_idx] if 0 <= sh_idx < len(body3) else None
                            sh_xyz3 = self._point_xyz(sh_pt3)
                            if sh_xyz3:
                                body3[index] = {
                                    "position": {"x": sh_xyz3[0] + side_sign * 0.03, "y": sh_xyz3[1] + 0.27, "z": sh_xyz3[2]},
                                    "x": sh_xyz3[0] + side_sign * 0.03, "y": sh_xyz3[1] + 0.27, "z": sh_xyz3[2],
                                    "score": 0.0, "visibility": 0.0, "name": name3
                                }
                    continue

                # Distal hand points (17, 18, 19, 20, 21, 22)
                if index in {17, 18, 19, 20, 21, 22}:
                    is_left = (index in {17, 19, 21})
                    w_idx = 15 if is_left else 16
                    w_pt = body[w_idx] if 0 <= w_idx < len(body) else None
                    w_xy = self._point_xy(w_pt)
                    w_score = self._point_score(w_pt)

                    if w_xy is not None and w_score > 0.0:
                        # Parent wrist is active: fingers follow wrist displacement
                        hw_rel = self._hand_wrist_rel.get(index)
                        hx = w_xy[0] + (hw_rel[0] if hw_rel else 0.0)
                        hy = w_xy[1] + (hw_rel[1] if hw_rel else 0.0)
                        body[index] = {
                            "position": {"x": hx, "y": hy, "z": 0.0},
                            "x": hx, "y": hy, "z": 0.0,
                            "score": 0.20, "visibility": 0.20
                        }
                    else:
                        self._body_last_good[index] = None
                        if isinstance(point, dict):
                            point["score"] = 0.0
                            if isinstance(point.get("position"), dict):
                                point["visibility"] = 0.0
                        if isinstance(body3, list) and len(body3) == 33 and isinstance(body3[index], dict):
                            body3[index]["score"] = 0.0
                            if isinstance(body3[index].get("position"), dict):
                                body3[index]["visibility"] = 0.0
                    continue

                # Legs and other joints
                self._body_last_good[index] = None
                pidx = parent.get(index)
                if pidx is not None and 0 <= pidx < len(body):
                    parent_point = copy_fn(body[pidx])
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
                if isinstance(body3, list) and len(body3) == 33 and index < len(body3) and isinstance(body3[index], dict):
                    body3[index]["score"] = 0.0
                    if isinstance(body3[index].get("position"), dict):
                        body3[index]["visibility"] = 0.0

        for key in ("leftHand", "rightHand"):
            hand = payload.get(key)
            wrist_idx = 15 if key == "leftHand" else 16
            wrist_pt = body[wrist_idx] if isinstance(body, list) and 0 <= wrist_idx < len(body) else None
            wrist_score = float(wrist_pt.get("score", 0.0)) if isinstance(wrist_pt, dict) else 0.0
            wrist_live = wrist_score >= 0.15

            valid = isinstance(hand, list) and len(hand) == 21
            scores = [self._point_score(p) for p in hand] if valid else []
            finite = valid and sum(self._point_xy(p) is not None for p in hand) >= 18
            median = float(np.median(scores)) if scores else 0.0
            hand_wrist_score = scores[0] if scores else 0.0

            # When the arm wrist is live, use relaxed thresholds so that partially-occluded
            # hand landmarks (e.g. touching hands, fingers overlapping) are still accepted.
            # When the arm wrist is absent (hand under desk), keep strict thresholds to block
            # phantom MediaPipe hallucinations.
            if wrist_live:
                threshold = 0.18
                wrist_threshold = 0.15
            else:
                threshold = 0.35
                wrist_threshold = 0.30
            # Hand is only sane if landmark confidence is solid AND the associated arm wrist is live!
            # If the arm/wrist is occluded or lost under the desk, reject phantom hands!
            hand_sane = (finite and median >= threshold and hand_wrist_score >= wrist_threshold and wrist_live)

            if hand_sane:
                self._hand_last_good[key] = [copy_fn(p) for p in hand]
                self._hand_last_good_at[key] = now
            else:
                previous_hand = self._hand_last_good.get(key)
                age = now - self._hand_last_good_at.get(key, 0.0)
                # Only hold hand decay if the wrist is still live/visible.
                # If the arm/wrist is lost or occluded under the desk, drop immediately!
                if previous_hand is not None and age <= 0.40 and wrist_live:
                    decay = max(0.0, 1.0 - (age / 0.30))
                    held_hand = []
                    for p in previous_hand:
                        cp = copy_fn(p)
                        if isinstance(cp, dict):
                            cp["score"] = float(cp.get("score", 0.5)) * decay
                        held_hand.append(cp)
                    payload[key] = held_hand
                else:
                    payload[key] = []
                    if previous_hand is not None:
                        self._dropped_hands += 1
                        self._hand_last_good[key] = None
        return payload

    def _landmark_summary(
        self,
        payload: Optional[dict],
        width: Optional[int] = None,
        height: Optional[int] = None,
    ) -> dict:
        body = payload.get("keypoints") if isinstance(payload, dict) else None
        body = body if isinstance(body, list) else []
        scores = [max(0.0, min(1.0, self._point_score(point))) for point in body]
        core = [scores[index] if index < len(scores) else 0.0 for index in (11, 12, 23, 24)]

        def span(left: int, right: int) -> float:
            if left >= len(body) or right >= len(body):
                return 0.0
            a, b = self._point_xy(body[left]), self._point_xy(body[right])
            if a is None or b is None:
                return 0.0
            dx, dy = a[0] - b[0], a[1] - b[1]
            if payload.get("keypoints2d_space") == "normalized":
                dx *= float(width or 1)
                dy *= float(height or 1)
            return float((dx * dx + dy * dy) ** 0.5)

        face = payload.get("face") if isinstance(payload, dict) else None
        return {
            "body_points": len(body),
            "body_visible": sum(score >= 0.25 for score in scores),
            "score_min": round(min(scores), 3) if scores else 0.0,
            "score_median": round(float(np.median(scores)), 3) if scores else 0.0,
            "score_max": round(max(scores), 3) if scores else 0.0,
            "core_scores": [round(score, 3) for score in core],
            "shoulder_span_px": round(span(11, 12), 1),
            "hip_span_px": round(span(23, 24), 1),
            "face_points": len(face.get("landmarks") or []) if isinstance(face, dict) else 0,
            "left_hand_points": len(payload.get("leftHand") or []) if isinstance(payload, dict) else 0,
            "right_hand_points": len(payload.get("rightHand") or []) if isinstance(payload, dict) else 0,
        }

    def _run_inference(self, frame: np.ndarray) -> None:
        # If infer_mode was changed at runtime, reload the MediaPipe graph now
        # BEFORE preparing the frame, so the new geometry matches the new graph.
        if self._needs_engine_reload:
            self._needs_engine_reload = False
            try:
                active_id = getattr(engine.ENGINE, "active_id", None) or getattr(
                    registry, "MEDIAPIPE_TASKS_ID", "mediapipe-tasks-landmarker"
                )
                reload_result = engine.ENGINE.load(active_id, force=True)
                self._committed_infer_geometry = (0, 0)  # reset; will update after prepare
                if not reload_result.get("ok"):
                    print(f"[XRA] infer_mode reload failed: {reload_result.get('error')}", flush=True)
            except Exception as exc:
                print(f"[XRA] infer_mode reload exception: {exc}", flush=True)

        frame = self._prepare_inference_frame(frame)
        self._committed_infer_geometry = self._last_inference_geometry
        started = time.perf_counter()
        held_before = self._held_joints
        try:
            payload = engine.ENGINE.infer(frame)
            raw_summary = self._landmark_summary(payload, frame.shape[1], frame.shape[0])
            if payload is not None:
                payload = self._stabilize_payload(payload, frame.shape[1], frame.shape[0])
            # Auto-unstick: detect when MediaPipe gets stuck in a tiny ROI on background objects.
            raw_span = raw_summary.get("shoulder_span_px", 0.0) if raw_summary else 0.0
            raw_face_pts = raw_summary.get("face_points", 0) if raw_summary else 0
            now_mono = time.monotonic()
            if raw_span > 0.0 and raw_span < 50.0 and raw_face_pts == 0:
                self._phantom_counter += 1
                if self._phantom_counter >= 20 and (now_mono - self._last_unstick_at) >= 3.0:
                    self._phantom_counter = 0
                    self._last_unstick_at = now_mono
                    try:
                        active_id = getattr(engine.ENGINE, "active_id", None) or getattr(registry, "MEDIAPIPE_TASKS_ID", "mediapipe-tasks-landmarker")
                        engine.ENGINE.load(active_id, force=True)
                    except Exception:
                        pass
            else:
                self._phantom_counter = 0
        except Exception as exc:
            self._set_error(f"infer: {exc}")
            return
        self._last_infer_ms = (time.perf_counter() - started) * 1000.0
        if self._infer_ms_ema <= 0.0:
            self._infer_ms_ema = self._last_infer_ms
        else:
            self._infer_ms_ema += 0.25 * (self._last_infer_ms - self._infer_ms_ema)
        height, width = frame.shape[:2]
        if payload is None:
            payload = {"score": 0.0, "keypoints": [], "keypoints3D": [],
                       "face": None, "leftHand": [], "rightHand": []}
        if self._mocap_mode == "face":
            payload["keypoints"] = []
            payload["keypoints3D"] = []
            payload["leftHand"] = []
            payload["rightHand"] = []
        wire = engine.to_wire(payload, capture_hint=(width, height))
        self._frames += 1
        self._last_frame_at = time.time()
        self._rate_window_frames += 1
        rate_now = time.monotonic()
        rate_elapsed = rate_now - self._rate_window_at
        if rate_elapsed >= 2.0:
            self._measured_fps = self._rate_window_frames / rate_elapsed
            self._rate_window_at = rate_now
            self._rate_window_frames = 0
        has_face = bool((wire.get("face") or {}).get("landmarks"))
        has_body = bool(wire.get("keypoints"))
        is_empty = not (has_face if self._mocap_mode == "face" else has_body)
        wire.update({
            "type": "pose",
            "frame_id": self._frames,
            "timestamp_ms": int(self._last_frame_at * 1000),
            "capture_width": width,
            "capture_height": height,
            "ms": self._last_infer_ms,
            "provider": engine.ENGINE.provider,
            "empty": is_empty,
            "reason": None if not is_empty else "no_detection",
        })
        output_summary = self._landmark_summary(wire, width, height)
        geometry_reason = (wire.get("geometry") or {}).get("reason") or wire.get("reason") or "unknown"
        self._last_landmark_stats = {
            "raw": raw_summary,
            "output": output_summary,
            "geometry_reason": geometry_reason,
            "held_this_frame": self._held_joints - held_before,
        }
        log_now = time.monotonic()
        first_frames = self._frames <= 3
        periodic = log_now - self._last_frame_log_at >= 5.0
        reason_changed = (
            geometry_reason != self._last_log_geometry_reason
            and log_now - self._last_frame_log_at >= 1.0
        )
        _verbose_logs = os.environ.get("XRA_VERBOSE", "0").lower() in {"1", "true", "yes", "on"}
        if _verbose_logs and (first_frames or periodic or reason_changed):
            self._last_frame_log_at = log_now
            self._last_log_geometry_reason = geometry_reason
            print("[XRA_FRAME] " + __import__("json").dumps({
                "type": "pose", "frame_id": self._frames,
                "width": width, "height": height,
                "raw_geometry": list(self._last_raw_geometry),
                "ms": round(self._last_infer_ms, 2),
                "measured_fps": round(self._measured_fps, 2),
                "subscribers": self.subscriber_count,
                "raw": raw_summary,
                "output": output_summary,
                "held_this_frame": self._held_joints - held_before,
                "geometry": wire.get("geometry"),
                "provider": wire.get("provider"),
                "error": wire.get("reason"),
            }, ensure_ascii=False), flush=True)
        with self._lock:
            self._last_wire = copy.deepcopy(wire)
            subscribers = list(self._subscribers)
        for callback in subscribers:
            try:
                callback(wire)
            except Exception:
                pass

    def _dispatch_cached_wire(self) -> None:
        with self._lock:
            cached = self._last_wire
            subscribers = list(self._subscribers)
        if cached is None:
            return
        wire = copy.deepcopy(cached)
        self._frames += 1
        self._last_frame_at = time.time()
        wire["frame_id"] = self._frames
        wire["timestamp_ms"] = int(self._last_frame_at * 1000)
        wire["skipped"] = True
        self._rate_window_frames += 1
        rate_now = time.monotonic()
        rate_elapsed = rate_now - self._rate_window_at
        if rate_elapsed >= 2.0:
            self._measured_fps = self._rate_window_frames / rate_elapsed
            self._rate_window_at = rate_now
            self._rate_window_frames = 0
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
