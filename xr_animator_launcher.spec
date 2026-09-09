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


datas = [(str(source), destination) for source, destination in runtime_files()]

a = Analysis(
    [str(ROOT / "xr_launcher.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=[],
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
