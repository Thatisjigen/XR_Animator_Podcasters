#!/usr/bin/env python3
"""Build the Linux onedir release without packaging generated junk."""

from __future__ import annotations

from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "xr_animator_launcher.spec"


def pyinstaller_command() -> list[str]:
    candidates = [
        ROOT / ".venv" / "bin" / "pyinstaller",
        ROOT / ".venv" / "Scripts" / "pyinstaller.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return [str(candidate)]
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        raise SystemExit(
            "PyInstaller non trovato. Crea l'ambiente con `python3 -m venv .venv` "
            "e installa `pyinstaller` al suo interno."
        )
    return [sys.executable, "-m", "PyInstaller"]


def main() -> int:
    command = pyinstaller_command() + [
        "--noconfirm",
        "--clean",
        "--distpath", str(ROOT / "release"),
        "--workpath", str(ROOT / ".build"),
        str(SPEC),
    ]
    print("[XRA] Creo release/XR_Animator…")
    completed = subprocess.run(command, cwd=ROOT)
    if completed.returncode:
        return completed.returncode
    executable = ROOT / "release" / "XR_Animator" / "XR_Animator"
    print(f"[XRA] Pacchetto pronto: {executable}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
