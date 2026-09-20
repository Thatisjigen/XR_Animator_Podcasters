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
# `git add`ed is invisible to the build. That is exactly how a mocap
# backend once shipped without its worker/UI bridge: the feature page loaded
# but only MediaPipe was selectable. Fail the build loudly instead.
REQUIRED_FILES = {
    "js/xra_backend_bridge.js",
    "images/XR Animator/xra_custom/11_backend.js",
    "xra_backends/__init__.py",
    "xra_backends/capture.py",
    "xra_backends/downloader.py",
    "xra_backends/engine.py",
    "xra_backends/native_mediapipe.py",
    "xra_backends/provision.py",
    "xra_backends/registry.py",
    "xra_backends/server.py",
    "xra_backends/models/mediapipe-tasks-landmarker/holistic_landmarker.task",
    "xra_backends/models/mediapipe-tasks-landmarker/face_landmarker.task",
    "xra_backends/models/mediapipe-tasks-landmarker/pose_landmarker_lite.task",
    "xra_backends/models/mediapipe-tasks-landmarker/hand_landmarker.task",
}

# The pre-downloaded Tasks models are gitignored but must ship in the bundle.
BUNDLED_DIRS = (
    "xra_backends/models",
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

    # Gitignored models are invisible to `git ls-files`,
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
# xr_server.py imports xra_backends inside a try/except, so declare the native
# dependencies explicitly. Python and these packages are embedded by PyInstaller.
# ---------------------------------------------------------------------------
hiddenimports = [
    "numpy",
    "PIL",
    "PIL.Image",
    "cv2",
    "mediapipe",
    "mediapipe.tasks.c.libmediapipe",
    "mediapipe.tasks.python.vision",
    "mediapipe.tasks.python.vision.face_landmarker",
    "mediapipe.tasks.python.vision.hand_landmarker",
    "mediapipe.tasks.python.vision.holistic_landmarker",
    "mediapipe.tasks.python.vision.pose_landmarker",
    "xra_backends",
    "xra_backends.registry",
    "xra_backends.downloader",
    "xra_backends.engine",
    "xra_backends.native_mediapipe",
    "xra_backends.server",
    "xra_backends.provision",
]

binaries = []
_collected_datas = []
try:
    from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

    # Tasks only needs its compiled C library and package metadata. collect_all
    # would also pull benchmarks/tests plus SciPy and Matplotlib into the app.
    _collected_datas += collect_data_files("mediapipe", include_py_files=False)
    binaries += collect_dynamic_libs("mediapipe")
    hiddenimports += collect_submodules("xra_backends")
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
    excludes=[
        "webview", "gi", "tkinter", "_tkinter",
        "onnxruntime", "openvino", "jax", "jaxlib",
    ],
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
