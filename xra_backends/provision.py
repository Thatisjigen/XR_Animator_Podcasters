"""First-boot provisioning for the ONNX mocap backends.

The friend should never have to click "download". In the shipped build the
ONNX Runtime **and** the default pose model are bundled inside the app, so on
startup provisioning is a no-op (see :func:`autostart`): it just records a
"done" state and never touches the network.

The download path below remains only as a fallback for developer machines that
run from source without the bundled payload. It installs bundled wheels if
needed and downloads the default model if it is missing. All steps are
idempotent and never raise: a failure just leaves the backend in
"unavailable" state, which the UI reports. The whole thing is opt-out via the
``XRA_BACKEND_AUTOPROVISION=0`` environment variable (useful for tests/CI).
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from . import downloader, registry, runtime

_PKG_DIR = Path(__file__).resolve().parent
STATE_FILE = _PKG_DIR / "provision_state.json"

# Model downloaded on first boot. RTMPose-s is small (~20 MB) and CPU-friendly,
# so it is a safe default for the potato; heavier models remain opt-in.
DEFAULT_MODEL = os.environ.get("XRA_BACKEND_MODEL", "rtmpose-s")

_lock = threading.Lock()
_state: dict = {"phase": "idle", "progress": 0, "message": "", "done": False,
                "ok": None, "model": DEFAULT_MODEL, "started": None, "finished": None}


def status() -> dict:
    with _lock:
        return dict(_state)


def _set(**kw) -> None:
    with _lock:
        _state.update(kw)


def _persist() -> None:
    try:
        STATE_FILE.write_text(json.dumps(status(), indent=2), encoding="utf-8")
    except Exception:
        pass


def _load_saved() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def is_complete() -> bool:
    """True if runtime + default model are already provisioned on disk."""
    if not runtime.is_available():
        return False
    return registry.is_installed(DEFAULT_MODEL)


def provision(force: bool = False) -> dict:
    """Run the full first-boot sequence synchronously. Returns a status dict."""
    _set(phase="starting", progress=0, message="Avvio provisioning…",
         done=False, ok=None, started=time.time(), finished=None)
    _persist()

    # Step 1: runtime.
    _set(phase="runtime", progress=5, message="Preparo il runtime ONNX…")
    if not runtime.is_available():
        result = runtime.bootstrap_install(force=force)
        if not result.get("ok"):
            _set(phase="error", progress=0, done=True, ok=False,
                 message="Runtime ONNX non disponibile: " + str(result.get("error") or result.get("action")))
            _persist()
            return status()
    _set(phase="runtime", progress=30, message=f"Runtime pronto ({runtime.installed_version()}).")

    # Step 2: model download.
    if registry.is_installed(DEFAULT_MODEL) and not force:
        _set(phase="done", progress=100, done=True, ok=True,
             message=f"Gia' installato: {DEFAULT_MODEL}", finished=time.time())
        _persist()
        return status()

    _set(phase="download", progress=35, message=f"Scarico il modello {DEFAULT_MODEL}…")

    def cb(p):
        if p.get("phase") == "downloading":
            pct = 35 + int((p.get("percent") or 0) * 0.6)
            _set(progress=pct, message=f"Scarico {p.get('file')} — {p.get('percent')}%")
            _persist()

    result = downloader.ensure_model(DEFAULT_MODEL, cb=cb, force=force)
    if not result.get("ok"):
        _set(phase="error", progress=0, done=True, ok=False,
             message="Download fallito: " + str(result.get("error")), finished=time.time())
        _persist()
        return status()

    _set(phase="done", progress=100, done=True, ok=True,
         message=f"Pronto: {DEFAULT_MODEL} ({registry.installed_size_mb(DEFAULT_MODEL)} MB)",
         finished=time.time())
    _persist()
    return status()


def provision_async(force: bool = False) -> threading.Thread:
    """Run :func:`provision` in a daemon thread; returns the thread."""
    def _run():
        try:
            provision(force=force)
        except Exception as exc:  # never crash the server thread
            _set(phase="error", progress=0, done=True, ok=False,
                 message=f"Provisioning error: {exc}", finished=time.time())
            _persist()

    thread = threading.Thread(target=_run, name="xra-backend-provision", daemon=True)
    thread.start()
    return thread


def autostart() -> dict:
    """Called from server startup. Respects opt-out and persists prior state.

    When the runtime + default model are already bundled on disk (the shipped
    build), this is a pure no-op: it records a "done" state and never opens a
    network connection or spawns a download thread.
    """
    if os.environ.get("XRA_BACKEND_AUTOPROVISION", "1") in ("0", "false", "False"):
        _set(phase="disabled", done=True, ok=True, message="Autoprovisioning disabilitato")
        return status()

    # Bundled payload: everything is already present, so skip provisioning
    # entirely. This is the normal path for the packaged app.
    if is_complete():
        _set(phase="done", progress=100, done=True, ok=True,
             model=DEFAULT_MODEL,
             message=f"Gia' installato: {DEFAULT_MODEL} (in bundle)")
        _persist()
        return status()

    saved = _load_saved()
    if saved.get("ok") and saved.get("phase") not in (None, "error"):
        with _lock:
            _state.update(saved)
            _state["message"] = saved.get("message", "Gia' pronto")
        return status()

    provision_async()
    return status()
