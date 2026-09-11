# XRA_UNIVERSAL_RUNTIME_V9
# XRA_RUNTIME_BUILD_V8
# XRA_PERFORMANCE_RUNTIME_V7
"""ONNX Runtime discovery + execution-provider selection.

Design goals
------------
* **No hardcoded GPU vendor.** We ask ONNX Runtime which execution providers
  (EPs) are actually available on *this* machine and pick the fastest one in a
  fixed preference order. If none of the accelerated EPs exist (potato PC),
  we fall back to CPU -- which onnxruntime-gpu can also do fine.
* **No mandatory pip install.** The runtime is bootstrapped from wheels bundled
  in ``xra_backends/wheels`` into a repo-local ``xra_backends/runtime`` folder
  that is prepended to ``sys.path``. ``bootstrap_import`` tries that path first.
* **Never poison the caller.** Import failures are reported, not raised, so the
  HTTP server can keep serving even when the backend runtime is missing.
"""

from __future__ import annotations

import glob
import importlib
import importlib.util
import json
import os
import subprocess
import sys
import sysconfig
import threading
from pathlib import Path
from typing import Optional

_PKG_DIR = Path(__file__).resolve().parent
REPO_ROOT = _PKG_DIR.parent
WHEELS_DIR = _PKG_DIR / "wheels"
RUNTIME_DIR = _PKG_DIR / "runtime"
STATE_FILE = _PKG_DIR / "runtime_state.json"

# Ordered by *estimated* speed. onnxruntime only reports EPs that are actually
# usable on this machine, so order == preference. CPU is always the floor.
PROVIDER_PREFERENCE = (
    "CUDAExecutionProvider",
    "MIGraphXExecutionProvider",   # AMD ROCm
    "ROCMExecutionProvider",       # AMD ROCm
    "DmlExecutionProvider",        # Windows DirectML
    "CoreMLExecutionProvider",     # Apple
    "OpenVINOExecutionProvider",   # Intel
    "CPUExecutionProvider",
)

_HUMAN = {
    "CUDAExecutionProvider": "NVIDIA CUDA",
    "MIGraphXExecutionProvider": "AMD MIGraphX",
    "ROCMExecutionProvider": "AMD ROCm",
    "DmlExecutionProvider": "DirectML",
    "CoreMLExecutionProvider": "Apple CoreML",
    "OpenVINOExecutionProvider": "Intel OpenVINO",
    "CPUExecutionProvider": "CPU",
}

# Accelerated EPs that stream frames over a PCIe bus. On weak/integrated GPUs
# the copy overhead can make inference *slower* than the native CPU AVX2 path,
# so we deliberately steer those machines to CPU.
_GPU_PROVIDERS = (
    "CUDAExecutionProvider",
    "MIGraphXExecutionProvider",
    "ROCMExecutionProvider",
    "DmlExecutionProvider",
    "OpenVINOExecutionProvider",
)

# GPU-name markers that indicate an integrated / low-power adapter. When the
# only GPU we can see matches one of these, the CPU EP (AVX2/AVX512) usually
# beats the PCIe transfer overhead, so we keep CPU.
_WEAK_GPU_MARKERS = (
    "intel", "uhd", "hd graphics", "iris", "gma",
    "radeon graphics", "radeon vega", "vega 8", "vega 11", "amd radeon (tm)",
    "llvmpipe", "swiftshader", "microsoft basic", "microsoft remote",
)

_ort = None  # cached module handle
_provider_lock = threading.RLock()
_provider_failures: dict[str, str] = {}
_preload_report: dict = {}



def human_name(provider: str) -> str:
    # UI v9 shows the actual execution backend; avoid capability/marketing names.
    return provider

def _prefer_environment_runtime() -> bool:
    return not bool(getattr(sys, "frozen", False)) and sys.prefix != getattr(sys, "base_prefix", sys.prefix)

def _ensure_runtime_path(force_vendored: bool = False) -> None:
    """Prefer the active venv ORT; keep the bundled CPU runtime as fallback."""
    runtime = str(RUNTIME_DIR)
    if _prefer_environment_runtime() and not force_vendored:
        while runtime in sys.path:
            sys.path.remove(runtime)
        return
    if RUNTIME_DIR.exists() and runtime not in sys.path:
        sys.path.insert(0, runtime)

def bootstrap_import() -> Optional[object]:
    """Import ORT from the venv first, falling back to the bundled runtime."""
    global _ort
    if _ort is not None:
        return _ort

    _ensure_runtime_path(force_vendored=False)
    importlib.invalidate_caches()
    try:
        _ort = importlib.import_module("onnxruntime")
        return _ort
    except Exception:
        _ort = None

    if _prefer_environment_runtime():
        _ensure_runtime_path(force_vendored=True)
        importlib.invalidate_caches()
        try:
            _ort = importlib.import_module("onnxruntime")
        except Exception:
            _ort = None
    return _ort

def is_available() -> bool:
    return bootstrap_import() is not None


def installed_version() -> Optional[str]:
    ort = bootstrap_import()
    return getattr(ort, "__version__", None) if ort is not None else None


def available_providers() -> list[str]:
    ort = bootstrap_import()
    if ort is None:
        return []
    try:
        return list(ort.get_available_providers())
    except Exception:
        return []


def best_provider(available: Optional[list[str]] = None) -> str:
    """Return the fastest EP this machine reports, CPU as the guaranteed floor."""
    providers = available if available is not None else available_providers()
    for wanted in PROVIDER_PREFERENCE:
        if wanted in providers:
            return wanted
    return "CPUExecutionProvider"


# ---------------------------------------------------------------------------
# GPU probing (vendor-neutral) used to decide GPU-vs-CPU on weak adapters
# ---------------------------------------------------------------------------

def _gpu_names() -> list[str]:
    """Best-effort list of GPU adapter names present on this machine.

    Never raises and never shells out to anything we do not ship: it only reads
    well-known system paths / pure-python probes. Returns [] when unknown.
    """
    names: list[str] = []

    # Linux: sysfs exposes the PCI vendor/device IDs; the PCI database (if
    # present) gives us a human string. We mostly need the vendor heuristics,
    # so the raw IDs + a couple of common integrated-device tables are enough.
    try:
        for vendor_file in glob.glob("/sys/class/drm/card*/device/vendor"):
            try:
                vid = Path(vendor_file).read_text().strip().lower()
            except Exception:
                continue
            dev_path = Path(vendor_file).with_name("device")
            did = ""
            try:
                did = dev_path.read_text().strip().lower()
            except Exception:
                pass
            if vid == "0x8086":          # Intel
                names.append("intel")
            elif vid == "0x1002":        # AMD/ATI
                names.append("amd radeon")
            elif vid == "0x10de":        # NVIDIA
                names.append("nvidia")
            # Specific integrated Vega APUs (common weak iGPU ids).
            if did in {"0x15d8", "0x15dd", "0x1636", "0x164c"}:
                names.append("vega")
    except Exception:
        pass

    # Windows: DirectML / WMI would need extra deps; skip (unknown -> assume
    # capable GPU so CUDA/DML is attempted and the load-time fallback applies).
    if sys.platform == "win32":
        return names

    # Fallback: some distros expose a machine-readable summary.
    try:
        proc = subprocess.run(["lspci"], capture_output=True, text=True, timeout=2)
        if proc.returncode == 0:
            for line in proc.stdout.splitlines():
                low = line.lower()
                if "vga" in low or "3d controller" in low or "display" in low:
                    names.append(low)
    except Exception:
        pass

    return names


def _looks_integrated(names: list[str]) -> bool:
    """True if every known GPU is integrated/low-power (or none is known)."""
    if not names:
        # Nothing detected: we cannot confirm a discrete dGPU. Rather than
        # assume the worst (and lose the GPU build on capable-but-undetected
        # machines) we let the load-time fallback decide. Return False so the
        # GPU EP is *attempted*; if libcudart/etc. fail, resolve_* falls back.
        return False
    discrete_markers = ("nvidia", "geforce", "quadro", "tesla", "rtx", "gtx",
                        "radeon rx", "radeon pro", "arc ", "discrete")
    if any(any(m in n for m in discrete_markers) for n in names):
        return False
    return all(any(m in n for m in _WEAK_GPU_MARKERS) for n in names)


def _truthy(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def strict_provider_policy() -> bool:
    """Compatibility shim: v9 always falls back automatically at runtime."""
    return False

def mark_provider_unhealthy(provider: Optional[str], error: object) -> None:
    if not provider or provider == "CPUExecutionProvider":
        return
    message = str(error).replace("\n", " ").strip()
    with _provider_lock:
        _provider_failures[provider] = message[:1200]
    print(f"[XRA_BACKEND] Quarantined provider {provider}: {message}", flush=True)


def provider_failures() -> dict[str, str]:
    with _provider_lock:
        return dict(_provider_failures)


def clear_provider_failures(provider: Optional[str] = None) -> None:
    with _provider_lock:
        if provider:
            _provider_failures.pop(provider, None)
        else:
            _provider_failures.clear()


def preload_accelerator_libraries(ort: Optional[object] = None) -> dict:
    """Best-effort preload for CUDA/cuDNN packages installed by pip.

    Availability is still decided by a real model warm-up in engine.py. Merely
    seeing CUDAExecutionProvider in get_available_providers() is not enough.
    """
    global _preload_report
    module = ort if ort is not None else bootstrap_import()
    if module is None:
        _preload_report = {"attempted": False, "ok": False, "error": "onnxruntime unavailable"}
        return dict(_preload_report)
    providers = available_providers()
    if "CUDAExecutionProvider" not in providers:
        _preload_report = {"attempted": False, "ok": True, "reason": "no CUDA provider reported"}
        return dict(_preload_report)
    loader = getattr(module, "preload_dlls", None)
    if not callable(loader):
        _preload_report = {"attempted": False, "ok": True, "reason": "preload_dlls unavailable"}
        return dict(_preload_report)
    try:
        try:
            loader(directory="")
        except TypeError:
            loader()
        _preload_report = {"attempted": True, "ok": True}
    except Exception as exc:
        _preload_report = {
            "attempted": True,
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
        }
    return dict(_preload_report)


def openvino_devices() -> list[str]:
    """Return devices exposed by the standalone OpenVINO runtime.

    OpenVINO is intentionally independent from onnxruntime-openvino: the
    universal bundle keeps one ORT distribution (onnxruntime-gpu) and uses the
    native OpenVINO Python API as the Intel path.
    """
    try:
        import openvino as ov
        core = ov.Core()
        return list(core.available_devices)
    except Exception:
        return []


def execution_candidates() -> list[str]:
    """Ordered, automatic execution candidates for the current machine."""
    out: list[str] = []
    failures = provider_failures()
    providers = available_providers()
    if "CUDAExecutionProvider" in providers and "CUDAExecutionProvider" not in failures:
        out.append("CUDAExecutionProvider")

    ov_devices = openvino_devices()
    gpu = next((d for d in ov_devices if str(d).upper().startswith("GPU")), None)
    cpu = next((d for d in ov_devices if str(d).upper().startswith("CPU")), None)
    if gpu and f"OpenVINO:{gpu}" not in failures:
        out.append(f"OpenVINO:{gpu}")
    if cpu and f"OpenVINO:{cpu}" not in failures:
        out.append(f"OpenVINO:{cpu}")

    if "CPUExecutionProvider" in providers:
        out.append("CPUExecutionProvider")
    return out


def resolve_providers() -> tuple[list[str], list[dict]]:
    """Return the ORT path only; OpenVINO is selected directly by engine.py.

    TensorRT is deliberately never returned. CUDA is preferred when reported
    and not quarantined, with ORT CPU as graph fallback. A real model warm-up in
    engine.py decides whether CUDA is actually usable (including cuDNN).
    """
    available = available_providers()
    failures = provider_failures()
    if "CUDAExecutionProvider" in available and "CUDAExecutionProvider" not in failures:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"], [
            provider_options("CUDAExecutionProvider"), {}
        ]
    if "CPUExecutionProvider" in available:
        return ["CPUExecutionProvider"], [{}]
    return [], []

def log_provider(provider: Optional[str], model_id: Optional[str] = None) -> None:
    """Print the resolved execution provider, matching the agreed log format."""
    label = provider or "unknown"
    suffix = f" ({model_id})" if model_id else ""
    print(f"[XRA_BACKEND] Using provider: {label}{suffix}")


def provider_options(provider: str) -> dict:
    if provider == "CUDAExecutionProvider":
        return {
            "arena_extend_strategy": "kSameAsRequested",
            "cudnn_conv_algo_search": "DEFAULT",
        }
    return {}

def describe() -> dict:
    """Capability snapshot. `active provider` comes from engine.status(), not here."""
    ort = bootstrap_import()
    providers = [p for p in available_providers() if p != "TensorrtExecutionProvider"]
    failures = provider_failures()
    candidates = execution_candidates()
    return {
        "available": ort is not None,
        "version": installed_version(),
        "providers": providers,
        "openvino_devices": openvino_devices(),
        "execution_candidates": candidates,
        # Kept only for old diagnostics; the UI must not present this as active.
        "best_provider": candidates[0] if candidates else None,
        "best_provider_human": candidates[0] if candidates else None,
        "accelerated": bool(candidates and candidates[0] != "CPUExecutionProvider"),
        "provider_failures": failures,
        "gpus": _gpu_names(),
        "runtime_dir": str(RUNTIME_DIR),
        "module_file": str(getattr(ort, "__file__", "")) if ort is not None else "",
        "python_executable": sys.executable,
        "python_version": sys.version.split()[0],
        "preload": dict(_preload_report),
        "wheels_dir": str(WHEELS_DIR),
    }

def _wheel_platform_tag() -> str:
    """Best-effort platform tag used to pick the right bundled wheel."""
    if sys.platform.startswith("linux"):
        machine = (os.uname().machine if hasattr(os, "uname") else "x86_64").lower()
        arch = "x86_64" if machine in ("x86_64", "amd64") else machine
        return f"manylinux_{arch}"
    if sys.platform == "win32":
        return "win_amd64"
    if sys.platform == "darwin":
        machine = (os.uname().machine if hasattr(os, "uname") else "arm64").lower()
        return "macosx_11_0_arm64" if machine in ("arm64", "aarch64") else "macosx_10_9_x86_64"
    return sysconfig.get_platform()


def bundled_wheels() -> list[Path]:
    if not WHEELS_DIR.exists():
        return []
    return sorted(p for p in WHEELS_DIR.glob("*.whl"))


def _install_wheels(wheels: list[Path]) -> tuple[bool, str]:
    """Install the given wheels into RUNTIME_DIR with --no-index (offline)."""
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "pip", "install",
           "--no-index", "--no-deps",
           "--target", str(RUNTIME_DIR),
           "--upgrade"]
    cmd += [str(w) for w in wheels]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except Exception as exc:  # pragma: no cover - environment specific
        return False, f"pip invocation failed: {exc}"
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout or "pip failed").strip()
    return True, "installed"


def bootstrap_install(force: bool = False) -> dict:
    """Try to make onnxruntime importable from the bundled wheels.

    Order:
      1. Already importable (vendored or system) -> done.
      2. Install the wheels that match this platform into RUNTIME_DIR.
    Returns a JSON-serializable status dict; never raises.
    """
    if not force and is_available():
        return {"ok": True, "action": "already-available", "status": describe()}

    wheels = bundled_wheels()
    if not wheels:
        return {"ok": False, "action": "no-wheels",
                "error": f"No wheels bundled in {WHEELS_DIR}",
                "expected_platform": _wheel_platform_tag()}

    tag = _wheel_platform_tag()
    # Prefer wheels matching the platform; if none match, still try them all
    # (pip will reject incompatible ones with a clear message).
    platform_wheels = [w for w in wheels if tag.split("_")[-1] in w.name] or wheels
    ok, message = _install_wheels(platform_wheels)

    # bust caches so the freshly installed copy is importable
    global _ort
    _ort = None
    importlib.invalidate_caches()

    state = {"ok": ok and is_available(), "action": "install", "message": message,
             "platform": tag, "wheels": [w.name for w in platform_wheels],
             "status": describe()}
    try:
        STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception:
        pass
    return state
