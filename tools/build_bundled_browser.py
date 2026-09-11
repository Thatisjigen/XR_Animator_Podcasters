#!/usr/bin/env python3
"""Build a Linux package with its own NW.js/Chromium browser."""

from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
BASE_RELEASE = ROOT / "release" / "XR_Animator"
TARGET = ROOT / "release" / "XR_Animator_Bundled"
NW_RUNTIME = ROOT / "cache" / "nwjs-v0.115.0-linux-x64"
NW_PACKAGE = ROOT / "packaging" / "nw"

# These paths are created or edited by the packaged application.  A rebuild
# replaces the bundle, but must not silently replace the user's local state.
PERSISTENT_PATHS = (
    "xra_profile.json",
    "xra_profile.backup.json",
    "avatars",
    "backgrounds",
    "recordings",
    ".xra_recording_sessions",
)


def snapshot_user_data(staging: Path) -> None:
    if not TARGET.is_dir():
        return
    for name in PERSISTENT_PATHS:
        source = TARGET / name
        destination = staging / name
        if source.is_dir():
            shutil.copytree(source, destination, symlinks=True)
        elif source.is_file():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)


def restore_user_data(staging: Path) -> None:
    for name in PERSISTENT_PATHS:
        source = staging / name
        destination = TARGET / name
        if source.is_dir():
            shutil.copytree(source, destination, dirs_exist_ok=True, symlinks=True)
        elif source.is_file():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)


def copy_runtime() -> None:
    for name in (
        "chrome_crashpad_handler", "credits.html", "icudtl.dat",
        "nw_100_percent.pak", "nw_200_percent.pak", "resources.pak",
        "v8_context_snapshot.bin",
    ):
        shutil.copy2(NW_RUNTIME / name, TARGET / name)
    for name in ("lib", "swiftshader"):
        shutil.copytree(NW_RUNTIME / name, TARGET / name, dirs_exist_ok=True)

    locales = TARGET / "locales"
    locales.mkdir(exist_ok=True)
    for name in ("it.pak", "en-US.pak"):
        shutil.copy2(NW_RUNTIME / "locales" / name, locales / name)


def main() -> int:
    if not NW_RUNTIME.is_dir():
        raise SystemExit(
            "Runtime NW.js non trovato in cache/nwjs-v0.115.0-linux-x64. "
            "Scarica la build Linux x64 prima di creare il bundle."
        )

    completed = subprocess.run([sys.executable, str(ROOT / "tools" / "build_release.py")], cwd=ROOT)
    if completed.returncode:
        return completed.returncode

    (ROOT / "release").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="xra-user-data-", dir=ROOT / "release") as temporary:
        staging = Path(temporary)
        snapshot_user_data(staging)
        if TARGET.exists():
            shutil.rmtree(TARGET)
        shutil.copytree(BASE_RELEASE, TARGET)
        restore_user_data(staging)

    bundled_server = TARGET / "XR_Animator"
    bundled_server.rename(TARGET / "xra_server")
    (TARGET / "package.json").unlink(missing_ok=True)
    copy_runtime()
    shutil.copytree(NW_PACKAGE, TARGET / "package.nw")
    shutil.copy2(NW_RUNTIME / "nw", TARGET / "xra_browser")
    bundled_launcher_src = ROOT / "tools" / "launcher.c"
    root_launcher_src = ROOT / "tools" / "root_launcher.c"
    subprocess.run(["gcc", "-O2", "-s", str(bundled_launcher_src), "-o", str(TARGET / "XR_Animator")], check=True)
    subprocess.run(["gcc", "-O2", "-s", str(root_launcher_src), "-o", str(ROOT / "XR_Animator")], check=True)

    for executable in (
        TARGET / "XR_Animator", ROOT / "XR_Animator", TARGET / "xra_browser",
        TARGET / "xra_server", TARGET / "chrome_crashpad_handler",
    ):
        executable.chmod(executable.stat().st_mode | 0o111)

    # Clean up intermediate unbundled release so only the bundled build remains
    if BASE_RELEASE.exists():
        shutil.rmtree(BASE_RELEASE)

    print(f"[XRA] Bundled browser ready: {TARGET / 'XR_Animator'}")
    print(f"[XRA] Root launcher ready (ELF double-click): {ROOT / 'XR_Animator'}")
    print("[XRA] Chromium launched as shell; XR Animator runs on local HTTP.")
    print("[XRA] Intermediate unbundled folder removed: kept bundled build only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
