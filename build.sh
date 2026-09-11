#!/usr/bin/env bash
set -Eeuo pipefail

# Resolve the repository root without word-splitting. This remains safe when the
# checkout lives in a path such as "/home/user/XR Animator Podcasters".
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$ROOT_DIR"

PYTHON_VERSION="3.11"
VENV_DIR="$ROOT_DIR/.venv311"
PYTHON_BIN="$VENV_DIR/bin/python"
MEDIAPIPE_VERSION="0.10.21"
ORT_PROFILE="${XRA_ORT_PROFILE:-universal}"
ORT_GPU_SPEC="${XRA_ORT_GPU_BUNDLED_SPEC:-onnxruntime-gpu[cuda,cudnn]>=1.21,<1.27}"
ORT_CPU_SPEC="${XRA_ORT_CPU_SPEC:-onnxruntime>=1.21,<1.27}"
OPENVINO_SPEC="${XRA_OPENVINO_SPEC:-openvino>=2025.0,<2027}"
WHEELS_DIR="$ROOT_DIR/xra_backends/wheels"
RUNTIME_DIR="$ROOT_DIR/xra_backends/runtime"
BUNDLE_DIR="$ROOT_DIR/release/XR_Animator_Bundled"
OFFLINE="${XRA_OFFLINE:-0}"

cleanup_files=()
cleanup() {
  local item
  for item in "${cleanup_files[@]:-}"; do
    [ -n "$item" ] && rm -f -- "$item" 2>/dev/null || true
  done
}
trap cleanup EXIT

echo "=================================================="
echo " XR Animator v9.2 - bundled NW.js build"
echo " Python 3.11 + CUDA/cuDNN + OpenVINO + CPU fallback"
echo "=================================================="
echo "Repository: $ROOT_DIR"

create_venv() {
  mkdir -p -- "$(dirname -- "$VENV_DIR")"
  if command -v uv >/dev/null 2>&1; then
    echo "[build] Creating Python $PYTHON_VERSION venv with uv..."
    uv venv --python "$PYTHON_VERSION" --seed -- "$VENV_DIR"
  elif command -v python3.11 >/dev/null 2>&1; then
    echo "[build] Creating Python $PYTHON_VERSION venv with python3.11..."
    python3.11 -m venv "$VENV_DIR"
  else
    echo "ERROR: Python 3.11 or uv is required to build XR Animator." >&2
    exit 2
  fi
}

if [ -x "$PYTHON_BIN" ]; then
  actual="$($PYTHON_BIN -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  if [ "$actual" != "$PYTHON_VERSION" ]; then
    backup="$VENV_DIR.incompatible.$(date +%Y%m%d-%H%M%S)"
    echo "[build] Existing venv is Python $actual; moving it to: $backup"
    mv -- "$VENV_DIR" "$backup"
    create_venv
  fi
else
  create_venv
fi

if [ ! -x "$PYTHON_BIN" ]; then
  echo "ERROR: venv creation did not produce: $PYTHON_BIN" >&2
  exit 2
fi

ensure_pip() {
  if "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
    return 0
  fi

  echo "[build] pip is missing from .venv311; bootstrapping it..."
  if "$PYTHON_BIN" -m ensurepip --upgrade >/dev/null 2>&1 && \
     "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
    return 0
  fi

  if [ "$OFFLINE" = "1" ]; then
    echo "ERROR: pip is missing and XRA_OFFLINE=1 prevents downloading get-pip.py." >&2
    exit 5
  fi

  local get_pip="$(mktemp "${TMPDIR:-/tmp}/xra-get-pip.XXXXXX.py")"
  cleanup_files+=("$get_pip")

  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 15 \
      https://bootstrap.pypa.io/get-pip.py -o "$get_pip"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$get_pip" https://bootstrap.pypa.io/get-pip.py
  else
    "$PYTHON_BIN" - "$get_pip" <<'PY_GET_PIP'
import sys
import urllib.request
urllib.request.urlretrieve("https://bootstrap.pypa.io/get-pip.py", sys.argv[1])
PY_GET_PIP
  fi

  "$PYTHON_BIN" "$get_pip" --disable-pip-version-check
  "$PYTHON_BIN" -m pip --version >/dev/null
}

ensure_pip

echo "[build] Python: $($PYTHON_BIN --version)"
echo "[build] pip: $($PYTHON_BIN -m pip --version)"

PIP_SOURCE_ARGS=()
if [ -d "$WHEELS_DIR" ]; then
  PIP_SOURCE_ARGS+=(--find-links "$WHEELS_DIR")
fi
if [ "$OFFLINE" = "1" ]; then
  PIP_SOURCE_ARGS+=(--no-index)
fi

pip_install() {
  "$PYTHON_BIN" -m pip install "${PIP_SOURCE_ARGS[@]}" "$@"
}

pip_install --upgrade pip setuptools wheel
pip_install --upgrade \
  "pyinstaller>=6,<7" \
  "numpy>=1.24,<2" \
  pillow \
  "mediapipe==$MEDIAPIPE_VERSION" \
  opencv-python-headless \
  "$OPENVINO_SPEC"

# One package owns the onnxruntime Python namespace. OpenVINO is used through
# its own Python API and therefore does not require onnxruntime-openvino.
"$PYTHON_BIN" -m pip uninstall -y \
  onnxruntime onnxruntime-gpu onnxruntime-openvino >/dev/null 2>&1 || true

case "$ORT_PROFILE" in
  universal)
    pip_install --upgrade "$ORT_GPU_SPEC"
    ;;
  cpu)
    # Development/CI override. The distributed bundle is normally universal.
    pip_install --upgrade "$ORT_CPU_SPEC"
    ;;
  *)
    echo "ERROR: XRA_ORT_PROFILE must be universal (default) or cpu." >&2
    exit 3
    ;;
esac

# Vendor ORT and pip-provided NVIDIA libraries so PyInstaller and the final
# xra_server do not depend on the developer venv being present.
rm -rf -- "$RUNTIME_DIR"
mkdir -p -- "$RUNTIME_DIR"
"$PYTHON_BIN" - "$RUNTIME_DIR" <<'PY_VENDOR'
import importlib.util
import shutil
import site
import sys
from pathlib import Path

out = Path(sys.argv[1]).resolve()
spec = importlib.util.find_spec("onnxruntime")
if spec is None or not spec.submodule_search_locations:
    raise SystemExit("onnxruntime missing after installation")
src = Path(next(iter(spec.submodule_search_locations))).resolve()
shutil.copytree(src, out / "onnxruntime", dirs_exist_ok=True)
for root_s in site.getsitepackages():
    root = Path(root_s)
    for meta in root.glob("onnxruntime*.dist-info"):
        shutil.copytree(meta, out / meta.name, dirs_exist_ok=True)
    nvidia = root / "nvidia"
    if nvidia.is_dir():
        shutil.copytree(nvidia, out / "nvidia", dirs_exist_ok=True)
print("Vendored ORT:", src)
print("Vendored NVIDIA libs:", (out / "nvidia").is_dir())
PY_VENDOR
find "$RUNTIME_DIR" -name '*.so*' -type f -exec chmod +x {} \; 2>/dev/null || true

"$PYTHON_BIN" - <<'PY_VERIFY'
import sys
import cv2
import mediapipe as mp
import onnxruntime as ort
import openvino as ov

assert sys.version_info[:2] == (3, 11), sys.version
assert hasattr(getattr(mp, "solutions", None), "holistic")
from mediapipe.tasks.python import vision
assert hasattr(vision, "HolisticLandmarkerOptions")
print("MediaPipe:", mp.__version__)
print("OpenCV:", cv2.__version__)
print("ONNX Runtime:", ort.__version__, ort.get_available_providers())
print("OpenVINO:", ov.__version__, ov.Core().available_devices)
PY_VERIFY

echo "[build] Preparing models and smoke-testing automatic runtime selection..."
"$PYTHON_BIN" - "$ROOT_DIR" <<'PY_SMOKE'
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root))
from xra_backends import downloader, engine, registry, runtime

for model_id in registry.REGISTRY:
    if model_id in registry.BUNDLED_BACKENDS or registry.is_installed(model_id):
        continue
    print("Downloading:", model_id)
    result = downloader.ensure_model(model_id)
    if not result.get("ok"):
        raise SystemExit(f"download failed {model_id}: {result.get('error')}")

result = engine.ENGINE.load("dwpose-s")
print("provider smoke:", result)
if not result.get("ok"):
    raise SystemExit(result.get("error") or "provider smoke failed")
print("runtime capabilities:", runtime.describe())
engine.ENGINE.unload()
PY_SMOKE

# The final product is the NW.js bundle. build_bundled_browser.py creates the
# PyInstaller xra_server, copies the NW.js runtime/package and builds the ELF
# launchers. Always launch this script with the same venv interpreter.
echo "[build] Building NW.js bundled application..."
"$PYTHON_BIN" "$ROOT_DIR/tools/build_bundled_browser.py"

if [ ! -x "$BUNDLE_DIR/XR_Animator" ]; then
  echo "ERROR: bundled launcher was not produced: $BUNDLE_DIR/XR_Animator" >&2
  exit 6
fi
if [ ! -x "$BUNDLE_DIR/xra_server" ]; then
  echo "ERROR: bundled Python server was not produced: $BUNDLE_DIR/xra_server" >&2
  exit 6
fi
if [ ! -x "$BUNDLE_DIR/xra_browser" ]; then
  echo "ERROR: bundled NW.js browser was not produced: $BUNDLE_DIR/xra_browser" >&2
  exit 6
fi
if [ ! -d "$BUNDLE_DIR/package.nw" ]; then
  echo "ERROR: NW.js package payload was not produced: $BUNDLE_DIR/package.nw" >&2
  exit 6
fi

echo "=================================================="
echo "Build complete"
echo "Bundle: $BUNDLE_DIR"
echo "Launch: $BUNDLE_DIR/XR_Animator"
echo "or:     $ROOT_DIR/XR_Animator"
echo "=================================================="
