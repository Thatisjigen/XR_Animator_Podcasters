#!/usr/bin/env bash
set -e

# Repository root directory
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "=================================================="
echo "      XR Animator - Bundled Build Launcher"
echo "=================================================="

# Detect Python interpreter (.venv preferred)
if [ -f "$ROOT_DIR/.venv/bin/python3" ]; then
    PYTHON_BIN="$ROOT_DIR/.venv/bin/python3"
    echo "[build] Using virtual environment: .venv"
elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
    echo "[build] Using system Python: $(command -v python3)"
else
    echo "ERROR: Python 3 not found. Install python3 to build." >&2
    exit 1
fi

echo "[build] Running bundled build..."
"$PYTHON_BIN" "$ROOT_DIR/tools/build_bundled_browser.py"

echo ""
echo "=================================================="
echo "  Build completed successfully!"
echo "=================================================="
echo "Build location: $ROOT_DIR/release/XR_Animator_Bundled"
echo "To start the bundled app run:"
echo "    ./release/XR_Animator_Bundled/XR_Animator"
echo "    or simply ./XR_Animator from repository root."
echo "=================================================="
