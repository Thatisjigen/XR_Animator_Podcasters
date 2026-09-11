"""Model download + cache management for ONNX mocap backends.

Downloads are streamed to a temp file then atomically renamed, so an
interrupted download never leaves a half-written model that would later fail
to load. Progress is reported through a callback so the server can push it to
the UI (Performance tab status line).
"""

from __future__ import annotations

import hashlib
import shutil
import tempfile
import urllib.request
from pathlib import Path
from typing import Callable, Optional

from . import registry

ProgressCb = Optional[Callable[[dict], None]]


def _emit(cb: ProgressCb, **payload) -> None:
    if cb:
        try:
            cb(payload)
        except Exception:
            pass


def _download_file(url: str, dest: Path, expected_sha256: Optional[str],
                   filename: str, model_id: str, cb: ProgressCb) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "XRA-Backend/1.0"})
    hasher = hashlib.sha256()
    with urllib.request.urlopen(request, timeout=60) as response:
        total = int(response.headers.get("Content-Length") or 0)
        fd, tmp_name = tempfile.mkstemp(dir=str(dest.parent), suffix=".part")
        tmp = Path(tmp_name)
        done = 0
        try:
            with open(fd, "wb") as out:
                while True:
                    chunk = response.read(1024 * 256)
                    if not chunk:
                        break
                    out.write(chunk)
                    hasher.update(chunk)
                    done += len(chunk)
                    pct = int(done / total * 100) if total else 0
                    _emit(cb, phase="downloading", model=model_id, file=filename,
                          done_bytes=done, total_bytes=total, percent=pct)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise

    if expected_sha256 and hasher.hexdigest().lower() != expected_sha256.lower():
        tmp.unlink(missing_ok=True)
        raise ValueError(f"Checksum mismatch for {filename}")

    shutil.move(str(tmp), str(dest))


def ensure_model(model_id: str, cb: ProgressCb = None, force: bool = False) -> dict:
    """Download every file of a model if missing. Returns a status dict."""
    spec = registry.REGISTRY.get(model_id)
    if not spec:
        return {"ok": False, "error": f"Unknown backend: {model_id}"}

    if registry.is_installed(model_id) and not force:
        return {"ok": True, "action": "already-installed",
                "path": str(registry.model_dir(model_id))}

    total_files = len(spec["files"])
    try:
        for index, entry in enumerate(spec["files"], start=1):
            dest = registry.model_path(model_id, entry["filename"])
            if dest.exists() and not force:
                continue
            _emit(cb, phase="file-start", model=model_id,
                  file=entry["filename"], index=index, total=total_files)
            _download_file(entry["url"], dest, entry.get("sha256"),
                           entry["filename"], model_id, cb)
        _emit(cb, phase="done", model=model_id, percent=100)
        return {"ok": True, "action": "downloaded",
                "path": str(registry.model_dir(model_id)),
                "size_mb": registry.installed_size_mb(model_id)}
    except Exception as exc:
        _emit(cb, phase="error", model=model_id, error=str(exc))
        return {"ok": False, "error": str(exc), "model": model_id}


def remove_model(model_id: str) -> dict:
    folder = registry.model_dir(model_id)
    if not folder.exists():
        return {"ok": True, "action": "not-present"}
    shutil.rmtree(folder, ignore_errors=True)
    return {"ok": True, "action": "removed", "model": model_id}
