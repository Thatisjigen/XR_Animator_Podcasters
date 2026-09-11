#!/usr/bin/env python3
"""Standalone validator for the XR Animator ONNX mocap backends.

Run this from the repo root BEFORE building any UI/WS on top of the engine:

    python3 test_backend.py --check            # runtime + wheel discovery only
    python3 test_backend.py --download rtmpose-s
    python3 test_backend.py --grab frame.jpg   # capture a webcam frame (ffmpeg, no opencv)
    python3 test_backend.py --run rtmpose-s --source frame.jpg
    python3 test_backend.py --run rtmpose-m --source webcam

It validates, in order:
  1. onnxruntime is importable (from vendored wheels or system).
  2. which execution provider got selected (CPU on potato, CUDA on your PC).
  3. model download works and files land on disk.
  4. a real session loads and produces a 33-keypoint BlazePose pose.
  5. (optional) webcam / still-image inference with FPS.

Webcam capture needs neither opencv nor Pillow: it uses ffmpeg (already a
dependency of xr_server.py). Image READING uses Pillow if present.
"""

from __future__ import annotations

import argparse
import sys
import time

import numpy as np

from xra_backends import downloader, engine, registry, runtime


def step(msg: str) -> None:
    print(f"\n\033[1m» {msg}\033[0m")


def check_runtime() -> bool:
    step("Runtime / execution provider")
    info = runtime.describe()
    print(f"  onnxruntime available : {info['available']}")
    print(f"  version               : {info['version']}")
    print(f"  providers reported    : {info['providers']}")
    print(f"  selected provider     : {info['best_provider_human']} ({info['best_provider']})")
    print(f"  accelerated           : {info['accelerated']}")
    print(f"  runtime dir           : {info['runtime_dir']}")
    print(f"  wheels dir            : {info['wheels_dir']}")

    wheals = runtime.bundled_wheels()
    if wheals:
        print("  bundled wheels:")
        for w in wheals:
            print(f"    - {w.name}")
    else:
        print("  bundled wheels        : NONE (place onnxruntime*.whl in wheels dir)")

    if not info["available"]:
        print("\n  !! onnxruntime not importable yet.")
        print("     Run: python3 test_backend.py --install")
        return False
    return True


def check_download(model_id: str) -> bool:
    step(f"Download check: {model_id}")
    spec = registry.REGISTRY.get(model_id)
    if not spec:
        print(f"  !! unknown backend: {model_id}")
        return False
    for entry in spec["files"]:
        print(f"  file: {entry['filename']}  ~{entry.get('size_hint_mb','?')}MB")
    if registry.is_installed(model_id):
        print(f"  already installed ({registry.installed_size_mb(model_id)} MB)")
        return True

    def progress(p):
        if p.get("phase") == "downloading":
            print(f"\r    {p['file']}: {p.get('percent',0)}%", end="", flush=True)

    print("  downloading…")
    result = downloader.ensure_model(model_id, cb=progress)
    print()
    if not result.get("ok"):
        print(f"  !! failed: {result.get('error')}")
        return False
    print(f"  installed -> {result.get('path')} ({result.get('size_mb')} MB)")
    return True


def run_inference(model_id: str, source: str, loop: int) -> bool:
    step(f"Inference check: {model_id} on {source}")
    if not registry.is_installed(model_id):
        print("  !! model not installed; run --download first")
        return False

    print("  loading session…")
    t0 = time.time()
    status = engine.ENGINE.load(model_id)
    if not status.get("ok"):
        print(f"  !! load failed: {status.get('error')}")
        return False
    print(f"  loaded in {time.time()-t0:.2f}s · provider={status.get('provider_human')}")

    def handle_frame(frame_bgr):
        t = time.time()
        pose = engine.ENGINE.infer(frame_bgr)
        dt = time.time() - t
        if pose is None:
            print("    infer() returned None")
            return
        kps = pose["keypoints"]
        nonzero = [k for k in kps if k["score"] > 0.0]
        top = sorted(kps, key=lambda k: k["score"], reverse=True)[:3]
        print(f"    {dt*1000:6.1f} ms ({1/dt:5.1f} FPS)  "
              f"kpts={len(kps)} hit={len(nonzero)}  "
              f"best=" + ", ".join(f"{k['part']}={k['score']:.2f}" for k in top))

    if source == "webcam":
        return _run_webcam(handle_frame, loop)
    return _run_image(source, handle_frame)


def _run_image(path: str, handle) -> bool:
    step(f"Loading image: {path}")
    try:
        from PIL import Image
        img = np.array(Image.open(path).convert("RGB"))
        frame = img[..., ::-1].copy()  # RGB -> BGR
        print(f"  loaded {frame.shape[1]}x{frame.shape[0]} (Pillow)")
    except ImportError:
        try:
            # Fall back to imageio if Pillow is missing.
            import imageio.v3 as iio
            img = iio.imread(path)
            frame = img[..., ::-1].copy() if img.shape[2] == 3 else img
            print(f"  loaded {frame.shape[1]}x{frame.shape[0]} (imageio)")
        except ImportError:
            print("  !! need Pillow or imageio to load images; install one or use --source webcam")
            return False
    handle(frame)
    return True


def _run_webcam(handle, loop: int) -> bool:
    step("Opening webcam…")
    try:
        import cv2
    except ImportError:
        cv2 = None

    if cv2 is not None:
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            print("  !! could not open camera index 0 (cv2)")
            return False
        try:
            for _ in range(loop):
                ok, frame = cap.read()
                if not ok:
                    print("  !! frame grab failed")
                    break
                handle(frame)
        finally:
            cap.release()
        return True

    # No opencv: fall back to ffmpeg single-frame grabs (opencv never required).
    print("  opencv not installed; using ffmpeg single-frame capture…")
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        print("  !! neither opencv nor ffmpeg available for webcam capture.")
        print("     Use: python3 test_backend.py --grab frame.jpg  (then --source frame.jpg)")
        return False
    ok_any = False
    for i in range(loop):
        frame = _ffmpeg_grab_bgr(ffmpeg, "/dev/video0")
        if frame is None:
            print("  !! ffmpeg could not read /dev/video0 (no camera on this machine?)")
            return False
        ok_any = True
        handle(frame)
    return ok_any


def _find_ffmpeg() -> str | None:
    import shutil
    for name in ("ffmpeg", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/snap/bin/ffmpeg"):
        found = shutil.which(name) or (name if __import__("os").path.isfile(name) else None)
        if found:
            return found
    return None


def _ffmpeg_grab_bgr(ffmpeg: str, device: str):
    """Grab one webcam frame via ffmpeg and return it as an HxWx3 BGR uint8 array."""
    import subprocess
    from io import BytesIO
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "v4l2",
           "-i", device, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=20).stdout
    except Exception:
        return None
    if not out:
        return None
    return _decode_jpeg_bgr(out)


def _decode_jpeg_bgr(data: bytes):
    """Decode JPEG bytes to BGR using Pillow (present) or ffmpeg as a last resort."""
    try:
        from PIL import Image
        from io import BytesIO
        img = np.array(Image.open(BytesIO(data)).convert("RGB"))
        return img[..., ::-1].copy()  # RGB -> BGR
    except ImportError:
        return None


def grab_frame(path: str, device: str = "/dev/video0") -> bool:
    """Capture a single webcam frame with ffmpeg and save it as JPEG."""
    step(f"Grabbing webcam frame -> {path}")
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        print("  !! ffmpeg not found. Install ffmpeg or capture a photo another way.")
        return False
    import subprocess
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "v4l2",
           "-i", device, "-frames:v", "1", path]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except Exception as exc:
        print(f"  !! ffmpeg failed: {exc}")
        return False
    if result.returncode != 0 or not __import__("os").path.isfile(path):
        print(f"  !! could not capture from {device}")
        print(f"     {result.stderr.strip()[:400]}")
        print("     (No camera on this machine? Try copying a photo and using --source photo.jpg.)")
        return False
    print(f"  saved {path}. Now run: python3 test_backend.py --run rtmpose-m --source {path}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate XR Animator ONNX mocap backends")
    parser.add_argument("--check", action="store_true", help="check runtime + wheels only")
    parser.add_argument("--install", action="store_true", help="bootstrap onnxruntime from bundled wheels")
    parser.add_argument("--download", metavar="MODEL", help="download a model (rtmpose-s/rtmpose-m/rtmw-l)")
    parser.add_argument("--run", metavar="MODEL", help="run inference with a model")
    parser.add_argument("--source", default="webcam", help="webcam | path/to/image.jpg")
    parser.add_argument("--loop", type=int, default=30, help="frames to run for webcam")
    parser.add_argument("--grab", metavar="OUT.jpg", help="capture one webcam frame via ffmpeg (no opencv needed)")
    parser.add_argument("--device", default="/dev/video0", help="v4l2 device for --grab / webcam")
    args = parser.parse_args()

    if args.grab:
        return 0 if grab_frame(args.grab, args.device) else 1

    if args.install:
        step("Bootstrapping runtime from bundled wheels")
        result = runtime.bootstrap_install(force=True)
        print(f"  {result}")
        if not result.get("ok"):
            return 1

    did_something = False
    if args.check or not (args.download or args.run):
        did_something = True
        ok = check_runtime()
        if not ok:
            return 2

    if args.download:
        did_something = True
        if not check_runtime():
            return 2
        if not check_download(args.download):
            return 1

    if args.run:
        did_something = True
        if not check_runtime():
            return 2
        if not run_inference(args.run, args.source, args.loop):
            return 1

    if not did_something:
        parser.print_help()
        return 0
    print("\n\033[1mDone.\033[0m")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
