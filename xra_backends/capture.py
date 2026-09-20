"""Local webcam capture + inference source for the mocap backends."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
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
    # Inference throttling headroom.  1.0 = unconstrained; 1.25 = leave 25%
    # slack above the running average so the CPU/GPU has thermal breathing room.
    # Exposed as a runtime-configurable value via configure(inference_headroom=…)
    # and settable at startup via XRA_INFERENCE_HEADROOM env var.
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


def _is_own_process(pid: int) -> bool:
    """Check if the PID belongs to XR Animator itself (server, renderer, browser)."""
    my_pid = os.getpid()
    if pid == my_pid:
        return True
    try:
        if os.getpgid(pid) == os.getpgrp():
            return True
    except Exception:
        pass
    try:
        curr = my_pid
        while curr > 1:
            if curr == pid:
                return True
            with open(f"/proc/{curr}/stat", "r", encoding="ascii") as f:
                curr = int(f.read().split()[3])
    except Exception:
        pass
    try:
        with open(f"/proc/{pid}/cmdline", "r", encoding="utf-8", errors="ignore") as f:
            cmd = f.read().lower()
            if any(sig in cmd for sig in ("xr_animator", "xra_browser", "package.nw", ".nw-profile", "xra_server")):
                return True
    except Exception:
        pass
    return False


def list_video_capture_devices() -> list[str]:
    """Return sorted list of /dev/video* device paths that support video capture."""
    import sys
    if not sys.platform.startswith("linux"):
        return []
    import glob, struct
    VIDIOC_QUERYCAP = 0x80685600
    V4L2_CAP_VIDEO_CAPTURE = 0x00000001
    results = []
    candidates = sorted(
        glob.glob("/dev/video*"),
        key=lambda p: int(p.rsplit("video", 1)[1]) if p.rsplit("video", 1)[1].isdigit() else 999
    )
    for path in candidates:
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            try:
                import fcntl
                buf = bytearray(104)
                fcntl.ioctl(fd, VIDIOC_QUERYCAP, buf)
                capabilities, device_caps = struct.unpack("II", buf[84:92])
                caps = device_caps if (capabilities & 0x80000000) else capabilities
                if caps & V4L2_CAP_VIDEO_CAPTURE:
                    results.append(path)
            finally:
                os.close(fd)
        except Exception:
            pass
    return results


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
                    if not _is_own_process(pid) and pid not in busy_pids:
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
                        if not _is_own_process(pid) and pid not in busy_pids:
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

        self.last_error = ""
        cap = None
        opened = False
        max_attempts = 6
        for attempt in range(max_attempts):
            cap = cv2.VideoCapture()
            try:
                if backend is not None:
                    opened = cap.open(source, backend)
                if not opened or not cap.isOpened():
                    opened = cap.open(source)
                if opened and cap.isOpened():
                    break
            except Exception as exc:
                opened = False

            try:
                cap.release()
            except Exception:
                pass
            cap = None
            if attempt < max_attempts - 1:
                time.sleep(0.15 + 0.05 * attempt)

        if not cap or not opened or not cap.isOpened():
            busy_info = check_camera_in_use(self.device)
            if busy_info.get("busy"):
                procs = ", ".join(busy_info["processes"]) or "un'altra applicazione"
                self.last_error = f"Webcam occupata da: {procs}. Chiudila per avviare il tracking."
            else:
                self.last_error = f"camera open failed ({self.device})"
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
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
                name = 'NVIDIA Dedicated GPU'
                is_dedicated = True
                gpu_id = 'high-performance'
            elif '0x8086' in vendor:
                name = 'Intel Integrated GPU'
                is_dedicated = False
                gpu_id = 'low-power'
            elif '0x1002' in vendor:
                name = 'AMD Radeon GPU'
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
        self._hand_world_last_good = {"leftHand": None, "rightHand": None}
        self._hand_fist_state = {"leftHand": False, "rightHand": False}
        self._hand_body_fallback = {"leftHand": False, "rightHand": False}
        self._hand_moving_down = {"leftHand": False, "rightHand": False}
        self._hands_contact_active = False
        self._hands_contact_last_close_at = 0.0
        self._hands_contact_exit_frames = 0
        self._hands_contact_wrist_delta = None
        self._hands_contact_midpoint = None
        self._wrist_moving_down = {15: False, 16: False}
        self._wrist_moving_up = {15: False, 16: False}
        self._held_joints = 0
        self._dropped_hands = 0
        self._phantom_counter = 0
        self._last_unstick_at = 0.0
        self._empty_frames_count = 0
        self._was_empty = False
        self._just_recovered = False
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
        # Optional OBS/debug preview.  The camera is still opened exactly once:
        # HTTP clients consume references to frames already acquired here.
        # Encoding happens in the HTTP client thread so mocap inference is not
        # burdened when the preview is disabled (the default).
        self._obs_preview_condition = threading.Condition()
        self._obs_preview_enabled = os.environ.get("XRA_OBS_PREVIEW", "0").lower() in {
            "1", "true", "yes", "on"
        }
        self._obs_preview_clients = 0
        self._obs_preview_sequence = 0
        self._obs_preview_frame: Optional[np.ndarray] = None
        try:
            self._obs_preview_fps = max(
                1.0, min(30.0, float(os.environ.get("XRA_OBS_PREVIEW_FPS", "15")))
            )
        except (TypeError, ValueError):
            self._obs_preview_fps = 15.0
        try:
            self._obs_preview_quality = max(
                40, min(95, int(os.environ.get("XRA_OBS_PREVIEW_QUALITY", "75")))
            )
        except (TypeError, ValueError):
            self._obs_preview_quality = 75
        # Optional OBS diagnostic: only landmark metadata is written, never
        # camera pixels. A background writer keeps disk I/O off inference.
        self._tracking_log_enabled = os.environ.get("XRA_MEDIAPIPE_LOG", "0").lower() in {
            "1", "true", "yes", "on"
        }
        self._tracking_log_lock = threading.Lock()
        self._tracking_log_queue: Optional[queue.Queue] = None
        self._tracking_log_thread: Optional[threading.Thread] = None
        self._tracking_log_stop = threading.Event()
        self._tracking_log_path = ""
        self._tracking_log_started_ms = 0
        self._tracking_log_entries = 0
        self._tracking_log_dropped = 0
        self._tracking_log_error = ""
        self._tracking_log_directory_override: Optional[Path] = None
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

    @property
    def obs_preview_client_count(self) -> int:
        with self._obs_preview_condition:
            return self._obs_preview_clients

    def configure_obs_preview(self, enabled: bool, *, fps=None, quality=None) -> dict:
        """Enable the local OBS feed without opening another camera handle."""
        with self._obs_preview_condition:
            self._obs_preview_enabled = bool(enabled)
            if fps is not None:
                self._obs_preview_fps = max(1.0, min(30.0, float(fps)))
            if quality is not None:
                self._obs_preview_quality = max(40, min(95, int(quality)))
            if not self._obs_preview_enabled:
                self._obs_preview_frame = None
            self._obs_preview_condition.notify_all()
        self._subscribers_changed.set()
        return self.obs_preview_status()

    def obs_preview_status(self) -> dict:
        with self._obs_preview_condition:
            return {
                "enabled": self._obs_preview_enabled,
                "clients": self._obs_preview_clients,
                "fps": self._obs_preview_fps,
                "quality": self._obs_preview_quality,
            }

    def begin_obs_preview(self) -> bool:
        with self._obs_preview_condition:
            if not self._obs_preview_enabled:
                return False
            self._obs_preview_clients += 1
            self._obs_preview_condition.notify_all()
        self._subscribers_changed.set()
        return True

    def end_obs_preview(self) -> None:
        with self._obs_preview_condition:
            self._obs_preview_clients = max(0, self._obs_preview_clients - 1)
            if self._obs_preview_clients == 0:
                self._obs_preview_frame = None
            self._obs_preview_condition.notify_all()
        self._subscribers_changed.set()

    def wait_obs_preview_frame(
        self, after_sequence: int, timeout: float = 1.0
    ) -> tuple[int, Optional[np.ndarray]]:
        """Wait for and return the newest shared camera frame reference."""
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._obs_preview_condition:
            while (
                self._obs_preview_enabled
                and self._obs_preview_sequence <= after_sequence
            ):
                remaining = deadline - time.monotonic()
                if remaining <= 0.0:
                    break
                self._obs_preview_condition.wait(remaining)
            if not self._obs_preview_enabled:
                return self._obs_preview_sequence, None
            return self._obs_preview_sequence, self._obs_preview_frame

    def _publish_obs_preview_frame(self, frame: np.ndarray) -> None:
        with self._obs_preview_condition:
            if not self._obs_preview_enabled or self._obs_preview_clients <= 0:
                return
            self._obs_preview_frame = frame
            self._obs_preview_sequence += 1
            self._obs_preview_condition.notify_all()

    def _default_tracking_log_directory(self) -> Path:
        if getattr(sys, "frozen", False):
            return Path(sys.executable).resolve().parent / "tracking_logs"
        return Path(__file__).resolve().parents[1] / "tracking_logs"

    def configure_tracking_log(self, enabled: bool, *, directory=None) -> dict:
        """Enable an asynchronous JSONL trace of raw/stabilized hands."""
        with self._tracking_log_lock:
            self._tracking_log_enabled = bool(enabled)
            if directory is not None:
                self._tracking_log_directory_override = Path(directory).expanduser().resolve()
        if enabled:
            self._start_tracking_log()
        else:
            self._stop_tracking_log()
        return self.tracking_log_status()

    def tracking_log_status(self) -> dict:
        with self._tracking_log_lock:
            thread = self._tracking_log_thread
            return {
                "enabled": self._tracking_log_enabled,
                "active": bool(thread and thread.is_alive()),
                "path": self._tracking_log_path,
                "started_ms": self._tracking_log_started_ms or None,
                "entries": self._tracking_log_entries,
                "dropped": self._tracking_log_dropped,
                "error": self._tracking_log_error,
            }

    def _start_tracking_log(self) -> None:
        with self._tracking_log_lock:
            if not self._tracking_log_enabled:
                return
            if self._tracking_log_thread and self._tracking_log_thread.is_alive():
                return
            directory = self._tracking_log_directory_override or self._default_tracking_log_directory()
            try:
                directory.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                self._tracking_log_enabled = False
                self._tracking_log_error = str(exc)
                return
            stamp = time.strftime("%Y-%m-%d_%H-%M-%S")
            path = directory / f"mediapipe_obs_{stamp}_{os.getpid()}.jsonl"
            log_queue: queue.Queue = queue.Queue(maxsize=2048)
            self._tracking_log_queue = log_queue
            self._tracking_log_stop.clear()
            self._tracking_log_path = str(path)
            self._tracking_log_started_ms = int(time.time() * 1000)
            self._tracking_log_entries = 0
            self._tracking_log_dropped = 0
            self._tracking_log_error = ""
            thread = threading.Thread(
                target=self._tracking_log_writer,
                args=(path, log_queue, self._tracking_log_started_ms),
                name="xra-mediapipe-log",
                daemon=True,
            )
            self._tracking_log_thread = thread
            thread.start()
        print(f"[XRA] MediaPipe OBS log: {path}", flush=True)

    def _stop_tracking_log(self) -> None:
        with self._tracking_log_lock:
            thread = self._tracking_log_thread
            log_queue = self._tracking_log_queue
            self._tracking_log_stop.set()
            if log_queue is not None:
                try:
                    log_queue.put_nowait(None)
                except queue.Full:
                    pass
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        with self._tracking_log_lock:
            self._tracking_log_thread = None
            self._tracking_log_queue = None

    def _tracking_log_writer(self, path: Path, log_queue: queue.Queue, started_ms: int) -> None:
        header = {
            "type": "session",
            "version": 1,
            "started_ms": started_ms,
            "pid": os.getpid(),
            "note": "raw=MediaPipe before stabilizer; stable=payload sent to retarget",
        }
        try:
            with path.open("w", encoding="utf-8", buffering=1) as handle:
                handle.write(json.dumps(header, separators=(",", ":")) + "\n")
                while True:
                    try:
                        record = log_queue.get(timeout=0.5)
                    except queue.Empty:
                        if self._tracking_log_stop.is_set():
                            break
                        continue
                    if record is None:
                        break
                    handle.write(json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n")
        except Exception as exc:
            with self._tracking_log_lock:
                self._tracking_log_error = str(exc)

    @staticmethod
    def _tracking_log_point(point: object) -> Optional[list]:
        if isinstance(point, dict):
            position = point.get("position") if isinstance(point.get("position"), dict) else point
            values = (position.get("x"), position.get("y"), position.get("z", 0.0))
            score = point.get("score", point.get("visibility", position.get("visibility", 1.0)))
        elif isinstance(point, (list, tuple)) and len(point) >= 2:
            values = (point[0], point[1], point[2] if len(point) > 2 else 0.0)
            score = point[3] if len(point) > 3 else 1.0
        else:
            return None
        try:
            return [round(float(values[0]), 4), round(float(values[1]), 4),
                    round(float(values[2]), 4), round(float(score), 3)]
        except (TypeError, ValueError):
            return None

    def _tracking_log_snapshot(self, payload: Optional[dict]) -> dict:
        payload = payload if isinstance(payload, dict) else {}

        def points(name: str, limit: int) -> list:
            source = payload.get(name)
            if not isinstance(source, list):
                return []
            result = []
            for point in source[:limit]:
                compact = self._tracking_log_point(point)
                if compact is not None:
                    result.append(compact)
            return result

        body = payload.get("keypoints") if isinstance(payload.get("keypoints"), list) else []
        arms = {}
        for index, name in ((11, "left_shoulder"), (12, "right_shoulder"),
                            (13, "left_elbow"), (14, "right_elbow"),
                            (15, "left_wrist"), (16, "right_wrist")):
            compact = self._tracking_log_point(body[index]) if index < len(body) else None
            if compact is not None:
                arms[name] = compact
        return {
            "left": points("leftHand", 21),
            "right": points("rightHand", 21),
            "left_world": points("leftHandWorld", 21),
            "right_world": points("rightHandWorld", 21),
            "arms": arms,
        }

    def _queue_tracking_log(self, record: dict) -> None:
        with self._tracking_log_lock:
            log_queue = self._tracking_log_queue
            active = bool(
                self._tracking_log_enabled
                and self._tracking_log_thread
                and self._tracking_log_thread.is_alive()
                and log_queue is not None
            )
            if not active:
                return
            try:
                log_queue.put_nowait(record)
                self._tracking_log_entries += 1
            except queue.Full:
                self._tracking_log_dropped += 1

    def start(self) -> None:
        if self._tracking_log_enabled:
            self._start_tracking_log()
        with self._lock:
            self._last_error = ""
            self._available = False
            self._rate_window_at = time.monotonic()
            self._rate_window_frames = 0
            self._measured_fps = 0.0
            self._deadline_misses = 0
            self._last_infer_ms = 0.0
            self._infer_ms_ema = 0.0
            self._last_work_ms = 0.0
            self._work_ms_ema = 0.0
            if self._grabber is not None:
                setattr(self._grabber, "last_error", "")
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
        self._stop_tracking_log()

    def pause(self) -> None:
        self._paused.set()
        self._reopen.set()
        self._subscribers_changed.set()

    def resume(self) -> None:
        self.start()
        self._paused.clear()
        self._subscribers_changed.set()

    def configure(self, *, index=None, device=None, width=None, height=None, fps=None, selfie_mode=None, mocap_mode=None, infer_width=None, infer_height=None, infer_mode=None, arm_steady_hold=None, smart_arm_sync=None, desk_wrist_guard=None, adaptive_frame_skip=None, cpu_affinity=None, inference_headroom=None) -> dict:
        requested_mode = None
        previous_mode = None
        needs_reopen = False
        if device is None and index is not None:
            try:
                index = int(index)
                import sys
                if sys.platform.startswith("linux"):
                    valid_devs = list_video_capture_devices()
                    if 0 <= index < len(valid_devs):
                        device = valid_devs[index]
                    else:
                        device = f"/dev/video{index}"
                else:
                    device = str(index)
            except Exception:
                device = str(index)
        with self._lock:
            if inference_headroom is not None:
                global _INFERENCE_HEADROOM
                _INFERENCE_HEADROOM = max(1.0, min(3.0, float(inference_headroom)))
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
                "obs_preview": self.obs_preview_status(),
                "tracking_log": self.tracking_log_status(),
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
                if self.subscriber_count == 0 and self.obs_preview_client_count == 0:
                    self._subscribers_changed.clear()
                    if self.subscriber_count == 0 and self.obs_preview_client_count == 0:
                        self._subscribers_changed.wait(1.0)
                    continue

                loop_started = time.perf_counter()
                capture_started = time.perf_counter()
                frame = grabber.read()
                self._last_capture_ms = (time.perf_counter() - capture_started) * 1000.0

                if frame is None:
                    failures += 1
                    if failures >= 4:
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

                # OBS receives the same oriented frame that enters the mocap
                # pipeline.  This only stores a reference and wakes the HTTP
                # thread; JPEG compression never runs on the inference thread.
                self._publish_obs_preview_frame(frame)

                # A preview client can keep acquisition alive by itself.  If no
                # pose client is connected, avoid wasting cycles on inference.
                if self.subscriber_count == 0:
                    continue

                if getattr(self, "_just_recovered", False):
                    self._just_recovered = False
                    last_missed_deadline = False

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
            empty_count = getattr(self, "_empty_frames_count", 0)
            if empty_count > 15:
                # Idle search mode: drop to 12 FPS when room is empty (> 0.5s)
                # Cuts CPU/GPU load from 70% to 15% and prevents thermal throttling.
                return 12.0
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
        self._hand_world_last_good = {"leftHand": None, "rightHand": None}
        self._hand_was_live = {"leftHand": False, "rightHand": False}
        self._hand_fist_state = {"leftHand": False, "rightHand": False}
        self._hand_body_fallback = {"leftHand": False, "rightHand": False}
        self._hand_moving_down = {"leftHand": False, "rightHand": False}
        self._hands_contact_active = False
        self._hands_contact_last_close_at = 0.0
        self._hands_contact_exit_frames = 0
        self._hands_contact_wrist_delta = None
        self._hands_contact_midpoint = None
        self._wrist_moving_down = {15: False, 16: False}
        self._wrist_moving_up = {15: False, 16: False}
        self._held_joints = 0
        self._dropped_hands = 0

    @staticmethod
    def _fast_copy_point(point):
        if isinstance(point, dict):
            out = dict(point)
            pos = point.get("position")
            if isinstance(pos, dict):
                out["position"] = dict(pos)
            return out
        if isinstance(point, list):
            return list(point)
        return point

    @staticmethod
    def _hand_world_key(hand_key: str) -> str:
        return "leftHandWorld" if hand_key == "leftHand" else "rightHandWorld"

    def _hand_bend_score(self, hand: Any) -> float:
        """Return a cheap 0..1 curl estimate for the four non-thumb fingers."""
        if not (isinstance(hand, list) and len(hand) >= 21):
            return 0.0
        total = 0.0
        count = 0
        for chain in ((5, 6, 7, 8), (9, 10, 11, 12),
                      (13, 14, 15, 16), (17, 18, 19, 20)):
            points = [self._point_xyz(hand[index]) for index in chain]
            if any(point is None for point in points):
                continue
            for a, b, c in ((points[0], points[1], points[2]),
                            (points[1], points[2], points[3])):
                ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
                bc = (c[0] - b[0], c[1] - b[1], c[2] - b[2])
                ab_len = (ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]) ** 0.5
                bc_len = (bc[0] * bc[0] + bc[1] * bc[1] + bc[2] * bc[2]) ** 0.5
                if ab_len <= 1e-6 or bc_len <= 1e-6:
                    continue
                cosine = max(-1.0, min(1.0, (
                    ab[0] * bc[0] + ab[1] * bc[1] + ab[2] * bc[2]
                ) / (ab_len * bc_len)))
                total += (1.0 - cosine) * 0.5
                count += 1
        return total / count if count else 0.0

    def _hand_points_px(self, hand: Any, width: int, height: int) -> Optional[list]:
        if not (isinstance(hand, list) and len(hand) >= 21):
            return None
        points = []
        for point in hand[:21]:
            xy = self._point_xy(point)
            if xy is None:
                return None
            if width and height and abs(xy[0]) <= 1.5 and abs(xy[1]) <= 1.5:
                points.append((xy[0] * width, xy[1] * height))
            else:
                points.append(xy)
        return points

    def _hand_contact_metrics(self, left: Any, right: Any, width: int, height: int) -> Optional[dict]:
        """Measure two-hand contact without assuming that touching palms have touching wrists."""
        left_px = self._hand_points_px(left, width, height)
        right_px = self._hand_points_px(right, width, height)
        if left_px is None or right_px is None:
            return None

        def hand_scale(points):
            wrist = points[0]
            return max(
                ((point[0] - wrist[0]) ** 2 + (point[1] - wrist[1]) ** 2)
                for point in points[1:]
            ) ** 0.5

        scale = max(8.0, (hand_scale(left_px) + hand_scale(right_px)) * 0.5)
        # Fingers and palm edges can touch while the two wrist roots remain a
        # full palm-width apart (prayer/clap pose).  Use the closest non-wrist
        # landmarks for entry, and paired-landmark similarity only to identify
        # MediaPipe's occasional duplicated-single-hand result.
        closest = min(
            ((left_px[i][0] - right_px[j][0]) ** 2
             + (left_px[i][1] - right_px[j][1]) ** 2)
            for i in range(1, 21) for j in range(1, 21)
        ) ** 0.5
        paired = sum(
            ((left_px[i][0] - right_px[i][0]) ** 2
             + (left_px[i][1] - right_px[i][1]) ** 2) ** 0.5
            for i in range(21)
        ) / 21.0
        lw, rw = left_px[0], right_px[0]
        wrist_distance = ((lw[0] - rw[0]) ** 2 + (lw[1] - rw[1]) ** 2) ** 0.5
        return {
            "close": closest <= scale * 0.52,
            "duplicate": wrist_distance <= scale * 0.14 and paired <= scale * 0.18,
            "ratio": closest / scale,
            "left_wrist": lw,
            "right_wrist": rw,
            "midpoint": ((lw[0] + rw[0]) * 0.5, (lw[1] + rw[1]) * 0.5),
            "delta": (lw[0] - rw[0], lw[1] - rw[1]),
        }

    def _update_hands_contact_state(
        self,
        raw_hands: dict,
        hand_validity: dict,
        width: int,
        height: int,
        now: float,
    ) -> tuple[Optional[dict], bool]:
        both_valid = all(hand_validity[key][0] for key in ("leftHand", "rightHand"))
        metrics = self._hand_contact_metrics(
            raw_hands.get("leftHand"), raw_hands.get("rightHand"), width, height
        ) if both_valid else None

        convincing_contact = bool(
            metrics and metrics["close"] and not metrics["duplicate"]
            and metrics["midpoint"][1] < height * 0.82
        )
        if convincing_contact:
            # Enter immediately: in real prayer poses MediaPipe often provides
            # only one clean contact frame before face occlusion begins.
            self._hands_contact_active = True
            self._hands_contact_last_close_at = now
            self._hands_contact_exit_frames = 0
            self._hands_contact_wrist_delta = metrics["delta"]
            self._hands_contact_midpoint = metrics["midpoint"]
        elif self._hands_contact_active:
            within_occlusion_grace = (now - self._hands_contact_last_close_at) <= 0.70
            if metrics and not metrics["duplicate"] and metrics["ratio"] > 0.95:
                self._hands_contact_exit_frames += 1
            elif metrics and metrics["ratio"] <= 0.95:
                self._hands_contact_exit_frames = 0
            if not within_occlusion_grace or self._hands_contact_exit_frames >= 2:
                self._hands_contact_active = False
                self._hands_contact_exit_frames = 0
                self._hands_contact_wrist_delta = None
                self._hands_contact_midpoint = None

        untrusted_pair = bool(
            self._hands_contact_active and metrics
            and (metrics["duplicate"] or not metrics["close"])
        )
        return metrics, untrusted_pair

    def _translate_hand_to_wrist(
        self,
        hand: Any,
        target_wrist_px: tuple[float, float],
        width: int,
        height: int,
    ) -> Optional[list]:
        if not (isinstance(hand, list) and len(hand) >= 21):
            return None
        wrist = self._point_xy(hand[0])
        if wrist is None:
            return None
        normalized = bool(abs(wrist[0]) <= 1.5 and abs(wrist[1]) <= 1.5)
        target_x, target_y = target_wrist_px
        if normalized:
            target_x /= max(1, width)
            target_y /= max(1, height)
        dx, dy = target_x - wrist[0], target_y - wrist[1]
        translated = []
        for point in hand:
            copied = self._fast_copy_point(point)
            xy = self._point_xy(copied)
            if xy is None:
                return None
            x, y = xy[0] + dx, xy[1] + dy
            if isinstance(copied, dict):
                copied["x"] = x
                copied["y"] = y
                copied["score"] = min(0.55, max(0.30, self._point_score(copied)))
                copied["visibility"] = copied["score"]
                if isinstance(copied.get("position"), dict):
                    copied["position"]["x"] = x
                    copied["position"]["y"] = y
            elif isinstance(copied, (list, tuple)):
                copied = [x, y, *list(copied[2:])]
            translated.append(copied)
        return translated

    def _contact_held_hand(
        self,
        hand_key: str,
        previous_hands: dict,
        raw_hands: dict,
        hand_validity: dict,
        metrics: Optional[dict],
        width: int,
        height: int,
    ) -> Optional[list]:
        if not self._hands_contact_active or self._hands_contact_wrist_delta is None:
            return None
        previous = previous_hands.get(hand_key)
        if not (isinstance(previous, list) and len(previous) >= 21):
            return None

        other_key = "rightHand" if hand_key == "leftHand" else "leftHand"
        delta_x, delta_y = self._hands_contact_wrist_delta
        target = None
        if metrics is not None:
            midpoint = metrics["midpoint"]
            sign = 0.5 if hand_key == "leftHand" else -0.5
            target = (midpoint[0] + delta_x * sign, midpoint[1] + delta_y * sign)
            self._hands_contact_midpoint = midpoint
        elif hand_validity.get(other_key, (False, False))[0]:
            other_points = self._hand_points_px(raw_hands.get(other_key), width, height)
            if other_points:
                other_wrist = other_points[0]
                if hand_key == "leftHand":
                    target = (other_wrist[0] + delta_x, other_wrist[1] + delta_y)
                else:
                    target = (other_wrist[0] - delta_x, other_wrist[1] - delta_y)
        elif self._hands_contact_midpoint is not None:
            midpoint = self._hands_contact_midpoint
            sign = 0.5 if hand_key == "leftHand" else -0.5
            target = (midpoint[0] + delta_x * sign, midpoint[1] + delta_y * sign)

        return self._translate_hand_to_wrist(previous, target, width, height) if target else None

    def _check_hand_validity(
        self,
        hand: Any,
        hand_key: str,
        body: Optional[list],
        width: int,
        height: int,
        torso: float,
        now: float,
        payload: Optional[dict] = None,
    ) -> tuple[bool, bool]:
        """Validate hand candidates against confidence and physical/kinematic feasibility.

        Returns: (is_valid, is_phantom)
        - is_valid=True: genuine active hand to track and pass downstream.
        - is_valid=False, is_phantom=True: rejected phantom/hallucination; MUST NOT be held.
        - is_valid=False, is_phantom=False: normal frame loss/occlusion; eligible for brief holding.
        """
        if not (isinstance(hand, list) and len(hand) >= 21):
            return False, False

        valid_pts = [self._point_xy(p) for p in hand]
        if sum(p is not None for p in valid_pts) < 18:
            return False, True

        scores = [self._point_score(p) for p in hand]
        w_sc = scores[0] if scores else 0.0
        knuckles = [scores[idx] for idx in (0, 1, 5, 9, 13, 17)] if len(scores) >= 18 else []
        avg_knuckles = sum(knuckles) / 6.0 if knuckles else 0.0
        median_sc = float(np.median(scores)) if scores else 0.0

        max_finger_avg = 0.0
        if len(scores) >= 21:
            for start in (1, 5, 9, 13, 17):
                f_sc = [scores[i] for i in range(start, start + 4)]
                max_finger_avg = max(max_finger_avg, sum(f_sc) / 4.0)

        effective_conf = max(median_sc, avg_knuckles, max_finger_avg)

        was_live = self._hand_was_live.get(hand_key, False)
        last_good_at = self._hand_last_good_at.get(hand_key, 0.0)
        age = now - last_good_at
        # Temporal window for hand reacquisition during brief rotation dropouts
        is_continuous = was_live and (age < 0.55)
        strong_hand_evidence = bool(
            is_continuous
            or (
                effective_conf >= 0.55
                and (w_sc >= 0.45 or avg_knuckles >= 0.55)
            )
        )

        # Baseline confidence gate:
        # Continuously tracked hands tolerate lower confidence during dips (Test 7 & Test 21).
        # New hand candidates require higher confidence to initiate tracking.
        if not is_continuous:
            if effective_conf < 0.22 and w_sc < 0.25 and max_finger_avg < 0.22:
                return False, True
        else:
            if effective_conf < 0.15 and max_finger_avg < 0.20 and w_sc < 0.15:
                return False, False

        h_w_xy = valid_pts[0]
        if h_w_xy is None:
            return False, True

        hw_px = (h_w_xy[0] * width, h_w_xy[1] * height) if (width and h_w_xy[0] <= 1.5) else h_w_xy

        if isinstance(body, list) and len(body) == 33:
            is_left = (hand_key == "leftHand")
            sh_idx = 11 if is_left else 12
            el_idx = 13 if is_left else 14
            bw_idx = 15 if is_left else 16

            sh_xy = self._point_xy(body[sh_idx])
            sh_sc = self._point_score(body[sh_idx])
            el_xy = self._point_xy(body[el_idx])
            el_sc = self._point_score(body[el_idx])
            bw_xy = self._point_xy(body[bw_idx])
            bw_sc = self._point_score(body[bw_idx])

            sh_px = (sh_xy[0] * width, sh_xy[1] * height) if (sh_xy and width and sh_xy[0] <= 1.5) else sh_xy
            el_px = (el_xy[0] * width, el_xy[1] * height) if (el_xy and width and el_xy[0] <= 1.5) else el_xy
            bw_px = (bw_xy[0] * width, bw_xy[1] * height) if (bw_xy and width and bw_xy[0] <= 1.5) else bw_xy

            ls_xy = self._point_xy(body[11])
            rs_xy = self._point_xy(body[12])
            ls_sc = self._point_score(body[11])
            rs_sc = self._point_score(body[12])
            mid_sh_y = 0.0
            if ls_xy and rs_xy and ls_sc >= 0.20 and rs_sc >= 0.20:
                ls_px = (ls_xy[0] * width, ls_xy[1] * height) if (width and ls_xy[0] <= 1.5) else ls_xy
                rs_px = (rs_xy[0] * width, rs_xy[1] * height) if (width and rs_xy[0] <= 1.5) else rs_xy
                mid_sh_y = (ls_px[1] + rs_px[1]) * 0.5
            elif sh_px and sh_sc >= 0.20:
                mid_sh_y = sh_px[1]

            # 1. Whole-arm maximum span check: hand cannot be farther than physical arm length
            if sh_px and sh_sc >= 0.20:
                dist_sh = ((hw_px[0] - sh_px[0]) ** 2 + (hw_px[1] - sh_px[1]) ** 2) ** 0.5
                max_reach = max(torso * 2.3, height * 0.55 if height else 300.0)
                if dist_sh > max_reach:
                    return False, True

            # 2. Forearm reach check: if elbow is live, hand cannot be detached from forearm
            if el_px and el_sc >= 0.25:
                dist_el = ((hw_px[0] - el_px[0]) ** 2 + (hw_px[1] - el_px[1]) ** 2) ** 0.5
                len_se = ((el_px[0] - sh_px[0]) ** 2 + (el_px[1] - sh_px[1]) ** 2) ** 0.5 if (sh_px and sh_sc >= 0.20) else (torso * 0.70)
                max_forearm = max(len_se * 1.35, torso * 1.05, height * 0.32 if height else 180.0)
                if dist_el > max_forearm:
                    is_desk_stuck_elbow = bool(
                        sh_px and sh_sc >= 0.20
                        and dist_sh <= max_reach * 0.75
                        and hw_px[1] <= mid_sh_y + torso * 0.25
                        and el_px[1] > mid_sh_y + torso * 0.35
                    )
                    if not is_desk_stuck_elbow:
                        return False, True

            # 3. Resting Arm Global Guard:
            # A stale BlazePose wrist often remains below the desk while the dedicated
            # hand tracker has already reacquired a real raised hand. Treat the body
            # pose as a veto only for weak, newly-entering candidates; otherwise the
            # complete hand track is the more specific source of truth.
            if el_px and el_sc >= 0.25 and mid_sh_y > 0.0:
                if el_px[1] > mid_sh_y + torso * 0.45:
                    is_resting_arm = False
                    if bw_px and bw_sc >= 0.40 and bw_px[1] > el_px[1] + torso * 0.05:
                        is_resting_arm = True

                    if (
                        is_resting_arm
                        and hw_px[1] < el_px[1] - torso * 0.10
                        and not strong_hand_evidence
                    ):
                        return False, True

            # 4. Chest / Collar Phantom Hand Rejection Zone:
            if ls_xy and rs_xy and ls_sc >= 0.20 and rs_sc >= 0.20:
                min_sh_x = min(ls_px[0], rs_px[0]) - torso * 0.15
                max_sh_x = max(ls_px[0], rs_px[0]) + torso * 0.15
                collar_top = mid_sh_y - torso * 0.40
                chest_bottom = mid_sh_y + torso * 0.70

                in_chest_zone = (min_sh_x <= hw_px[0] <= max_sh_x) and (collar_top <= hw_px[1] <= chest_bottom)

                if in_chest_zone:
                    arm_raised_to_chest = False
                    if el_px and el_sc >= 0.25:
                        if el_px[1] <= mid_sh_y + torso * 0.45:
                            arm_raised_to_chest = True
                        elif hw_px[1] < el_px[1] - torso * 0.12:
                            if bw_px and bw_sc >= 0.35 and bw_px[1] > el_px[1]:
                                arm_raised_to_chest = False
                            else:
                                arm_raised_to_chest = True

                    bw_corroborates = False
                    if bw_px and bw_sc >= 0.30:
                        dist_bw = ((hw_px[0] - bw_px[0]) ** 2 + (hw_px[1] - bw_px[1]) ** 2) ** 0.5
                        if dist_bw <= torso * 0.45:
                            bw_corroborates = True

                    high_conf = (effective_conf >= 0.60 and w_sc >= 0.55)

                    if not (is_continuous or arm_raised_to_chest or bw_corroborates or high_conf):
                        return False, True

            # 5. Double-Hand Superposition Check (Global: applies at chest, face, head, air):
            # When MediaPipe detects the SAME physical hand as both leftHand and rightHand,
            # or hallucinates a twin hand superimposed on top of the real hand (distance < torso * 0.15):
            if payload:
                other_key = "rightHand" if hand_key == "leftHand" else "leftHand"
                other_h = payload.get(other_key)
                if isinstance(other_h, list) and len(other_h) >= 21:
                    other_w = self._point_xy(other_h[0])
                    if other_w:
                        other_px = (other_w[0] * width, other_w[1] * height) if (width and other_w[0] <= 1.5) else other_w
                        dist_between = ((hw_px[0] - other_px[0]) ** 2 + (hw_px[1] - other_px[1]) ** 2) ** 0.5
                        if dist_between < torso * 0.15:
                            other_sh_idx = 12 if is_left else 11
                            other_el_idx = 14 if is_left else 13
                            other_bw_idx = 16 if is_left else 15
                            o_el_xy = self._point_xy(body[other_el_idx])
                            o_el_sc = self._point_score(body[other_el_idx])
                            o_el_px = (o_el_xy[0] * width, o_el_xy[1] * height) if (o_el_xy and width and o_el_xy[0] <= 1.5) else o_el_xy
                            o_bw_xy = self._point_xy(body[other_bw_idx])
                            o_bw_sc = self._point_score(body[other_bw_idx])
                            o_bw_px = (o_bw_xy[0] * width, o_bw_xy[1] * height) if (o_bw_xy and width and o_bw_xy[0] <= 1.5) else o_bw_xy

                            this_resting = bool(el_px and el_sc >= 0.25 and mid_sh_y > 0 and el_px[1] > mid_sh_y + torso * 0.40 and
                                                not (bw_px and bw_sc >= 0.35 and bw_px[1] < el_px[1] - torso * 0.10))
                            other_resting = bool(o_el_px and o_el_sc >= 0.25 and mid_sh_y > 0 and o_el_px[1] > mid_sh_y + torso * 0.40 and
                                                 not (o_bw_px and o_bw_sc >= 0.35 and o_bw_px[1] < o_el_px[1] - torso * 0.10))

                            if this_resting and not other_resting:
                                return False, True
                            elif not this_resting and other_resting:
                                pass
                            # When neither arm is resting (both raised), both hands are genuine (clapping, praying, joined hands).
                            # Never delete a hand when both arms are active!

        return True, False

    def _anchor_held_hand_to_body_wrist(
        self,
        hand_key: str,
        previous_hand: Optional[list],
        body: Optional[list],
        width: int,
        height: int,
        torso: float,
    ) -> Optional[list]:
        """Bridge a detailed-hand dropout while the body wrist proves the arm is up.

        HolisticLandmarker can temporarily stop emitting one 21-point hand when
        a palm rotates or remains still, even though its pose branch continues
        to track the wrist.  Reuse the last hand shape, translated to that live
        wrist, instead of deleting the hand and forcing the arm into a fallback
        pose.  A low/resting wrist never qualifies, so hands still release
        promptly when they move down to the desk or leave the frame.
        """
        if not (isinstance(previous_hand, list) and len(previous_hand) >= 21):
            return None
        if not (isinstance(body, list) and len(body) == 33):
            return None

        is_left = hand_key == "leftHand"
        sh_idx = 11 if is_left else 12
        el_idx = 13 if is_left else 14
        wrist_idx = 15 if is_left else 16
        sh_xy = self._point_xy(body[sh_idx])
        el_xy = self._point_xy(body[el_idx])
        wrist_xy = self._point_xy(body[wrist_idx])
        prev_wrist_xy = self._point_xy(previous_hand[0])
        sh_score = self._point_score(body[sh_idx])
        el_score = self._point_score(body[el_idx])
        wrist_score = self._point_score(body[wrist_idx])
        if None in (sh_xy, el_xy, wrist_xy, prev_wrist_xy):
            return None
        if sh_score < 0.18 or el_score < 0.18 or wrist_score < 0.20:
            return None

        def to_pixels(xy):
            if width and height and abs(xy[0]) <= 1.5 and abs(xy[1]) <= 1.5:
                return xy[0] * width, xy[1] * height
            return xy

        sh_px = to_pixels(sh_xy)
        el_px = to_pixels(el_xy)
        wrist_px = to_pixels(wrist_xy)
        if not (0.0 <= wrist_px[0] <= width and 0.0 <= wrist_px[1] <= height):
            return None

        shoulder_reach = ((wrist_px[0] - sh_px[0]) ** 2 + (wrist_px[1] - sh_px[1]) ** 2) ** 0.5
        max_reach = max(torso * 2.3, height * 0.55 if height else 300.0)
        if shoulder_reach > max_reach:
            return None

        # Forearm raised check: wrist level relative to elbow and shoulder.
        wrist_is_raised = bool(
            wrist_px[1] <= el_px[1] + torso * 0.30
            or wrist_px[1] <= sh_px[1] + torso * 0.55
        )
        if not wrist_is_raised or wrist_px[1] >= height * 0.88:
            return None

        previous_is_normalized = bool(
            abs(prev_wrist_xy[0]) <= 1.5 and abs(prev_wrist_xy[1]) <= 1.5
        )
        target_x, target_y = wrist_xy
        if previous_is_normalized and not (
            abs(target_x) <= 1.5 and abs(target_y) <= 1.5
        ):
            target_x /= max(1, width)
            target_y /= max(1, height)
        elif not previous_is_normalized and (
            abs(target_x) <= 1.5 and abs(target_y) <= 1.5
        ):
            target_x *= width
            target_y *= height

        dx = target_x - prev_wrist_xy[0]
        dy = target_y - prev_wrist_xy[1]
        anchored = []
        for point in previous_hand:
            copied = self._fast_copy_point(point)
            xy = self._point_xy(copied)
            if xy is None:
                return None
            x, y = xy[0] + dx, xy[1] + dy
            if isinstance(copied, dict):
                copied["x"] = x
                copied["y"] = y
                copied["score"] = min(0.45, max(0.30, self._point_score(copied)))
                copied["visibility"] = copied["score"]
                if isinstance(copied.get("position"), dict):
                    copied["position"]["x"] = x
                    copied["position"]["y"] = y
            elif isinstance(copied, (list, tuple)):
                copied = [x, y, *list(copied[2:])]
                if len(copied) > 3:
                    copied[3] = min(0.45, max(0.30, float(copied[3])))
            anchored.append(copied)
        return anchored

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

        torso = max(24.0, height * 0.12 if height else 24.0)
        if isinstance(body, list) and len(body) == 33:
            ls, rs = self._point_xy(body[11]), self._point_xy(body[12])
            lh, rh = self._point_xy(body[23]), self._point_xy(body[24])
            if ls and rs:
                shoulder_span = ((ls[0] - rs[0]) ** 2 + (ls[1] - rs[1]) ** 2) ** 0.5
                torso = max(torso, shoulder_span * 1.25)
            if ls and rs and lh and rh:
                shoulder_mid = ((ls[0] + rs[0]) * 0.5, (ls[1] + rs[1]) * 0.5)
                hip_mid = ((lh[0] + rh[0]) * 0.5, (lh[1] + rh[1]) * 0.5)
                torso = max(torso, ((shoulder_mid[0] - hip_mid[0]) ** 2 + (shoulder_mid[1] - hip_mid[1]) ** 2) ** 0.5)

        has_left_hand = self._check_hand_validity(payload.get("leftHand"), "leftHand", body, width, height, torso, now, payload)[0]
        has_right_hand = self._check_hand_validity(payload.get("rightHand"), "rightHand", body, width, height, torso, now, payload)[0]

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
            if ls and rs:
                shoulder_span = ((ls[0] - rs[0]) ** 2 + (ls[1] - rs[1]) ** 2) ** 0.5
                torso = max(torso, shoulder_span * 1.25)
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
                has_hand = has_left_hand if index in {15, 17, 19, 21} else (has_right_hand if index in {16, 18, 20, 22} else False)
                if has_hand and index in {15, 16}:
                    hand_key = "leftHand" if index == 15 else "rightHand"
                    h_obj = payload.get(hand_key)
                    h_w_xy = self._point_xy(h_obj[0]) if (isinstance(h_obj, list) and len(h_obj) >= 21) else None
                    if h_w_xy is not None:
                        # Ground truth priority: Hand landmark 0 is the true physical wrist!
                        xy = h_w_xy
                        score = 0.85
                        part_name = "leftWrist" if index == 15 else "rightWrist"
                        body[index] = {
                            "position": {"x": xy[0], "y": xy[1], "z": 0.0},
                            "x": xy[0], "y": xy[1], "z": 0.0,
                            "score": score, "visibility": score,
                            "part": part_name
                        }
                        point = body[index]
                        accepted[index] = True
                        sane = True

                        # Kinematic arm validation: Ensure elbow connects shoulder and wrist naturally
                        pidx = parent.get(index)  # elbow: 13 for left, 14 for right
                        sh_idx = 11 if index == 15 else 12
                        sh_xy = self._point_xy(body[sh_idx])
                        el_xy = self._point_xy(body[pidx])
                        el_score = self._point_score(body[pidx])

                        need_synth_elbow = False
                        if el_xy is None or el_score < 0.20:
                            need_synth_elbow = True
                        elif sh_xy is not None:
                            dist_se = ((el_xy[0] - sh_xy[0]) ** 2 + (el_xy[1] - sh_xy[1]) ** 2) ** 0.5
                            max_arm_span = max(torso * 2.2, height * 0.45)
                            if dist_se > max_arm_span:
                                need_synth_elbow = True

                        if need_synth_elbow and sh_xy is not None:
                            other_sh_idx = 12 if index == 15 else 11
                            other_sh_pt = body[other_sh_idx] if 0 <= other_sh_idx < len(body) else None
                            other_sh_xy = self._point_xy(other_sh_pt)
                            if other_sh_xy is not None:
                                side_sign = 1.0 if sh_xy[0] >= other_sh_xy[0] else -1.0
                            else:
                                side_sign = 1.0 if index == 15 else -1.0
                            if xy[1] <= sh_xy[1] + torso * 0.40:
                                mx = (sh_xy[0] + xy[0]) * 0.5
                                my = (sh_xy[1] + xy[1]) * 0.5
                                synth_ex = mx + side_sign * max(22.0, torso * 0.22)
                                synth_ey = max(sh_xy[1] + torso * 0.18, my + torso * 0.12)
                            else:
                                synth_ex = sh_xy[0] + side_sign * max(20.0, torso * 0.20)
                                synth_ey = sh_xy[1] + max(40.0, torso * 0.70)
                            el_part = "leftElbow" if pidx == 13 else "rightElbow"
                            body[pidx] = {
                                "position": {"x": synth_ex, "y": synth_ey, "z": 0.0},
                                "x": synth_ex, "y": synth_ey, "z": 0.0,
                                "score": 0.55, "visibility": 0.55,
                                "part": el_part
                            }
                            accepted[pidx] = True

                        el_xy = self._point_xy(body[pidx])
                        if previous is not None:
                            prev_w_xy = self._point_xy(previous[0])
                            if prev_w_xy is not None and xy is not None:
                                dy_w = xy[1] - prev_w_xy[1]
                                moving_thresh = max(6.0, torso * 0.05)
                                is_descending_to_rest = (el_xy is not None and xy[1] >= el_xy[1] - torso * 0.12)
                                self._wrist_moving_down[index] = bool(dy_w > moving_thresh and is_descending_to_rest)
                                self._wrist_moving_up[index] = bool(dy_w < -moving_thresh)
                            else:
                                self._wrist_moving_down[index] = False
                                self._wrist_moving_up[index] = False
                        else:
                            self._wrist_moving_down[index] = False
                            self._wrist_moving_up[index] = False

                        if el_xy is not None and xy is not None:
                            rel_2d = (xy[0] - el_xy[0], xy[1] - el_xy[1])
                            rel_3d = None
                            if isinstance(body3, list) and len(body3) == 33:
                                w_xyz3 = self._point_xyz(body3[index])
                                e_xyz3 = self._point_xyz(body3[pidx])
                                if w_xyz3 is not None and e_xyz3 is not None:
                                    rel_3d = (w_xyz3[0] - e_xyz3[0], w_xyz3[1] - e_xyz3[1], w_xyz3[2] - e_xyz3[2])
                            self._wrist_elbow_rel[index] = (rel_2d, rel_3d)

                        saved3 = copy_fn(body3[index]) if isinstance(body3, list) and len(body3) == 33 else None
                        self._body_last_good[index] = (copy_fn(point), saved3)
                        self._body_last_good_at[index] = now
                        self._joint_recovery[index] = 3
                        continue
                    else:
                        sane = (xy is not None and score >= 0.12)
                else:
                    if index in {15, 17, 19, 21} and has_left_hand:
                        threshold = 0.12
                    elif index in {16, 18, 20, 22} and has_right_hand:
                        threshold = 0.12
                    sane = xy is not None and score >= threshold

                if sane and index in distal:
                    if xy is not None:
                        x, y = xy
                        sane = (0.0 <= x <= width and 0.0 <= y <= height)
                    else:
                        sane = False

                pidx = parent.get(index)
                if sane and pidx is not None:
                    # Child cannot be trusted when its kinematic parent is lost.
                    parent_score = self._point_score(body[pidx])
                    parent_xy = self._point_xy(body[pidx])
                    if parent_xy is None or parent_score < max(0.18, thresholds.get(pidx, 0.18) * 0.75):
                        # Wrists (15, 16): If a real hand is detected, anchor wrist to the hand
                        # and synthesize the elbow between shoulder and wrist.
                        is_smart_sync = getattr(self, "_smart_arm_sync", True)
                        has_hand = has_left_hand if index == 15 else has_right_hand
                        sh_idx = 11 if index == 15 else 12
                        sh_score = self._point_score(body[sh_idx])
                        sh_xy = self._point_xy(body[sh_idx])
                        hand_key = "leftHand" if index == 15 else "rightHand"
                        hand_obj = payload.get(hand_key)
                        h_wrist_xy = self._point_xy(hand_obj[0]) if (isinstance(hand_obj, list) and len(hand_obj) >= 21) else None
                        if index in {15, 16} and has_hand and sh_score >= 0.20 and sh_xy is not None and h_wrist_xy is not None:
                            synth_x, synth_y = h_wrist_xy
                            body[index] = {
                                "position": {"x": synth_x, "y": synth_y, "z": 0.0},
                                "x": synth_x, "y": synth_y, "z": 0.0,
                                "score": max(score, 0.70), "visibility": max(score, 0.70),
                                "part": "leftWrist" if index == 15 else "rightWrist"
                            }
                            xy = (synth_x, synth_y)
                            score = max(score, 0.70)
                            accepted[index] = True
                            sane = True
                            cur_el_sc = self._point_score(body[pidx])
                            cur_el_xy = self._point_xy(body[pidx])
                            el_contradicts_raised = bool(
                                cur_el_xy and h_wrist_xy[1] <= sh_xy[1] + torso * 0.25
                                and cur_el_xy[1] > sh_xy[1] + torso * 0.40
                            )
                            if body[pidx] is None or cur_el_sc < 0.20 or el_contradicts_raised:
                                other_sh_idx = 12 if index == 15 else 11
                                other_sh_pt = body[other_sh_idx] if 0 <= other_sh_idx < len(body) else None
                                other_sh_xy = self._point_xy(other_sh_pt)
                                if other_sh_xy is not None:
                                    side_sign = 1.0 if sh_xy[0] >= other_sh_xy[0] else -1.0
                                else:
                                    side_sign = 1.0 if index == 15 else -1.0
                                if h_wrist_xy[1] <= sh_xy[1] + torso * 0.40:
                                    # Hand is raised: natural triangular bend outward between shoulder and hand
                                    mx = (sh_xy[0] + h_wrist_xy[0]) * 0.5
                                    my = (sh_xy[1] + h_wrist_xy[1]) * 0.5
                                    synth_ex = mx + side_sign * max(22.0, torso * 0.22)
                                    synth_ey = max(sh_xy[1] + torso * 0.18, my + torso * 0.12)
                                else:
                                    synth_ex = sh_xy[0] + side_sign * max(20.0, torso * 0.20)
                                    synth_ey = sh_xy[1] + max(40.0, torso * 0.70)
                                body[pidx] = {
                                    "position": {"x": synth_ex, "y": synth_ey, "z": 0.0},
                                    "x": synth_ex, "y": synth_ey, "z": 0.0,
                                    "score": 0.50, "visibility": 0.50,
                                    "part": "leftElbow" if pidx == 13 else "rightElbow"
                                }
                                accepted[pidx] = True
                        elif is_smart_sync and index in {15, 16} and sh_score >= 0.25 and sh_xy is not None and ((has_hand and score >= 0.25) or (score >= 0.50 and xy is not None and xy[1] <= sh_xy[1] + torso * 0.40)):
                            if body[pidx] is None or self._point_score(body[pidx]) < 0.20:
                                other_sh_idx = 12 if index == 15 else 11
                                other_sh_pt = body[other_sh_idx] if 0 <= other_sh_idx < len(body) else None
                                other_sh_xy = self._point_xy(other_sh_pt)
                                if other_sh_xy is not None:
                                    side_sign = 1.0 if sh_xy[0] >= other_sh_xy[0] else -1.0
                                else:
                                    side_sign = 1.0 if index == 15 else -1.0
                                if xy[1] <= sh_xy[1] + torso * 0.40:
                                    mx = (sh_xy[0] + xy[0]) * 0.5
                                    my = (sh_xy[1] + xy[1]) * 0.5
                                    synth_ex = mx + side_sign * max(22.0, torso * 0.22)
                                    synth_ey = max(sh_xy[1] + torso * 0.18, my + torso * 0.12)
                                else:
                                    synth_ex = sh_xy[0] + side_sign * max(20.0, torso * 0.20)
                                    synth_ey = sh_xy[1] + max(40.0, torso * 0.70)
                                body[pidx] = {
                                    "position": {"x": synth_ex, "y": synth_ey, "z": 0.0},
                                    "x": synth_ex, "y": synth_ey, "z": 0.0,
                                    "score": 0.40, "visibility": 0.40,
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
                    is_rising = getattr(self, "_wrist_moving_up", {}).get(index, False)
                    target_rec = 1 if (has_hand or score >= 0.40 or is_rising) else 2
                    if self._joint_recovery[index] < target_rec:
                        sane = False
                elif sane:
                    self._joint_recovery[index] = 3
                else:
                    self._joint_recovery[index] = 0

                if sane:
                    if index in {13, 14} and previous is not None:
                        prev_score = self._point_score(previous[0])
                        # Only apply LERP smoothing when re-acquiring an elbow from occlusion/synthesis
                        if prev_score < 0.25:
                            prev_xy = self._point_xy(previous[0])
                            prev_age = now - self._body_last_good_at[index]
                            if prev_xy is not None and prev_age <= 0.35:
                                lerp_k = 0.60
                                lx = prev_xy[0] * (1.0 - lerp_k) + xy[0] * lerp_k
                                ly = prev_xy[1] * (1.0 - lerp_k) + xy[1] * lerp_k
                                point["x"] = lx
                                point["y"] = ly
                                if isinstance(point.get("position"), dict):
                                    point["position"]["x"] = lx
                                    point["position"]["y"] = ly
                                xy = (lx, ly)
                    saved3 = copy_fn(body3[index]) if isinstance(body3, list) and len(body3) == 33 else None
                    self._body_last_good[index] = (copy_fn(point), saved3)
                    self._body_last_good_at[index] = now
                    accepted[index] = True
                    # Record relative wrist->elbow and hand->wrist offsets when sane
                    if index in {15, 16}:
                        el_idx = 13 if index == 15 else 14
                        el_xy = self._point_xy(body[el_idx]) if 0 <= el_idx < len(body) else None
                        if previous is not None:
                            prev_w_xy = self._point_xy(previous[0])
                            if prev_w_xy is not None and xy is not None:
                                dy_w = xy[1] - prev_w_xy[1]
                                moving_thresh = max(6.0, torso * 0.05)
                                is_descending_to_rest = (el_xy is not None and xy[1] >= el_xy[1] - torso * 0.12)
                                self._wrist_moving_down[index] = bool(dy_w > moving_thresh and is_descending_to_rest)
                                self._wrist_moving_up[index] = bool(dy_w < -moving_thresh)
                            else:
                                self._wrist_moving_down[index] = False
                                self._wrist_moving_up[index] = False
                        else:
                            self._wrist_moving_down[index] = False
                            self._wrist_moving_up[index] = False
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
                    # If wrist is not sane/not detected on this frame, it is not actively rising
                    self._wrist_moving_up[index] = False
                    is_left = (index == 15)
                    sh_idx = 11 if is_left else 12
                    el_idx = 13 if is_left else 14
                    other_sh_idx = 12 if is_left else 11
                    part_name = "leftWrist" if is_left else "rightWrist"
                    name3 = "left_wrist" if is_left else "right_wrist"

                    sh_pt = body[sh_idx] if 0 <= sh_idx < len(body) else None
                    el_pt = body[el_idx] if 0 <= el_idx < len(body) else None
                    other_sh_pt = body[other_sh_idx] if 0 <= other_sh_idx < len(body) else None
                    sh_xy = self._point_xy(sh_pt)
                    el_xy = self._point_xy(el_pt)
                    other_sh_xy = self._point_xy(other_sh_pt)
                    sh_score = self._point_score(sh_pt)
                    el_score = self._point_score(el_pt)
                    if sh_xy is not None and other_sh_xy is not None:
                        side_sign = 1.0 if sh_xy[0] >= other_sh_xy[0] else -1.0
                    else:
                        side_sign = 1.0 if is_left else -1.0

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
                            if dy_se <= 0.0:
                                arm_active = True
                            elif has_hand:
                                if (u_y <= 0.85 and dy_se <= torso * 0.50) or (u_x >= 0.38 and dy_se <= torso * 0.40) or (abs(dx_se) >= max(35.0, torso * 0.45) and dy_se <= torso * 0.35):
                                    arm_active = True
                            elif rel and rel[0] is not None and rel[0][1] < -torso * 0.10 and age <= 0.35:
                                hand_key = "leftHand" if is_left else "rightHand"
                                was_moving_down = getattr(self, "_hand_moving_down", {}).get(hand_key, False) or getattr(self, "_wrist_moving_down", {}).get(index, False)
                                if not was_moving_down:
                                    arm_active = True

                    debug_arm = os.environ.get("XRA_DEBUG_ARM", "0") in {"1", "true", "yes"}
                    if debug_arm:
                        print(f"[{time.strftime('%H:%M:%S')}.{int(time.time()*1000)%1000:03d}] [XRA_CAPTURE_ARM] {part_name}: arm_active={arm_active} el_score={el_score:.2f} rising={getattr(self, '_wrist_moving_up', {}).get(index, False)}", flush=True)

                    if is_smart_sync and arm_active and el_xy is not None:
                        # 1. Arm is active in space: DO NOT put to rest!
                        # Wrist dynamically tracks relative to elbow (forearm follows elbow movement)
                        se_len = max(1.0, (dx_se * dx_se + dy_se * dy_se) ** 0.5)
                        forearm_len = max(35.0, torso * 0.65)
                        if rel and rel[0] is not None:
                            f_dx, f_dy = rel[0]
                            rel_3d = rel[1]
                            # If upper arm is pointing down and wrist was pointing up, do not keep it up if hand is absent
                            if dy_se > 0 and f_dy < 0 and not has_hand:
                                f_dx = (dx_se / se_len) * forearm_len
                                f_dy = abs(dy_se / se_len) * forearm_len
                                rel_3d = None
                                self._wrist_elbow_rel[index] = None
                        else:
                            f_dx = (dx_se / se_len) * forearm_len
                            f_dy = abs(dy_se / se_len) * forearm_len
                            rel_3d = None
                            self._wrist_elbow_rel[index] = None

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
                    else:
                        hand_key = "leftHand" if is_left else "rightHand"
                        was_moving_down = getattr(self, "_hand_moving_down", {}).get(hand_key, False) or getattr(self, "_wrist_moving_down", {}).get(index, False)
                        max_wrist_grace = 0.05 if was_moving_down else 0.18
                        if previous is not None and age <= max_wrist_grace:
                            # 2. Arm is occluded, within grace period (absorbs transient webcam jitter)
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
                            accepted[index] = True
                        else:
                            # 3. Arm downward and occluded: naturally transition to rest!
                            self._body_last_good[index] = None
                            self._wrist_moving_down[index] = False
                            self._wrist_elbow_rel[index] = None
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
                                    side_sign_3d = 1.0 if float(sh_xyz3[0]) >= 0 else -1.0
                                    res_x = sh_xyz3[0] + side_sign_3d * 0.05
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
                    other_sh_idx = 12 if is_left else 11
                    part_name = "leftElbow" if is_left else "rightElbow"
                    name3 = "left_elbow" if is_left else "right_elbow"

                    sh_pt = body[sh_idx] if 0 <= sh_idx < len(body) else None
                    other_sh_pt = body[other_sh_idx] if 0 <= other_sh_idx < len(body) else None
                    sh_xy = self._point_xy(sh_pt)
                    other_sh_xy = self._point_xy(other_sh_pt)
                    if sh_xy is not None and other_sh_xy is not None:
                        side_sign = 1.0 if sh_xy[0] >= other_sh_xy[0] else -1.0
                    else:
                        side_sign = 1.0 if is_left else -1.0

                    w_idx = 15 if is_left else 16
                    w_pt = body[w_idx] if 0 <= w_idx < len(body) else None
                    w_xy = self._point_xy(w_pt)
                    w_score = self._point_score(w_pt)
                    has_hand = has_left_hand if is_left else has_right_hand

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
                        is_hand_up = (sh_xy is not None and w_xy is not None and (w_score >= 0.20 or has_hand) and w_xy[1] <= sh_xy[1] + torso * 0.40)
                        if sh_xy:
                            if is_hand_up:
                                mx = (sh_xy[0] + w_xy[0]) * 0.5
                                my = (sh_xy[1] + w_xy[1]) * 0.5
                                proj_x = mx + side_sign * max(18.0, torso * 0.22)
                                proj_y = max(sh_xy[1] + torso * 0.18, my + torso * 0.12)
                                synth_sc = 0.18
                            else:
                                proj_x = sh_xy[0] + side_sign * 15.0
                                proj_y = sh_xy[1] + max(torso * 0.85, 70.0)
                                synth_sc = 0.0

                            body[index] = {
                                "position": {"x": proj_x, "y": proj_y, "z": 0.0},
                                "x": proj_x, "y": proj_y, "z": 0.0,
                                "score": synth_sc, "visibility": synth_sc, "part": part_name
                            }
                        if isinstance(body3, list) and len(body3) == 33:
                            sh_pt3 = body3[sh_idx] if 0 <= sh_idx < len(body3) else None
                            sh_xyz3 = self._point_xyz(sh_pt3)
                            w_pt3 = body3[w_idx] if 0 <= w_idx < len(body3) else None
                            w_xyz3 = self._point_xyz(w_pt3) if w_pt3 else None
                            if sh_xyz3:
                                side_sign_3d = 1.0 if float(sh_xyz3[0]) >= 0 else -1.0
                                if is_hand_up and w_xyz3:
                                    mx3 = (sh_xyz3[0] + w_xyz3[0]) * 0.5 + side_sign_3d * 0.08
                                    my3 = max(sh_xyz3[1] + 0.12, (sh_xyz3[1] + w_xyz3[1]) * 0.5 + 0.06)
                                    mz3 = (sh_xyz3[2] + w_xyz3[2]) * 0.5 - 0.04
                                    body3[index] = {
                                        "position": {"x": mx3, "y": my3, "z": mz3},
                                        "x": mx3, "y": my3, "z": mz3,
                                        "score": synth_sc, "visibility": synth_sc, "name": name3
                                    }
                                else:
                                    body3[index] = {
                                        "position": {"x": sh_xyz3[0] + side_sign_3d * 0.03, "y": sh_xyz3[1] + 0.27, "z": sh_xyz3[2]},
                                        "x": sh_xyz3[0] + side_sign_3d * 0.03, "y": sh_xyz3[1] + 0.27, "z": sh_xyz3[2],
                                        "score": 0.0, "visibility": 0.0, "name": name3
                                    }
                        if is_hand_up and sh_xy:
                            self._body_last_good[index] = (copy_fn(body[index]), copy_fn(body3[index]) if isinstance(body3, list) and len(body3) == 33 else None)
                            self._body_last_good_at[index] = now
                        else:
                            self._body_last_good[index] = None
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

        # Evaluate both raw candidates before modifying either payload entry.
        # This keeps a fallback for one side from influencing the other side's
        # duplicate/superposition checks.
        raw_hands = {key: payload.get(key) for key in ("leftHand", "rightHand")}
        hand_validity = {
            key: self._check_hand_validity(raw_hands[key], key, body, width, height, torso, now, payload)
            for key in ("leftHand", "rightHand")
        }
        previous_hands = {
            key: self._hand_last_good.get(key) for key in ("leftHand", "rightHand")
        }
        contact_metrics, contact_pair_untrusted = self._update_hands_contact_state(
            raw_hands, hand_validity, width, height, now
        )

        for key in ("leftHand", "rightHand"):
            hand = raw_hands[key]
            is_valid, is_phantom = hand_validity[key]

            previous_hand = previous_hands[key]
            was_live = self._hand_was_live.get(key, False)
            age = now - self._hand_last_good_at.get(key, 0.0)
            world_key = self._hand_world_key(key)
            world_candidate = payload.get(world_key)

            # Once two independently observed hands have made contact, treat
            # them as a coupled pair across a short occlusion.  This is evaluated
            # before the body-wrist fallback because wrists are often the first
            # pose landmarks to become unreliable in front of the face.
            contact_hand = None
            if self._hands_contact_active and (not is_valid or contact_pair_untrusted):
                contact_hand = self._contact_held_hand(
                    key, previous_hands, raw_hands, hand_validity,
                    contact_metrics, width, height,
                )
            if contact_hand is not None:
                payload[key] = contact_hand
                self._hand_last_good[key] = [copy_fn(p) for p in contact_hand]
                self._hand_was_live[key] = True
                self._hand_body_fallback[key] = True
                self._hand_moving_down[key] = False
                held_world = self._hand_world_last_good.get(key)
                payload[world_key] = held_world if isinstance(held_world, list) else []
                continue

            if is_valid and isinstance(hand, list):
                smoothed_hand = [copy_fn(p) for p in hand]
                payload[key] = smoothed_hand
                # Track downward hand motion
                is_moving_down = False
                if previous_hand and len(previous_hand) > 0:
                    prev_p = self._point_xy(previous_hand[0])
                    curr_p = self._point_xy(smoothed_hand[0])
                    if prev_p and curr_p:
                        dy = curr_p[1] - prev_p[1]
                        is_moving_down = dy > (0.005 if curr_p[1] <= 1.5 else 2.0)
                self._hand_moving_down[key] = is_moving_down
                self._hand_last_good[key] = [copy_fn(p) for p in smoothed_hand]
                self._hand_last_good_at[key] = now
                self._hand_was_live[key] = True
                self._hand_body_fallback[key] = False
                if isinstance(world_candidate, list) and len(world_candidate) >= 21:
                    self._hand_world_last_good[key] = world_candidate
                else:
                    self._hand_world_last_good[key] = None

                curl_source = (
                    world_candidate
                    if isinstance(world_candidate, list) and len(world_candidate) >= 21
                    else smoothed_hand
                )
                curl = self._hand_bend_score(curl_source)
                if curl >= 0.22:
                    self._hand_fist_state[key] = True
                elif curl <= 0.12:
                    self._hand_fist_state[key] = False
            else:
                anchored_hand = self._anchor_held_hand_to_body_wrist(
                    key, previous_hand, body, width, height, torso
                )
                if anchored_hand is not None:
                    payload[key] = anchored_hand
                    # Keep the translated shape as next frame's spatial base,
                    # but retain last_good_at as the age of the last *real*
                    # hand detection.  Reacquisition therefore still uses the
                    # stricter new-candidate confidence rules.
                    self._hand_last_good[key] = [copy_fn(p) for p in anchored_hand]
                    self._hand_was_live[key] = True
                    self._hand_body_fallback[key] = True
                    self._hand_moving_down[key] = False
                    held_world = self._hand_world_last_good.get(key)
                    payload[world_key] = held_world if isinstance(held_world, list) else []
                    continue

                if is_phantom:
                    # A closed fist self-occludes many finger joints and can be
                    # classified as a malformed candidate for a few frames.
                    # Preserve only a previously confirmed fist, never infer a
                    # fist from a missing/open hand.
                    if (
                        self._hand_fist_state.get(key, False)
                        and previous_hand is not None
                        and was_live
                        and age <= 0.65
                    ):
                        payload[key] = [copy_fn(p) for p in previous_hand]
                        held_world = self._hand_world_last_good.get(key)
                        payload[world_key] = held_world if isinstance(held_world, list) else []
                        self._hand_body_fallback[key] = True
                        self._hand_moving_down[key] = False
                        continue
                    # Phantom detection: drop immediately, do NOT hold!
                    payload[key] = []
                    payload[world_key] = []
                    if previous_hand is not None:
                        self._dropped_hands += 1
                    self._hand_last_good[key] = None
                    self._hand_world_last_good[key] = None
                    self._hand_was_live[key] = False
                    self._hand_fist_state[key] = False
                    self._hand_body_fallback[key] = False
                    self._hand_moving_down[key] = False
                else:
                    # Holding block: If the hand was live recently, hold position linearly
                    # across short tracking gaps to prevent flashing/drops.
                    was_moving_down = getattr(self, "_hand_moving_down", {}).get(key, False)
                    prev_wrist_xy = self._point_xy(previous_hand[0]) if (previous_hand and len(previous_hand) > 0) else None
                    prev_y_norm = (prev_wrist_xy[1] / height) if (prev_wrist_xy and height and prev_wrist_xy[1] > 1.5) else (prev_wrist_xy[1] if prev_wrist_xy else 0.5)
                    is_low_hand = prev_y_norm > 0.58
                    # A raised hand gets a longer temporal bridge for brief
                    # Holistic dropouts.  Deliberate lowering/desk motion still
                    # releases in ~80 ms, so this does not make resting hands
                    # sticky.  Longer gaps are handled only when a raised body
                    # wrist corroborates them (see _anchor_held_hand_to_body_wrist).
                    max_hold_sec = 0.08 if (was_moving_down or is_low_hand) else 0.65

                    # Anti-ghosting: if the other hand is active near this held position,
                    # or if handedness flipped to the other hand, do NOT hold duplicate!
                    other_hand = payload.get("rightHand" if key == "leftHand" else "leftHand")
                    is_other_active = isinstance(other_hand, list) and len(other_hand) >= 21
                    is_coincident = False
                    if is_other_active and prev_wrist_xy:
                        ow_xy = self._point_xy(other_hand[0])
                        if ow_xy:
                            ow_px = (ow_xy[0] * width, ow_xy[1] * height) if (width and ow_xy[0] <= 1.5) else ow_xy
                            pw_px = (prev_wrist_xy[0] * width, prev_wrist_xy[1] * height) if (width and prev_wrist_xy[0] <= 1.5) else prev_wrist_xy
                            d_other = ((pw_px[0] - ow_px[0]) ** 2 + (pw_px[1] - ow_px[1]) ** 2) ** 0.5
                            if d_other < max(torso * 0.20, 60.0):
                                is_coincident = True

                    if previous_hand is not None and age <= max_hold_sec and was_live and not is_coincident:
                        held_hand = []
                        for p in previous_hand:
                            held_hand.append(copy_fn(p))
                        payload[key] = held_hand
                        held_world = self._hand_world_last_good.get(key)
                        payload[world_key] = held_world if isinstance(held_world, list) else []
                    else:
                        payload[key] = []
                        payload[world_key] = []
                        if previous_hand is not None:
                            self._dropped_hands += 1
                            self._hand_last_good[key] = None
                            self._hand_world_last_good[key] = None
                            self._hand_was_live[key] = False
                            self._hand_fist_state[key] = False
                            self._hand_body_fallback[key] = False
                            self._hand_moving_down[key] = False
        if self._hands_contact_active:
            payload["_hands_contact_active"] = True
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
        tracking_raw = None
        try:
            payload = engine.ENGINE.infer(frame)
            raw_summary = self._landmark_summary(payload, frame.shape[1], frame.shape[0])
            if self._tracking_log_enabled:
                tracking_raw = self._tracking_log_snapshot(payload)
            if payload is not None:
                payload = self._stabilize_payload(payload, frame.shape[1], frame.shape[0])
            # Auto-unstick / Phantom suppression:
            raw_span = raw_summary.get("shoulder_span_px", 0.0) if raw_summary else 0.0
            raw_face_pts = raw_summary.get("face_points", 0) if raw_summary else 0
            now_mono = time.monotonic()
            if raw_face_pts == 0 and 0.0 < raw_span < 55.0:
                # Phantom noise detected on background object while user is away; suppress it.
                payload = None
                self._phantom_counter += 1
                if self._phantom_counter >= 15 and (now_mono - self._last_unstick_at) >= 5.0:
                    self._phantom_counter = 0
                    self._last_unstick_at = now_mono
                    # Feed a blank frame to reset MediaPipe's tracking ROI to full-frame detection
                    # without reloading the engine from disk.
                    try:
                        engine.ENGINE.infer(np.zeros_like(frame))
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
        tracking_stable = (
            self._tracking_log_snapshot(payload)
            if self._tracking_log_enabled else None
        )
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

        if getattr(self, "_was_empty", False) and not is_empty:
            # User just re-entered camera view!
            # Snap latency EMA immediately to fresh tracking latency (capped at 22ms)
            # so the capture loop and scheduler immediately recover 30 FPS without lag.
            self._infer_ms_ema = min(self._last_infer_ms, 22.0)
            self._work_ms_ema = min(self._last_work_ms, 24.0)
            self._empty_frames_count = 0
            self._deadline_misses = 0
            self._just_recovered = True
        elif is_empty:
            self._empty_frames_count = getattr(self, "_empty_frames_count", 0) + 1
        else:
            self._empty_frames_count = 0
        self._was_empty = is_empty

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
        if tracking_raw is not None and tracking_stable is not None:
            timestamp_ms = int(self._last_frame_at * 1000)
            self._queue_tracking_log({
                "type": "frame",
                "frame_id": self._frames,
                "timestamp_ms": timestamp_ms,
                "elapsed_ms": max(0, timestamp_ms - self._tracking_log_started_ms),
                "inference_ms": round(self._last_infer_ms, 3),
                "capture": list(self._last_raw_geometry),
                "inference": [width, height],
                "raw": tracking_raw,
                "stable": tracking_stable,
                "state": {
                    "left_fallback": bool(self._hand_body_fallback.get("leftHand")),
                    "right_fallback": bool(self._hand_body_fallback.get("rightHand")),
                    "left_fist": bool(self._hand_fist_state.get("leftHand")),
                    "right_fist": bool(self._hand_fist_state.get("rightHand")),
                    "hands_contact": bool(self._hands_contact_active),
                    "held_joints": self._held_joints - held_before,
                    "deadline_misses": self._deadline_misses,
                },
            })
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
        source_frame_id = wire.get("frame_id")
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
        if self._tracking_log_enabled:
            timestamp_ms = int(self._last_frame_at * 1000)
            self._queue_tracking_log({
                "type": "cached",
                "frame_id": self._frames,
                "source_frame_id": source_frame_id,
                "timestamp_ms": timestamp_ms,
                "elapsed_ms": max(0, timestamp_ms - self._tracking_log_started_ms),
                "reason": "adaptive_frame_skip",
                "stable": self._tracking_log_snapshot(wire),
                "state": {"deadline_misses": self._deadline_misses},
            })
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
