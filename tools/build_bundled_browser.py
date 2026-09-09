#!/usr/bin/env python3
"""Build a Linux package with its own NW.js/Chromium browser."""

from __future__ import annotations

from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[1]
BASE_RELEASE = ROOT / "release" / "XR_Animator"
TARGET = ROOT / "release" / "XR_Animator_Bundled"
NW_RUNTIME = ROOT / "cache" / "nwjs-v0.115.0-linux-x64"
NW_PACKAGE = ROOT / "packaging" / "nw"


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

    completed = subprocess.run(["python3", str(ROOT / "tools" / "build_release.py")], cwd=ROOT)
    if completed.returncode:
        return completed.returncode

    if TARGET.exists():
        shutil.rmtree(TARGET)
    shutil.copytree(BASE_RELEASE, TARGET)

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

    print(f"[XRA] Browser bundled pronto: {TARGET / 'XR_Animator'}")
    print(f"[XRA] Root launcher pronto (ELF double-click): {ROOT / 'XR_Animator'}")
    print("[XRA] Chromium viene avviato solo come shell; XR Animator resta su HTTP locale.")
    print("[XRA] Cartella intermedia unbundled rimossa: conservata solo la build bundled.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
