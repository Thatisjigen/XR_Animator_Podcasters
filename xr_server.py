#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote, urlparse
import json
import threading
import shutil
import re
import time
import uuid
import subprocess
import sys
import os

ROOT = Path(__file__).resolve().parent
PROFILE_FILE = ROOT / "xra_profile.json"
BACKUP_FILE = ROOT / "xra_profile.backup.json"
LOCK = threading.Lock()
RECORDING_LOCK = threading.Lock()
RECORDING_SESSIONS = {}
BACKGROUND_CACHE = {"ts": 0.0, "files": []}
RECORDINGS_DIR = ROOT / "recordings"
RECORDING_MANIFEST_DIR = ROOT / ".xra_recording_sessions"
XRA_RECORDER_API_VERSION = 766
RECORDING_MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
AVATAR_DIR = ROOT / "avatars"
AVATAR_DIR.mkdir(parents=True, exist_ok=True)
AVATAR_EXTS = {".vrm", ".glb", ".gltf"}
AVATAR_MAX_BYTES = 256 * 1024 * 1024

DEFAULT_CUSTOM = {
    "camera": {"optimized": True, "width": 640, "height": 480, "fps": 30},
    "pose_model": "Normal",
    "lip": {
        "optimized": True, "fft_size": 512, "analysis_fps": 30, "mic_mix": 0.60,
        "threshold": 0.018, "meter_visible": False, "response_gain": 1.0, "vowel_emphasis": 1.0,
    },
    "performance": {
        "preset": "CUSTOM", "master_preset": "CUSTOM", "tracking_pipeline": "SPLIT",
        "disable_postfx": False, "pose_fps": 30, "hand_fps": 20, "auto_last_result": None,
        "runtime_adaptive": False, "diagnostics_hud": False,
    },
    "body": {"anchor_strength": 0.80, "transition_ms": 450, "stable": False},
    "tracking": {
        "hands_enabled": True, "hand_recovery_mode": "normal", "hand_detection_sensitivity": "high", "native_smoothing": 0, "body_bend_reduction": 0,
        "upper_body_guard": False, "upper_body_guard_strength": 0.0,
        "guard_jump_deg": 42, "guard_hold_ms": 650, "guard_reacquire_deg": 60,
        "guard_mode": "off", "desk_torso_lock": 0.55, "desk_hips_lock": 0.92, "desk_legs_lock": 1.0,
        "adaptive_smoothing": True, "adaptive_smoothing_strength": 0.45, "guard_confidence_min": 0.35,
        "desk_max_yaw_deg": 25, "desk_max_pitch_deg": 15, "desk_max_roll_deg": 12,
        "guard_release_ms": 450, "freeze_head_on_face_loss": False, "freeze_recovery_ms": 350
    },
    "background": {"mode": "color", "color": "#202020", "path": "backgrounds/default.png"},
    "collider": {"preset": "CUSTOM", "mode": 0, "reaction": "z_push", "head": 100, "chest": 100, "waist": 100, "hip": 100},
    "visual_effects": {"UnrealBloom": None, "N8AO": None, "DOF": None},
    "left_settings": {},
    "avatar": {"filename": ""},
    "devices": {
        "mic_device_id": "", "camera_device_id": "", "camera_label": "",
        "mirror_preview": False, "selfie_mode": False,
    },
    "recorder": {
        "preset": "PODCAST", "mode": "video_audio", "width": 1280, "height": 720, "fps": 30,
        "video_bps": 3000000, "audio_bps": 128000, "audio_profile": "podcast",
        "noise_gate": True, "gate_threshold_db": -48, "gate_noise_floor_db": None, "gate_hold_ms": 160, "gate_release_ms": 120,
        "segment_minutes": 0, "output_format": "webm", "output_dir": "",
        "filename": "XR_Animator_{date}_{time}", "raw_audio_backup": True, "raw_audio_format": "flac", "hardware_encode": "auto", "chroma_safe": True, "force_render_resolution": True, "capture_source": "classic_v74",
    },
    "ui": {"visible": True, "show_startup": True, "active_tab": "quick", "language": "auto", "preview_video": None, "preview_wireframe": None, "preview_debug": None},
}

DEFAULT_PROFILE = {
    "version": 7.80,
    "custom": DEFAULT_CUSTOM,
    "XR_Animator_settings": None,
}


def deep_merge(base, extra):
    if not isinstance(base, dict) or not isinstance(extra, dict):
        return extra
    out = dict(base)
    for key, value in extra.items():
        if key in out and isinstance(out[key], dict) and isinstance(value, dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def read_profile_file(path):
    with path.open("r", encoding="utf-8") as handle:
        loaded = json.load(handle)
    if "custom" not in loaded:
        loaded = {"version": 5.1, "custom": loaded, "XR_Animator_settings": None}
    try:
        old_version = float(loaded.get("version") or 0)
    except Exception:
        old_version = 0.0
    profile = deep_merge(DEFAULT_PROFILE, loaded)
    # V7.6.3 migration: never silently raise video bitrate. Resolution and
    # bitrate are independent and the UI estimate must reflect the user's exact
    # choice. Keep RAW mic backup enabled when migrating older profiles.
    if old_version < 7.63:
        rec = profile.setdefault("custom", {}).setdefault("recorder", {})
        if rec.get("raw_audio_backup") is False and old_version < 7.62:
            rec["raw_audio_backup"] = True
        tracking = profile.setdefault("custom", {}).setdefault("tracking", {})
        tracking["guard_mode"] = "off"
        tracking["upper_body_guard"] = False
    # V7.6.6+: retire screen-sharing/native-only fallbacks. Classic output is the
    # recorder's supported default and includes the configured background.
    rec = profile.setdefault("custom", {}).setdefault("recorder", {})
    if str(rec.get("capture_source") or "") in {"browser_visible", "native_visible", "native_xr", ""}:
        rec["capture_source"] = "classic_v74"
    # Unify the old Body Stable / Torso Guard / Podcast-Desk states into one
    # body-stabilization switch. Guard remains an internal anti-glitch safety
    # layer while Anchor strength is the only user-facing stabilization amount.
    body = profile.setdefault("custom", {}).setdefault("body", {})
    tracking = profile.setdefault("custom", {}).setdefault("tracking", {})
    if old_version < 7.80:
        old_mode = str(tracking.get("guard_mode") or ("guard" if tracking.get("upper_body_guard") else "off")).lower()
        if not body.get("stable") and old_mode != "off":
            body["stable"] = True
            try:
                body["anchor_strength"] = max(0.0, min(1.0, float(tracking.get("upper_body_guard_strength", 0.80))))
            except Exception:
                body["anchor_strength"] = 0.80
    tracking["guard_mode"] = "guard" if body.get("stable") else "off"
    tracking["upper_body_guard"] = bool(body.get("stable"))
    tracking["upper_body_guard_strength"] = 0.0
    # The removed camera-lock experiment used this section exclusively.
    profile.setdefault("custom", {}).pop("view", None)

    # Drop retired UI/runtime keys that no longer have a reader.
    performance = profile.setdefault("custom", {}).setdefault("performance", {})
    performance.pop("startup_mocap", None)
    performance.pop("e2_master", None)
    profile.setdefault("custom", {}).setdefault("ui", {}).pop("show_legacy_toolbar", None)

    # Remove retired tracking-loss fields from imported profiles.
    tracking = profile.setdefault("custom", {}).setdefault("tracking", {})
    for key in (
        "head_loss_guard", "avatar_loss_hide_mode", "avatar_face_loss_hide_ms", "avatar_face_return_ms",
        "head_confidence_min", "head_hold_ms", "head_release_ms", "head_loss_transition_ms",
        "head_jump_deg", "head_reacquire_deg", "head_reacquire_stable_ms",
    ):
        tracking.pop(key, None)
    # Migrate old V7.x profiles in memory while preserving every saved setting.
    profile["version"] = DEFAULT_PROFILE["version"]
    return profile


def save_profile(profile, rotate_backup=True):
    tmp = PROFILE_FILE.with_suffix(".json.tmp")
    with LOCK:
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(profile, handle, indent=2, ensure_ascii=False)
            handle.write("\n")

        if rotate_backup and PROFILE_FILE.exists():
            try:
                read_profile_file(PROFILE_FILE)
                shutil.copy2(PROFILE_FILE, BACKUP_FILE)
            except Exception:
                pass

        tmp.replace(PROFILE_FILE)


def load_profile():
    if PROFILE_FILE.exists():
        try:
            return read_profile_file(PROFILE_FILE)
        except Exception as exc:
            print(f"[XRA] Main profile invalid: {exc}")

    if BACKUP_FILE.exists():
        try:
            recovered = read_profile_file(BACKUP_FILE)
            print("[XRA] Recovered profile from xra_profile.backup.json")
            save_profile(recovered, rotate_backup=False)
            return recovered
        except Exception as exc:
            print(f"[XRA] Backup profile invalid: {exc}")

    clean = deep_merge(DEFAULT_PROFILE, {})
    save_profile(clean, rotate_backup=False)
    print("[XRA] Created a clean default profile")
    return clean


def safe_avatar_name(filename):
    name = Path(unquote(str(filename or ""))).name
    ext = Path(name).suffix.lower()
    if ext not in AVATAR_EXTS:
        return None
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", Path(name).stem).strip().strip(".")
    stem = (stem or "avatar")[:160]
    return stem + ext


def _avatar_dir():
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    return AVATAR_DIR.resolve()


def avatar_file(filename):
    """Resolve a saved avatar only inside the app-local avatars library."""
    name = safe_avatar_name(filename)
    if not name:
        return None
    folder = _avatar_dir()
    try:
        candidate = (folder / name).resolve()
        if candidate.parent != folder:
            return None
        if candidate.is_file():
            return candidate
        wanted = name.casefold()
        for item in folder.iterdir():
            if item.is_file() and item.name.casefold() == wanted:
                resolved = item.resolve()
                if resolved.parent == folder:
                    return resolved
    except OSError:
        return None
    return None


def save_avatar_upload(filename, stream, length):
    name = safe_avatar_name(filename)
    if not name:
        raise ValueError("Invalid avatar filename")
    if length <= 0 or length > AVATAR_MAX_BYTES:
        raise ValueError("Invalid avatar size")
    folder = _avatar_dir()
    dest = (folder / name).resolve()
    if dest.parent != folder:
        raise ValueError("Invalid avatar path")
    tmp = dest.with_name(dest.name + f".{uuid.uuid4().hex}.tmp")
    remaining = length
    try:
        with tmp.open("wb") as handle:
            while remaining:
                data = stream.read(min(1024 * 1024, remaining))
                if not data:
                    raise IOError("Unexpected end of avatar upload")
                handle.write(data)
                remaining -= len(data)
        tmp.replace(dest)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
    return dest.name


def background_files(force=False):
    now = time.monotonic()
    if not force and BACKGROUND_CACHE["files"] and now - BACKGROUND_CACHE["ts"] < 10.0:
        return list(BACKGROUND_CACHE["files"])
    allowed = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"}
    (ROOT / "backgrounds").mkdir(parents=True, exist_ok=True)
    # Only documented background locations are supported. Scanning ROOT with
    # rglob used to walk hundreds of megabytes on the first panel request.
    dirs = [
        ROOT / "backgrounds",
        ROOT / "images" / "XR Animator" / "backgrounds",
        ROOT / "images" / "XR_Animator" / "backgrounds",
    ]

    found = {}
    root_resolved = ROOT.resolve()
    for directory in dirs:
        try:
            directory = directory.resolve()
            if directory != root_resolved and root_resolved not in directory.parents:
                continue
            if not directory.is_dir():
                continue
            for file in directory.rglob("*"):
                if file.is_file() and file.suffix.lower() in allowed:
                    rel = file.resolve().relative_to(root_resolved).as_posix()
                    found[rel.lower()] = rel
        except Exception:
            pass
    files = [found[key] for key in sorted(found)]
    BACKGROUND_CACHE["ts"] = now
    BACKGROUND_CACHE["files"] = list(files)
    return files


def safe_recording_name(name):
    name = str(name or "recording")
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", name).strip().strip(".")
    # The UI already chooses the container separately. Accept users typing
    # podcast.mp4 without producing podcast.mp4.mp4.
    name = re.sub(r'(?i)\.(?:mp4|webm|mkv|flac|wav|opus)$', '', name).rstrip('.')
    return (name or "recording")[:160]


def source_extension_for_mime(mime_type, fallback="webm"):
    mime_type = str(mime_type or "").lower()
    if "mp4" in mime_type:
        return ".mp4"
    if "webm" in mime_type:
        return ".webm"
    if "ogg" in mime_type or "opus" in mime_type:
        return ".opus"
    # Chromium can report an empty MediaRecorder mimeType when it chooses the
    # default internally. Never create opaque .bin podcast files.
    fallback = str(fallback or "webm").lower().lstrip(".")
    return "." + (fallback if fallback in {"webm", "mp4", "opus"} else "webm")


def final_extension(output_format, mode):
    fmt = str(output_format or "webm").lower()
    if fmt == "mp4": return ".mp4"
    if fmt == "mkv": return ".mkv"
    if fmt == "flac": return ".flac"
    if fmt == "wav": return ".wav"
    if fmt == "opus": return ".opus"
    return ".webm"


def resolve_output_dir(value):
    if not value:
        target = RECORDINGS_DIR
    else:
        target = Path(os.path.expandvars(os.path.expanduser(str(value))))
        if not target.is_absolute():
            target = (ROOT / target).resolve()
    target.mkdir(parents=True, exist_ok=True)
    target = target.resolve()
    probe = target / f".xra_write_test_{uuid.uuid4().hex}"
    try:
        probe.write_bytes(b"")
        probe.unlink(missing_ok=True)
    except Exception as exc:
        raise PermissionError(f"Folder is not writable: {target} ({exc})")
    return target


def unique_path(folder, base, ext):
    target = folder / (base + ext)
    index = 2
    while target.exists():
        target = folder / f"{base}_{index}{ext}"
        index += 1
    return target


def _usable_initial_dir(initial=""):
    try:
        candidate = Path(os.path.expandvars(os.path.expanduser(str(initial or ""))))
        if candidate.is_dir():
            return str(candidate.resolve())
    except Exception:
        pass
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    return str(RECORDINGS_DIR.resolve())



def _linux_gui_env():
    """Best-effort GUI environment for folder pickers launched by the local server.

    Some Linux launchers start the Python server with a reduced environment.
    Recover DISPLAY/Wayland/DBus values from parent processes when possible.
    """
    env = os.environ.copy()
    keys = {
        "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR", "XDG_CURRENT_DESKTOP", "DESKTOP_SESSION", "GDK_BACKEND",
    }
    missing = {key for key in keys if not env.get(key)}
    if missing and sys.platform.startswith("linux"):
        pid = os.getppid()
        for _ in range(5):
            try:
                raw = Path(f"/proc/{pid}/environ").read_bytes()
                parent = {}
                for item in raw.split(b"\0"):
                    if b"=" not in item:
                        continue
                    key, value = item.split(b"=", 1)
                    parent[key.decode(errors="ignore")] = value.decode(errors="ignore")
                for key in list(missing):
                    if parent.get(key):
                        env[key] = parent[key]
                        missing.discard(key)
                stat = Path(f"/proc/{pid}/stat").read_text(errors="ignore").split()
                pid = int(stat[3]) if len(stat) > 3 else 1
                if pid <= 1 or not missing:
                    break
            except Exception:
                break
    return env

def choose_folder_native(initial=""):
    """Open a native folder picker from the local XR server process.

    Linux is the primary target for XR Animator. Prefer the desktop-native
    helper when available (KDE -> kdialog, otherwise zenity/yad/qarma), then
    fall back to PyGObject GTK and finally tkinter. The selected path is
    validated for writability before it is returned.
    """
    initial = _usable_initial_dir(initial)
    errors = []

    if sys.platform.startswith("win"):
        escaped = initial.replace("'", "''")
        ps = rf'''
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Opacity = 0
$form.StartPosition = 'CenterScreen'
$form.Width = 1; $form.Height = 1
$form.Show()
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = 'Choose XR Animator recording folder'
$dlg.ShowNewFolderButton = $true
$dlg.SelectedPath = '{escaped}'
$result = $dlg.ShowDialog($form)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $dlg.SelectedPath }}
$form.Close()
'''
        try:
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", ps],
                capture_output=True, text=True, timeout=180,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            picked = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
            if picked:
                return str(resolve_output_dir(picked[-1]))
            if result.returncode:
                errors.append((result.stderr or "PowerShell picker failed").strip())
            else:
                return ""
        except Exception as exc:
            errors.append(str(exc))

    if sys.platform == "darwin":
        try:
            script = 'POSIX path of (choose folder with prompt "Choose XR Animator recording folder")'
            result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=180)
            if result.returncode == 0 and result.stdout.strip():
                return str(resolve_output_dir(result.stdout.strip()))
            if "User canceled" in (result.stderr or ""):
                return ""
            errors.append((result.stderr or "osascript picker failed").strip())
        except Exception as exc:
            errors.append(str(exc))

    # Linux desktop picker. Chromium cannot reveal a real absolute path from
    # showDirectoryPicker(), so the local server must own the native dialog.
    if not sys.platform.startswith("win") and sys.platform != "darwin":
        gui_env = _linux_gui_env()
        desktop = (gui_env.get("XDG_CURRENT_DESKTOP") or gui_env.get("DESKTOP_SESSION") or "").lower()
        initial_slash = initial.rstrip("/") + "/"
        helpers = []
        if "kde" in desktop or "plasma" in desktop:
            helpers.append(("kdialog", ["kdialog", "--getexistingdirectory", initial, "--title", "Choose XR Animator recording folder"]))
        helpers += [
            ("zenity", ["zenity", "--file-selection", "--directory", "--modal", "--title=Choose XR Animator recording folder", f"--filename={initial_slash}"]),
            ("yad", ["yad", "--file", "--directory", "--on-top", "--center", "--title=Choose XR Animator recording folder", f"--filename={initial_slash}"]),
            ("qarma", ["qarma", "--file-selection", "--directory", "--modal", "--title=Choose XR Animator recording folder", f"--filename={initial_slash}"]),
        ]
        if not ("kde" in desktop or "plasma" in desktop):
            helpers.append(("kdialog", ["kdialog", "--getexistingdirectory", initial, "--title", "Choose XR Animator recording folder"]))

        attempted = set()
        for name, command in helpers:
            if name in attempted or not shutil.which(name):
                continue
            attempted.add(name)
            try:
                result = subprocess.run(command, capture_output=True, text=True, timeout=180, env=gui_env)
                picked = (result.stdout or "").strip()
                if result.returncode == 0 and picked:
                    return str(resolve_output_dir(picked))
                # Standard dialog cancellation codes: zenity/yad/qarma 1,
                # kdialog 1. Cancellation is not an error.
                if result.returncode == 1:
                    return ""
                errors.append(f"{name}: " + ((result.stderr or result.stdout or "picker failed").strip()))
            except Exception as exc:
                errors.append(f"{name}: {exc}")

        # GTK fallback when python3-gi is installed but no CLI picker exists.
        try:
            import gi
            gi.require_version("Gtk", "3.0")
            from gi.repository import Gtk
            dialog = Gtk.FileChooserDialog(
                title="Choose XR Animator recording folder",
                action=Gtk.FileChooserAction.SELECT_FOLDER,
            )
            dialog.add_buttons(Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL, Gtk.STOCK_OPEN, Gtk.ResponseType.OK)
            try:
                dialog.set_current_folder(initial)
            except Exception:
                pass
            response = dialog.run()
            picked = dialog.get_filename() if response == Gtk.ResponseType.OK else ""
            dialog.destroy()
            while Gtk.events_pending():
                Gtk.main_iteration_do(False)
            return str(resolve_output_dir(picked)) if picked else ""
        except Exception as exc:
            errors.append(f"GTK: {exc}")

    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk(); root.withdraw()
        try:
            root.attributes('-topmost', True); root.update()
        except Exception:
            pass
        picked = filedialog.askdirectory(initialdir=initial, title='Choose XR Animator recording folder', mustexist=False)
        root.destroy()
        return str(resolve_output_dir(picked)) if picked else ""
    except Exception as exc:
        errors.append(f"tkinter: {exc}")

    display_hint = ""
    if sys.platform.startswith("linux"):
        env = _linux_gui_env()
        if not (env.get("DISPLAY") or env.get("WAYLAND_DISPLAY")):
            display_hint = " No DISPLAY/WAYLAND_DISPLAY was visible to xr_server.py; launch it from the same desktop session as XR Animator."
    hint = "On Linux install one of: zenity, kdialog or yad; or type/paste an absolute path in Recording folder." + display_hint
    raise RuntimeError("Native folder picker unavailable. " + hint + " Details: " + " | ".join(e for e in errors if e)[-1500:])



def find_ffmpeg():
    """Resolve FFmpeg robustly for Linux desktop launches with a restricted PATH."""
    candidates = []
    env_path = os.environ.get("XRA_FFMPEG", "").strip()
    if env_path:
        candidates.append(env_path)
    found = shutil.which("ffmpeg")
    if found:
        candidates.append(found)
    candidates.extend([
        "/usr/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/bin/ffmpeg",
        "/snap/bin/ffmpeg",
        str(Path.home() / ".local/bin/ffmpeg"),
    ])
    seen = set()
    for candidate in candidates:
        candidate = str(candidate or "").strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        path = Path(candidate).expanduser()
        try:
            if path.is_file() and os.access(path, os.X_OK):
                return str(path.resolve())
        except Exception:
            pass
    return None

def ffmpeg_encoders():
    ffmpeg = find_ffmpeg()
    result = {"ffmpeg": bool(ffmpeg), "ffmpeg_path": ffmpeg or "", "h264": [], "recommended": "libx264"}
    if not ffmpeg:
        return result
    try:
        proc = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=12)
        text = (proc.stdout or "") + "\n" + (proc.stderr or "")
        for enc in ["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox", "libx264"]:
            if re.search(rf"\b{re.escape(enc)}\b", text):
                result["h264"].append(enc)
        for enc in ["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox", "libx264"]:
            if enc in result["h264"]:
                result["recommended"] = enc; break
    except Exception:
        pass
    return result


def _manifest_path(session):
    return RECORDING_MANIFEST_DIR / f"{session}.json"


def write_recording_manifest(session, info, error=""):
    try:
        payload = {
            "session": session, "path": str(info.get("path", "")), "final_path": str(info.get("final_path", "")),
            "bytes": int(info.get("bytes") or 0), "started": float(info.get("started") or time.time()),
            "output_format": info.get("output_format", "webm"), "mode": info.get("mode", "video_audio"),
            "video_bps": int(info.get("video_bps") or 0), "audio_bps": int(info.get("audio_bps") or 0),
            "hardware_encode": info.get("hardware_encode", "auto"), "error": str(error or ""),
        }
        tmp = _manifest_path(session).with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(_manifest_path(session))
    except Exception as exc:
        print(f"[XRA] recording manifest write failed: {exc}")


def delete_recording_manifest(session):
    try:
        _manifest_path(session).unlink(missing_ok=True)
    except Exception:
        pass


def recovery_list():
    out = []
    for manifest in RECORDING_MANIFEST_DIR.glob("*.json"):
        try:
            obj = json.loads(manifest.read_text(encoding="utf-8"))
            source = Path(obj.get("path") or "")
            final = Path(obj.get("final_path") or "")
            if not source.exists() and final.exists():
                manifest.unlink(missing_ok=True); continue
            if not source.exists():
                continue
            obj["bytes"] = source.stat().st_size
            obj["seconds"] = max(0.0, time.time() - float(obj.get("started") or time.time()))
            out.append(obj)
        except Exception:
            continue
    out.sort(key=lambda x: x.get("started", 0), reverse=True)
    return out


def _run_ffmpeg_with_fallback(base_cmd, output_path, requested="auto"):
    enc = ffmpeg_encoders(); available = enc.get("h264", [])
    requested = str(requested or "auto").lower()
    if requested == "auto":
        candidates = [x for x in [enc.get("recommended"), "libx264"] if x]
    elif requested in available:
        candidates = [requested, "libx264"] if requested != "libx264" else ["libx264"]
    else:
        candidates = ["libx264"]
    seen = set(); last_err = ""
    for encoder in candidates:
        if encoder in seen: continue
        seen.add(encoder); cmd = list(base_cmd)
        if encoder == "libx264": cmd += ["-c:v", encoder, "-preset", "medium"]
        elif encoder == "h264_nvenc": cmd += ["-c:v", encoder, "-preset", "p5"]
        elif encoder == "h264_qsv": cmd += ["-c:v", encoder, "-preset", "medium"]
        elif encoder == "h264_amf": cmd += ["-c:v", encoder, "-quality", "quality"]
        else: cmd += ["-c:v", encoder]
        cmd += [str(output_path)]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0: return encoder
        last_err = (result.stderr or "FFmpeg conversion failed").strip()[-3000:]
        try: Path(output_path).unlink(missing_ok=True)
        except Exception: pass
        if requested != "auto": break
    raise RuntimeError(last_err or "FFmpeg H.264 conversion failed")


def convert_recording(info):
    source = Path(info["path"]); final = Path(info["final_path"]); fmt = str(info.get("output_format", "webm")).lower()
    if source == final: return final
    ffmpeg = find_ffmpeg()
    if not ffmpeg: raise RuntimeError("FFmpeg is required for this output format. Checked PATH and common Linux locations (/usr/bin, /usr/local/bin, /snap/bin).")
    mode = info.get("mode", "video_audio")
    video_bps = max(100000, int(info.get("video_bps") or 3000000)); audio_bps = max(32000, int(info.get("audio_bps") or 128000))
    common = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source)]
    if fmt == "mkv":
        result = subprocess.run(common + ["-map", "0", "-c", "copy", str(final)], capture_output=True, text=True)
        if result.returncode != 0: raise RuntimeError((result.stderr or "FFmpeg MKV remux failed").strip()[-3000:])
    elif fmt == "mp4":
        if mode == "audio":
            result = subprocess.run(common + ["-vn", "-c:a", "aac", "-b:a", str(audio_bps), "-movflags", "+faststart", str(final)], capture_output=True, text=True)
            if result.returncode != 0: raise RuntimeError((result.stderr or "FFmpeg MP4 audio conversion failed").strip()[-3000:])
        elif mode == "video":
            _run_ffmpeg_with_fallback(common + ["-an", "-b:v", str(video_bps), "-pix_fmt", "yuv420p", "-movflags", "+faststart"], final, info.get("hardware_encode", "auto"))
        else:
            _run_ffmpeg_with_fallback(common + ["-b:v", str(video_bps), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", str(audio_bps), "-movflags", "+faststart"], final, info.get("hardware_encode", "auto"))
    elif fmt == "flac":
        result = subprocess.run(common + ["-vn", "-c:a", "flac", str(final)], capture_output=True, text=True)
        if result.returncode != 0: raise RuntimeError((result.stderr or "FFmpeg FLAC conversion failed").strip()[-3000:])
    elif fmt == "wav":
        result = subprocess.run(common + ["-vn", "-c:a", "pcm_s16le", str(final)], capture_output=True, text=True)
        if result.returncode != 0: raise RuntimeError((result.stderr or "FFmpeg WAV conversion failed").strip()[-3000:])
    elif fmt == "opus":
        result = subprocess.run(common + ["-vn", "-c:a", "libopus", "-b:a", str(audio_bps), str(final)], capture_output=True, text=True)
        if result.returncode != 0: raise RuntimeError((result.stderr or "FFmpeg Opus conversion failed").strip()[-3000:])
    else: raise RuntimeError(f"Unsupported output format: {fmt}")
    if not final.exists() or final.stat().st_size <= 0: raise RuntimeError(f"Final recording was not created: {final}")
    try: source.unlink(missing_ok=True)
    except Exception: pass
    return final


def finalize_native_recording(video_info, audio_info=None):
    """Finalize XR Animator native video, optionally replacing its audio with XRA processed mic.

    The native recorder supplies the high-quality video source. XRA's audio engine can
    supply the podcast/gated audio track. Keeping these paths separate avoids the
    browser screen-share/rescale path while preserving filename/folder/MP4 controls.
    """
    video = Path(video_info["path"])
    final = Path(video_info["final_path"])
    fmt = str(video_info.get("output_format") or "webm").lower()
    audio = Path(audio_info["path"]) if audio_info else None
    video_bps = max(100000, int(video_info.get("video_bps") or 3000000))
    audio_bps = max(32000, int(video_info.get("audio_bps") or 128000))

    if not video.exists() or video.stat().st_size <= 0:
        raise RuntimeError(f"Native XR video source is missing or empty: {video}")

    if audio is None:
        if fmt == "webm":
            final.parent.mkdir(parents=True, exist_ok=True)
            if final.exists(): final.unlink()
            shutil.move(str(video), str(final))
            return final
        return convert_recording(video_info)

    if not audio.exists() or audio.stat().st_size <= 0:
        raise RuntimeError(f"XRA processed audio source is missing or empty: {audio}")
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("FFmpeg is required to mux XRA processed audio with native XR video.")

    common = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
              "-i", str(video), "-i", str(audio), "-map", "0:v:0", "-map", "1:a:0", "-shortest"]

    if fmt == "mp4":
        _run_ffmpeg_with_fallback(
            common + ["-b:v", str(video_bps), "-pix_fmt", "yuv420p",
                      "-c:a", "aac", "-b:a", str(audio_bps), "-movflags", "+faststart"],
            final, video_info.get("hardware_encode", "auto")
        )
    elif fmt == "mkv":
        cmd = common + ["-c:v", "copy", "-c:a", "libopus", "-b:a", str(audio_bps), str(final)]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError((result.stderr or "FFmpeg native MKV mux failed").strip()[-3000:])
    elif fmt == "webm":
        # First try a lossless video stream-copy so the old native recorder quality is
        # preserved exactly. Re-encode only when the native codec is not WebM-compatible.
        cmd = common + ["-c:v", "copy", "-c:a", "libopus", "-b:a", str(audio_bps), str(final)]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            try: final.unlink(missing_ok=True)
            except Exception: pass
            cmd = common + ["-c:v", "libvpx-vp9", "-b:v", str(video_bps),
                            "-deadline", "good", "-cpu-used", "2",
                            "-c:a", "libopus", "-b:a", str(audio_bps), str(final)]
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode != 0:
                raise RuntimeError((result.stderr or "FFmpeg native WebM mux failed").strip()[-3000:])
    else:
        raise RuntimeError(f"Unsupported native output format: {fmt}")

    if not final.exists() or final.stat().st_size <= 0:
        raise RuntimeError(f"Final native recording was not created: {final}")
    try: video.unlink(missing_ok=True)
    except Exception: pass
    try: audio.unlink(missing_ok=True)
    except Exception: pass
    return final


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        path = urlparse(self.path).path
        if path.startswith("/__xra_"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        else:
            suffix = Path(path).suffix.lower()
            if suffix in {".task", ".wasm", ".vrm", ".glb", ".gltf", ".bin"}:
                # Heavy immutable-ish assets: avoid re-reading them on every local reload.
                self.send_header("Cache-Control", "public, max-age=86400")
            else:
                # Code stays easy to iterate on: browser may cache but must revalidate.
                self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_js(self, text, status=200):
        data = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/javascript; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path

        if path.startswith("/__xra_avatar/"):
            avatar = avatar_file(path.removeprefix("/__xra_avatar/"))
            if not avatar:
                self.send_error(404, "Saved avatar not found")
                return
            try:
                size = avatar.stat().st_size
                self.send_response(200)
                self.send_header("Content-Type", "model/gltf-binary")
                self.send_header("Content-Length", str(size))
                self.send_header("Content-Disposition", f'inline; filename="{avatar.name}"')
                self.end_headers()
                with avatar.open("rb") as handle:
                    shutil.copyfileobj(handle, self.wfile, length=1024 * 1024)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        if path == "/__xra_boot_profile.js":
            payload = json.dumps(load_profile(), ensure_ascii=False, separators=(",", ":"))
            payload = payload.replace("</", "<\\/")
            self.send_js("window.__XRA_BOOT_PROFILE__=" + payload + ";\n")
            return

        if path == "/__xra_profile":
            self.send_json(load_profile())
            return

        if path == "/__xra_config":
            self.send_json(load_profile().get("custom", DEFAULT_CUSTOM))
            return

        if path == "/__xra_backgrounds":
            query = urlparse(self.path).query
            files = background_files(force="refresh=1" in query)
            self.send_json({"files": files, "count": len(files)})
            return

        if path == "/__xra_recording/capabilities":
            caps = ffmpeg_encoders()
            caps.update({"default_dir": str(RECORDINGS_DIR.resolve()), "recoveries": len(recovery_list())})
            self.send_json(caps)
            return

        if path == "/__xra_recording/recoveries":
            self.send_json({"ok": True, "items": recovery_list()})
            return

        super().do_GET()

    def read_json_body(self, max_bytes=4 * 1024 * 1024):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > max_bytes:
            raise ValueError("Invalid JSON size")
        obj = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(obj, dict):
            raise ValueError("JSON must be an object")
        return obj

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/__xra_avatar":
            try:
                params = {}
                for pair in parsed.query.split("&"):
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        params[k] = unquote(v)
                filename = params.get("filename") or self.headers.get("X-Filename") or ""
                length = int(self.headers.get("Content-Length", "0"))
                stored = save_avatar_upload(filename, self.rfile, length)
                self.send_json({"ok": True, "filename": stored})
            except Exception as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if path == "/__xra_recording/start":
            try:
                obj = self.read_json_body(128 * 1024)
                session = uuid.uuid4().hex
                folder = resolve_output_dir(obj.get("output_dir"))
                base = safe_recording_name(obj.get("filename"))
                mime = str(obj.get("mime_type") or "video/webm")
                fmt = str(obj.get("output_format") or "webm").lower()
                mode = str(obj.get("mode") or "video_audio")
                src_ext = source_extension_for_mime(mime, obj.get("source_format") or "webm")
                final_ext = final_extension(fmt, mode)
                temporary = bool(obj.get("temporary"))
                force_source_temp = bool(obj.get("force_source_temp")) or temporary
                if temporary:
                    final_path = folder / f".{base}_{session}.temp{final_ext}"
                else:
                    final_path = unique_path(folder, base, final_ext)
                if (not force_source_temp) and src_ext == final_ext and fmt in {"webm", "mp4"}:
                    source_path = final_path
                else:
                    source_path = folder / f".{base}_{session}.source{src_ext}"
                source_path.touch()
                info = {
                    "path": source_path, "final_path": final_path, "bytes": 0, "started": time.time(),
                    "output_format": fmt, "mode": mode, "temporary": temporary,
                    "video_bps": int(obj.get("video_bps") or 0), "audio_bps": int(obj.get("audio_bps") or 0),
                    "hardware_encode": str(obj.get("hardware_encode") or "auto"),
                }
                with RECORDING_LOCK:
                    RECORDING_SESSIONS[session] = info
                write_recording_manifest(session, info)
                self.send_json({"ok": True, "session": session, "path": str(final_path), "writing_path": str(source_path), "resolved_output_dir": str(folder), "output_format": fmt, "ffmpeg_path": find_ffmpeg() or "", "api_version": XRA_RECORDER_API_VERSION})
            except Exception as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if path == "/__xra_recording/choose-folder":
            try:
                obj = self.read_json_body(64 * 1024)
                picked = choose_folder_native(obj.get("initial") or "")
                self.send_json({"ok": True, "path": picked})
            except Exception as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if path == "/__xra_recording/chunk":
            try:
                params = {}
                for pair in parsed.query.split("&"):
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        params[k] = v
                session = params.get("session", "")
                length = int(self.headers.get("Content-Length", "0"))
                if not session or length <= 0 or length > 64 * 1024 * 1024:
                    raise ValueError("Invalid recording chunk")
                with RECORDING_LOCK:
                    info = RECORDING_SESSIONS.get(session)
                if not info:
                    raise ValueError("Unknown recording session")
                remaining = length
                with info["path"].open("ab") as handle:
                    while remaining:
                        data = self.rfile.read(min(1024 * 1024, remaining))
                        if not data:
                            raise IOError("Unexpected end of recording chunk")
                        handle.write(data)
                        remaining -= len(data)
                with RECORDING_LOCK:
                    info["bytes"] += length
                    total = info["bytes"]
                write_recording_manifest(session, info)
                try: free = shutil.disk_usage(info["path"].parent).free
                except Exception: free = None
                self.send_json({"ok": True, "bytes": total, "free_bytes": free})
            except Exception as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if path == "/__xra_recording/finalize-native":
            video_session = ""; audio_session = ""; video_info = None; audio_info = None
            try:
                obj = self.read_json_body(128 * 1024)
                video_session = str(obj.get("video_session") or "")
                audio_session = str(obj.get("audio_session") or "")
                if not video_session:
                    raise ValueError("Missing native video session")
                with RECORDING_LOCK:
                    video_info = RECORDING_SESSIONS.pop(video_session, None)
                    audio_info = RECORDING_SESSIONS.pop(audio_session, None) if audio_session else None
                if not video_info:
                    raise ValueError("Unknown native video session")
                final_path = finalize_native_recording(video_info, audio_info)
                delete_recording_manifest(video_session)
                if audio_session: delete_recording_manifest(audio_session)
                self.send_json({
                    "ok": True, "path": str(final_path),
                    "bytes": final_path.stat().st_size if final_path.exists() else int(video_info.get("bytes") or 0),
                    "format": video_info.get("output_format", "webm"),
                    "source_path": str(video_info.get("path", "")),
                    "audio_source_path": str(audio_info.get("path", "")) if audio_info else "",
                    "api_version": XRA_RECORDER_API_VERSION
                })
            except Exception as exc:
                # Put sessions back so the source files/manifests stay recoverable instead
                # of disappearing after a mux/conversion failure.
                with RECORDING_LOCK:
                    if video_session and video_info: RECORDING_SESSIONS[video_session] = video_info
                    if audio_session and audio_info: RECORDING_SESSIONS[audio_session] = audio_info
                if video_info and video_session: write_recording_manifest(video_session, video_info, error=str(exc))
                if audio_info and audio_session: write_recording_manifest(audio_session, audio_info, error=str(exc))
                self.send_json({
                    "ok": False, "error": str(exc),
                    "source_path": str(video_info.get("path", "")) if video_info else "",
                    "audio_source_path": str(audio_info.get("path", "")) if audio_info else "",
                    "recoverable": bool(video_info), "api_version": XRA_RECORDER_API_VERSION
                }, status=400)
            return

        if path == "/__xra_recording/finish":
            session = ""; info = None
            try:
                obj = self.read_json_body(128 * 1024); session = str(obj.get("session") or "")
                with RECORDING_LOCK: info = RECORDING_SESSIONS.pop(session, None)
                if not info:
                    mp = _manifest_path(session)
                    if mp.exists():
                        raw = json.loads(mp.read_text(encoding="utf-8")); info = dict(raw)
                        info["path"] = Path(raw["path"]); info["final_path"] = Path(raw["final_path"])
                if not info: raise ValueError("Unknown recording session")
                final_path = convert_recording(info); delete_recording_manifest(session)
                self.send_json({"ok": True, "path": str(final_path), "bytes": final_path.stat().st_size if final_path.exists() else info["bytes"], "seconds": max(0.0, time.time() - info["started"]), "format": info.get("output_format", "webm"), "source_path": str(info.get("path", "")), "ffmpeg_path": find_ffmpeg() or "", "api_version": XRA_RECORDER_API_VERSION})
            except Exception as exc:
                if info and session: write_recording_manifest(session, info, error=str(exc))
                source_path = str(info.get("path")) if info else ""
                self.send_json({"ok": False, "error": str(exc), "source_path": source_path, "recoverable": bool(source_path)}, status=400)
            return

        if path == "/__xra_recording/recover":
            try:
                obj = self.read_json_body(64 * 1024); session = str(obj.get("session") or ""); mp = _manifest_path(session)
                if not session or not mp.exists(): raise ValueError("Recovery session not found")
                raw = json.loads(mp.read_text(encoding="utf-8")); info = dict(raw)
                info["path"] = Path(raw["path"]); info["final_path"] = Path(raw["final_path"])
                final_path = convert_recording(info); delete_recording_manifest(session)
                self.send_json({"ok": True, "path": str(final_path), "bytes": final_path.stat().st_size})
            except Exception as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        if path not in ("/__xra_profile", "/__xra_config"):
            self.send_error(404)
            return

        try:
            obj = self.read_json_body()
            if path == "/__xra_config":
                profile = load_profile()
                profile["custom"] = obj
            else:
                profile = obj
                if "custom" not in profile:
                    raise ValueError("Profile must contain 'custom'")

            save_profile(profile)
            self.send_json({"ok": True})
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=400)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8000), Handler)
    server.daemon_threads = True
    print("XR Animator · XRA server")
    print("http://127.0.0.1:8000/XR_Animator.html")
    print(f"Profile: {PROFILE_FILE}")
    print(f"Backup:  {BACKUP_FILE}")
    print(f"Avatars: {AVATAR_DIR}")
    server.serve_forever()
