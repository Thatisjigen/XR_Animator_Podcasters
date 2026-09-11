# XRA_UNIVERSAL_RUNTIME_V9
# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onedir bundle that preserves XR Animator's HTTP runtime."""

from pathlib import Path
import subprocess


ROOT = Path(SPECPATH).resolve()
EXTRA_FILES = {
    "p2p_chat.html",
    "css/p2p_chat.css",
    "js/p2p_chat.js",
    "images/XR Animator/xra_custom/15_debug.js",
    "xr_launcher.py",
}

# Runtime files that MUST ship or the app is silently broken. runtime_files()
# sources its list from `git ls-files`, so a file that was created but never
# `git add`ed is invisible to the build. That is exactly how the ONNX mocap
# backend once shipped without its worker/UI bridge: the feature page loaded
# but only MediaPipe was selectable. Fail the build loudly instead.
REQUIRED_FILES = {
    "js/xra_onnx_bridge.js",
    "images/XR Animator/xra_custom/11_backend.js",
    "xra_backends/__init__.py",
    "xra_backends/downloader.py",
    "xra_backends/engine.py",
    "xra_backends/native_mediapipe.py",
    "xra_backends/provision.py",
    "xra_backends/registry.py",
    "xra_backends/runtime.py",
    "xra_backends/server.py",
    # ONNX payload lives under gitignored dirs, so it is NOT visible to
    # `git ls-files`. These are bundled explicitly below and asserted here so a
    # build can never ship without the runtime + model again. build.sh
    # downloads every registry model before the build, so all must be present.
    "xra_backends/models/dwpose-s/dw-ss_ucoco.onnx",
    "xra_backends/models/dwpose-m/dw-mm_ucoco.onnx",
    "xra_backends/models/dwpose-l/dw-ll_ucoco_384.onnx",
    "xra_backends/models/mediapipe-tasks-landmarker/holistic_landmarker.task",
}

# Directories that are deliberately gitignored but must still ship inside the
# bundle: the ONNX Runtime install and the pre-downloaded pose models. Without
# these the backend cannot run and the UI falls back to MediaPipe only.
BUNDLED_DIRS = (
    "xra_backends/models",
    "xra_backends/runtime",
)


def runtime_files():
    result = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True
    )
    names = {name for name in result.stdout.decode("utf-8").split("\0") if name}
    names.update(EXTRA_FILES)
    excluded_prefixes = (".github/",)
    excluded_names = {
        ".gitattributes", ".gitignore", "xr_animator_launcher.spec",
        "package.json", "readme.md", "readme.txt", "changelog.txt",
        "XR_Animator", "webview_app",
    }
    for name in sorted(names):
        if name in excluded_names or name.startswith(excluded_prefixes):
            continue
        source = ROOT / name
        if source.is_file():
            yield source, str(Path(name).parent)

    # Gitignored payload (ONNX runtime + models) is invisible to `git ls-files`,
    # so walk those trees explicitly and bundle every file, preserving the
    # relative layout. `.part` leftovers, compiled caches and stale JSON state
    # are skipped (the last two are regenerated at runtime).
    for rel_dir in BUNDLED_DIRS:
        base = ROOT / rel_dir
        if not base.is_dir():
            continue
        for source in sorted(base.rglob("*")):
            if not source.is_file() or source.suffix == ".part":
                continue
            if "__pycache__" in source.parts:
                continue
            if source.name in ("provision_state.json", "runtime_state.json"):
                continue
            yield source, str(source.parent.relative_to(ROOT))


def _assert_required_present():
    """Guard against shipping a build missing git-untracked runtime files."""
    present = set()
    for source, _dest in runtime_files():
        try:
            present.add(source.relative_to(ROOT).as_posix())
        except ValueError:
            present.add(source.as_posix())
    missing = sorted(REQUIRED_FILES - present)
    if missing:
        raise SystemExit(
            "[XRA BUILD] Required runtime files are missing from the bundle:\n  "
            + "\n  ".join(missing)
            + "\nHint: `git add` them (runtime_files() only sees tracked files)."
        )


_assert_required_present()

datas = [(str(source), destination) for source, destination in runtime_files()]


# ---------------------------------------------------------------------------
# Third-party runtime dependencies.
#
# xr_server.py imports xra_backends inside a try/except, so PyInstaller's
# static analysis cannot see the backend's own imports (numpy, Pillow, the
# vendored onnxruntime). We therefore declare them explicitly AND collect their
# data/binaries so *every* dependency ends up inside the bundle -- the target
# machine must never need Python, numpy, Pillow or onnxruntime preinstalled.
# ---------------------------------------------------------------------------
hiddenimports = [
    "numpy",
    "PIL",
    "PIL.Image",
    "cv2",
    "onnxruntime",
    "openvino",
    "mediapipe",
    "xra_backends",
    "xra_backends.registry",
    "xra_backends.runtime",
    "xra_backends.downloader",
    "xra_backends.engine",
    "xra_backends.native_mediapipe",
    "xra_backends.server",
    "xra_backends.provision",
]

binaries = []
_collected_datas = []
try:
    from PyInstaller.utils.hooks import collect_all, collect_submodules

    # onnxruntime is vendored under xra_backends/runtime and is already bundled
    # by BUNDLED_DIRS above; only numpy/Pillow/mediapipe need full collection.
    for package in ("numpy", "PIL", "mediapipe", "cv2", "openvino"):
        try:
            pkg_datas, pkg_binaries, pkg_hidden = collect_all(package)
            _collected_datas += pkg_datas
            binaries += pkg_binaries
            hiddenimports += pkg_hidden
        except Exception:
            # collect_all is best-effort; hiddenimports still force inclusion.
            pass
    hiddenimports += collect_submodules("xra_backends")
    hiddenimports += collect_submodules("mediapipe")
except Exception:
    pass

datas += _collected_datas

a = Analysis(
    [str(ROOT / "xr_launcher.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # The local folder picker already prefers zenity/kdialog/yad. Bundling the
    # optional GTK and Tk fallbacks would add ~90k files and roughly double the
    # release size; if no native helper exists users can still paste a path.
    excludes=["webview", "gi", "tkinter", "_tkinter"],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="XR_Animator",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    contents_directory=".",
    icon=str(ROOT / "icon_teto.ico"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    name="XR_Animator",
)
