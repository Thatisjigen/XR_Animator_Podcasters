#!/usr/bin/env python3
"""XR Animator - Complete Pipeline, AI Model, Hardware & System Performance Profiler.

Usage:
    ./.venv311/bin/python scripts/profile_pipeline.py [--port 8000] [--watch 1.0] [--json]
"""

import argparse
import glob
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


def get_nvidia_metrics():
    """Query nvidia-smi for real-time GPU load, memory, temperature, and power."""
    if not shutil.which("nvidia-smi"):
        return []
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
             "--format=csv,noheader,nounits"],
            text=True, timeout=2
        ).strip()
        results = []
        for line in out.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 6:
                results.append({
                    "name": parts[0],
                    "util_pct": float(parts[1]),
                    "mem_used_mb": float(parts[2]),
                    "mem_total_mb": float(parts[3]),
                    "temp_c": float(parts[4]),
                    "power_w": float(parts[5]),
                })
        return results
    except Exception:
        return []


def get_drm_gpus():
    """Detect all GPU nodes present in /sys/class/drm."""
    gpus = []
    try:
        cards = sorted(glob.glob('/sys/class/drm/card[0-9]'))
        for c in cards:
            c_name = os.path.basename(c)
            vendor_path = os.path.join(c, 'device', 'vendor')
            device_path = os.path.join(c, 'device', 'device')
            if not os.path.exists(vendor_path):
                continue
            with open(vendor_path) as vf:
                vendor = vf.read().strip().lower()
            dev_id = ''
            if os.path.exists(device_path):
                with open(device_path) as df:
                    dev_id = df.read().strip().lower()

            render_node = None
            render_paths = sorted(glob.glob(os.path.join(c, 'device', 'drm', 'renderD*')))
            if render_paths:
                render_node = os.path.basename(render_paths[0])

            vname = "Unknown"
            is_dedicated = False
            if '0x10de' in vendor:
                vname = "NVIDIA Dedicated (RTX)"
                is_dedicated = True
            elif '0x8086' in vendor:
                vname = "Intel Integrated (Iris Xe / UHD)"
            elif '0x1002' in vendor or '0x1022' in vendor:
                vname = "AMD Radeon"
                is_dedicated = True

            gpus.append({
                "card": c_name,
                "render_node": render_node,
                "vendor": vname,
                "vendor_id": vendor,
                "device_id": dev_id,
                "is_dedicated": is_dedicated
            })
    except Exception:
        pass
    return gpus


def get_cpu_info():
    """Read CPU model, logical cores, and scaling governor."""
    info = {"model": "Unknown CPU", "cores_logical": os.cpu_count() or 1, "governor": "unknown"}
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if "model name" in line:
                    info["model"] = line.split(":", 1)[1].strip()
                    break
    except Exception:
        pass
    try:
        with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor") as f:
            info["governor"] = f.read().strip()
    except Exception:
        pass
    return info


def find_server(preferred_port=8000):
    """Auto-probe for running XR Animator server on localhost ports."""
    candidates = [preferred_port] + [p for p in (8000, 8001, 8002, 8080) if p != preferred_port]
    for p in candidates:
        try:
            with socket.create_connection(("127.0.0.1", p), timeout=0.15):
                pass
        except (socket.timeout, ConnectionRefusedError, OSError):
            continue
        try:
            req = urllib.request.urlopen(f"http://127.0.0.1:{p}/__xra_backend/status", timeout=6.0)
            status = json.loads(req.read().decode())
            if status.get("ok"):
                return p, status
        except Exception:
            continue
    return None, None


def read_core_stats():
    """Sample /proc/stat for per-core metrics."""
    stats = {}
    try:
        with open("/proc/stat") as f:
            for line in f:
                if not line.startswith("cpu"):
                    continue
                parts = line.split()
                name = parts[0]
                if name == "cpu":
                    continue
                vals = list(map(int, parts[1:8]))
                idle = vals[3]
                total = sum(vals)
                stats[name] = (idle, total)
    except Exception:
        pass
    return stats


def print_profile(port, status, sample_core_load=True):
    print("=" * 70)
    print("          XR ANIMATOR · FULL PIPELINE & SYSTEM PROFILER")
    print("=" * 70)

    # 1. System Hardware & GPU Vitals
    cpu_info = get_cpu_info()
    drm_gpus = get_drm_gpus()
    nv_metrics = get_nvidia_metrics()

    print("\n[1] SYSTEM HARDWARE & GPU TELEMETRY")
    print(f"  CPU Model:          {cpu_info['model']}")
    print(f"  Logical Cores:      {cpu_info['cores_logical']} (Governor: {cpu_info['governor']})")
    print(f"  Detected DRM GPUs:  {len(drm_gpus)}")
    for g in drm_gpus:
        node_str = f"[{g['render_node']}]" if g['render_node'] else ""
        ded_str = "Dedicata" if g['is_dedicated'] else "Integrata"
        print(f"    - {g['card']} {node_str:<12} | {g['vendor']} ({ded_str}, id: {g['vendor_id']}:{g['device_id']})")

    if nv_metrics:
        for nv in nv_metrics:
            print(f"  NVIDIA GPU Telemetry (nvidia-smi):")
            print(f"    - Device:         {nv['name']}")
            print(f"    - GPU Load:       {nv['util_pct']:.1f}%")
            print(f"    - VRAM In Use:    {nv['mem_used_mb']:.1f} MB / {nv['mem_total_mb']:.1f} MB ({(nv['mem_used_mb']/max(1, nv['mem_total_mb']))*100:.1f}%)")
            print(f"    - Temperature:    {nv['temp_c']:.0f} °C")
            print(f"    - Power Draw:     {nv['power_w']:.2f} W")

    if not status:
        print("\n[2] BACKEND SERVER STATUS")
        print("  ⚠️  SERVER OFFLINE: Nessun server XR Animator in ascolto sulle porte 8000..8080.")
        print("  Per avviare: ./XR_Animator oppure ./.venv311/bin/python xr_server.py\n")
        print("=" * 70)
        return

    # 2. Server Process & AI Engine Status
    proc = status.get("process", {})
    act = status.get("active", {})
    cap = status.get("capture", {})
    trans = status.get("transport", {})

    pid = proc.get("pid")
    cores = proc.get("cores", 1)
    cpu_pct = proc.get("cpu_percent", 0.0)
    rss_mb = proc.get("rss_mb", 0.0)
    threads_count = proc.get("threads", 0)

    print(f"\n[2] BACKEND SERVER & AI ENGINE STATUS (Port {port})")
    print(f"  Server PID:         {pid}")
    total_machine_cpu = cpu_pct / max(1, cores)
    print(f"  Process CPU:        {cpu_pct:.1f}% (~{total_machine_cpu:.1f}% of entire system)")
    print(f"  RAM Usage (RSS):    {rss_mb:.1f} MB")
    print(f"  OS Active Threads:  {threads_count}")

    # Active AI Model & Hardware Delegate
    model_id = act.get("model") or "mediapipe-tasks-landmarker"
    provider = act.get("provider") or "Native/MediaPipe Tasks"
    mode = act.get("mode") or "holistic"
    comp = act.get("model_complexity", 1)
    accel = act.get("accelerated", True)
    hw_mode = act.get("hardware_mode", "Auto")
    gpu_avail = act.get("gpu_available", True)
    gpu_name = act.get("gpu_name") or "Unknown GPU"

    if accel:
        accel_str = f"Accelerato su GPU (MediaPipe EGL · {gpu_name})"
    elif hw_mode.lower() == "cpu":
        accel_str = "Software CPU (XNNPACK · Scelta manuale da impostazioni)"
    else:
        accel_str = "Software CPU (XNNPACK · Fallback automatico: modello Holistic upstream richiede CPU per blendshape facciali)"

    print(f"  Active Model:       {model_id} (Pipeline: {mode.upper()}, Complexity: {comp})")
    print(f"  Provider Engine:    {provider}")
    print(f"  Hardware Delegate:  {accel_str}")
    if accel:
        print(f"  Active GPU In Use:  {gpu_name}")
    else:
        print(f"  Active GPU In Use:  Nessuna (Tracking puro su CPU)")
    print(f"  Configured Mode:    {hw_mode}")
    print(f"  Host GPU Supported: {'SI' if gpu_avail else 'NO'}")

    t_conf = act.get("min_tracking_confidence", 0.5)
    p_conf = act.get("min_pose_confidence", 0.5)
    f_conf = act.get("min_face_confidence", 0.5)
    j_conf = act.get("min_joint_confidence", 0.15)
    wrist_guard = act.get("desk_wrist_guard", True)
    wrist_thresh = act.get("desk_wrist_threshold", 0.45)
    print(f"  Confidence Limits:  Tracking: {t_conf:.2f} · Pose: {p_conf:.2f} · Face: {f_conf:.2f} · Joint: {j_conf:.2f}")
    print(f"  Desk Wrist Guard:   {'ATTIVO' if wrist_guard else 'DISATTIVO'} (Soglia gomito: {wrist_thresh:.2f})")

    # 3. Camera & Latency Breakdown
    infer_ms = cap.get("inference_ema_ms", 0.0)
    last_infer_ms = cap.get("last_infer_ms", 0.0)
    cap_ms = cap.get("last_capture_ms", 0.0)
    proc_ms = cap.get("processing_ema_ms", 0.0)
    target_fps = float(cap.get("target_fps", 30.0))
    eff_fps = float(cap.get("effective_fps", 0.0))
    meas_fps = float(cap.get("measured_fps", 0.0))
    geom_infer = cap.get("inference_geometry", [])
    geom_raw = cap.get("capture_geometry", [])
    misses = cap.get("deadline_misses", 0)
    total_frames = cap.get("frames", 1)
    cam_device = cap.get("device", "/dev/video0")
    cam_backend = cap.get("backend", "v4l2")
    cam_open = cap.get("camera_open", False)
    cam_pub = cap.get("publishing", False)
    held_joints = cap.get("held_joints", 0)
    dropped_hands = cap.get("dropped_hands", 0)

    budget_ms = 1000.0 / target_fps if target_fps > 0 else 33.3

    print(f"\n[3] CAMERA & TRACKING PIPELINE LATENCY (Target: {target_fps:.1f} FPS, Budget: {budget_ms:.1f} ms/frame)")
    status_cam = "APERTA & IN STREAMING" if (cam_open and cam_pub) else ("APERTA" if cam_open else "CHIUSA / IN PAUSA")
    print(f"  Camera Device:      {cam_device} (Backend: {cam_backend}) | Stato: {status_cam}")
    print(f"  Hardware Sensor:    {geom_raw} @ {eff_fps:.1f} FPS negoziati")
    print(f"  Inference Geometry: {geom_infer}")
    print(f"  Camera Wait Time:   {cap_ms:.2f} ms")
    print(f"  MediaPipe Inference:{infer_ms:.2f} ms EMA (ultimo frame: {last_infer_ms:.2f} ms)")
    print(f"  Total Processing:   {proc_ms:.2f} ms")
    print(f"  Actual Measured FPS:{meas_fps:.2f} FPS")
    print(f"  Deadline Misses:    {misses} / {total_frames} ({(misses / max(1, total_frames)) * 100:.1f}%)")
    print(f"  Arm Anti-Jitter:    Held Joints: {held_joints} | Dropped Hands: {dropped_hands}")

    # 4. WebSocket & IPC Transport
    is_connected = trans.get("connected", False)
    conn_count = trans.get("connections", 0)
    subs = trans.get("subscribers", 0)
    frames_sent = trans.get("frames_sent", 0)
    msgs_sent = trans.get("messages_sent", 0)
    dropped_frames = trans.get("dropped_frames", 0)
    q_depth = trans.get("queue_depth", 0)

    print(f"\n[4] WEBSOCKET & IPC TRANSPORT")
    print(f"  Client Connessi:    {conn_count} (Subscriber Pose: {subs}) | Connesso: {'SI' if is_connected else 'NO'}")
    print(f"  Frame Inviati:      {frames_sent} | Messaggi: {msgs_sent}")
    print(f"  Dropped Frames:     {dropped_frames} | Coda WebSocket: {q_depth}")

    # 5. Server Thread-Level CPU Breakdown
    if pid:
        print(f"\n[5] SERVER OS THREAD BREAKDOWN (ps -T -p {pid})")
        try:
            ps_out = subprocess.check_output(
                ["ps", "-T", "-p", str(pid), "-o", "tid,pcpu,comm"], text=True
            )
            lines = ps_out.strip().splitlines()
            drishti_cpu = 0.0
            python_cpu = 0.0
            active_threads = []
            for line in lines[1:]:
                parts = line.split()
                if len(parts) >= 3:
                    tid = parts[0]
                    pcpu = float(parts[1])
                    comm = parts[2]
                    if "drishti" in comm:
                        drishti_cpu += pcpu
                    else:
                        python_cpu += pcpu
                    if pcpu >= 0.8:
                        active_threads.append((tid, pcpu, comm))

            for tid, pcpu, comm in sorted(active_threads, key=lambda x: x[1], reverse=True)[:8]:
                role = "MediaPipe C++ worker" if "drishti" in comm else "Python capture / I/O loop"
                print(f"    TID {tid:>8} | {pcpu:>5.1f}% CPU | {comm:<12} ({role})")

            print(f"  Thread Group Totals:")
            print(f"    - MediaPipe C++ Graph Engine ('drishti'): {drishti_cpu:.1f}% CPU")
            print(f"    - Python / OpenCV / WebSocket I/O:        {python_cpu:.1f}% CPU")
        except Exception as exc:
            print(f"  Could not read OS thread statistics: {exc}")

    # 6. Per-Core CPU Usage
    if sample_core_load:
        try:
            snap1 = read_core_stats()
            time.sleep(0.4)
            snap2 = read_core_stats()

            BAR_WIDTH = 20
            print(f"\n[6] PER-CORE CPU USAGE (400 ms sample, {len(snap2)} cores)")
            busy_list = []
            for core in sorted(snap2.keys(), key=lambda c: int(c[3:])):
                if core not in snap1:
                    continue
                idle1, total1 = snap1[core]
                idle2, total2 = snap2[core]
                dtotal = total2 - total1
                didle = idle2 - idle1
                busy_pct = (1.0 - didle / dtotal) * 100.0 if dtotal > 0 else 0.0
                busy_list.append(busy_pct)
                filled = int(busy_pct / 100.0 * BAR_WIDTH)
                bar = "█" * filled + "░" * (BAR_WIDTH - filled)
                core_id = core[3:]
                print(f"    Core {core_id:>2}  [{bar}] {busy_pct:5.1f}%")

            if busy_list:
                avg = sum(busy_list) / len(busy_list)
                peak = max(busy_list)
                print(f"  Average Load: {avg:.1f}% | Peak Core: {peak:.1f}% | Saturation (>80%): {sum(1 for x in busy_list if x > 80)}/{len(busy_list)}")
        except Exception as exc:
            print(f"  Could not read per-core stats: {exc}")

    # 7. Frontend Chromium / NW.js Breakdown
    print(f"\n[7] FRONTEND RENDERER & CHROMIUM / NW.JS PROFILER")
    try:
        ps_all = subprocess.check_output(
            ["ps", "-eo", "pid,ppid,pcpu,rss,comm,args"], text=True
        ).splitlines()
        renderers = []
        gpu_processes = []
        browser_mains = []
        for line in ps_all:
            parts = line.strip().split(None, 5)
            if len(parts) < 6:
                continue
            c_pid, c_ppid, c_cpu, c_rss, c_comm, c_args = parts
            ptext = f"{c_comm} {c_args}".lower()
            if not any(token in ptext for token in ("chrome", "chromium", "xra_browser", "nw", "xr_animator", "/proc/self/exe")):
                continue
            entry = (int(c_pid), int(c_ppid), float(c_cpu), int(c_rss) / 1024.0, c_comm)
            if "--type=gpu-process" in c_args:
                gpu_processes.append(entry)
            elif "--type=renderer" in c_args and "--extension-process" not in c_args and "--top-chrome-webui" not in c_args:
                renderers.append(entry)
            elif not c_args.startswith("--type="):
                browser_mains.append(entry)

        # In NW.js, if renderers list is empty, main application process may be the renderer
        if not renderers and browser_mains:
            renderers = browser_mains

        if renderers:
            xra_renderer = max(renderers, key=lambda item: item[2])
            xr_pid, xr_parent_pid, xr_cpu, xr_rss, xr_comm = xra_renderer
            print(f"  Frontend Window Process ({xr_comm}, PID {xr_pid}):")
            print(f"    - Total CPU:      {xr_cpu:.1f}% (~{xr_cpu / max(1, cores):.1f}% of system)")
            print(f"    - RAM Usage (RSS):{xr_rss:.1f} MB")

            try:
                t_out = subprocess.check_output(
                    ["ps", "-T", "-p", str(xr_pid), "-o", "tid,pcpu,comm"], text=True
                ).splitlines()[1:]
                best_threads = []
                for tl in t_out:
                    tp = tl.strip().split(None, 2)
                    if len(tp) == 3:
                        best_threads.append((tp[0], float(tp[1]), tp[2]))

                print(f"    - Active Threads: {len(best_threads)}")
                main_js_cpu = 0.0
                worker_cpu = 0.0
                comp_cpu = 0.0
                pool_cpu = 0.0
                for tid, tcpu, tcomm in sorted(best_threads, key=lambda x: x[1], reverse=True)[:8]:
                    if int(tid) == xr_pid or any(k in tcomm for k in ("chrome", "nw", "xra_browser")):
                        role = "Main JS & Three.js 3D Render Loop"
                        main_js_cpu += tcpu
                    elif "DedicatedWorker" in tcomm:
                        role = "Pose & Mocap WebSocket Worker"
                        worker_cpu += tcpu
                    elif "Compositor" in tcomm:
                        role = "Display VSync & Presentation"
                        comp_cpu += tcpu
                    elif "ThreadPool" in tcomm:
                        role = "V8 Engine & Background Tasks"
                        pool_cpu += tcpu
                    else:
                        role = "Subsystem"
                    if tcpu > 0.0:
                        print(f"      TID {tid:>8} | {tcpu:>5.1f}% CPU | {tcomm:<15} ({role})")

                print(f"    Thread Group Totals:")
                print(f"      - Three.js 3D Animation Loop:         {main_js_cpu:.1f}% CPU")
                print(f"      - Pose Worker & WebSocket Bridge:     {worker_cpu:.1f}% CPU")
                print(f"      - Compositor & Screen Refresh:        {comp_cpu:.1f}% CPU")
            except Exception:
                pass
        else:
            print("  Stato: Nessun processo UI XR Animator / Chromium rilevato.")

        if gpu_processes:
            g_pid, _g_ppid, g_cpu, g_rss, g_comm = max(gpu_processes, key=lambda item: item[2])
            print(f"  Chromium GPU Helper Process ({g_comm}, PID {g_pid}):")
            print(f"    - GPU Process CPU:{g_cpu:.1f}% (WebGL / Wayland rasterization)")
            print(f"    - RAM Usage (RSS):{g_rss:.1f} MB")
    except Exception as exc:
        print(f"  Could not profile frontend processes: {exc}")

    # 8. Diagnostic Summary & Bottleneck Analysis
    print("\n" + "-" * 70)
    print("DIAGNOSTIC SUMMARY & BOTTLENECK ANALYSIS:")
    if meas_fps < (target_fps * 0.75) and meas_fps > 0:
        print(f"  ⚠️  FPS BOTTLENECK DETECTED:")
        print(f"      Target: {target_fps:.1f} FPS ({budget_ms:.1f} ms) | Measured: {meas_fps:.2f} FPS.")
        print(f"      Total frame processing ({proc_ms:.1f} ms) exceeds budget ({budget_ms:.1f} ms).")
        if cap_ms > 15.0:
            print(f"      -> Sensor Wait Latency ({cap_ms:.1f} ms): La webcam è in attesa sincrona V4L2 dei frame fisici.")
        if infer_ms > budget_ms:
            print(f"      -> MediaPipe Inference ({infer_ms:.1f} ms): L'IA supera da sola il budget per frame.")
            if not accel:
                print(f"         SUGGERIMENTO: Attiva 'GPU Dedicata' in Hardware Acceleration per ridurre la latenza da {infer_ms:.1f}ms a ~5ms.")
    elif meas_fps == 0.0:
        print("  ℹ️  In attesa di frame dalla webcam o mocap in pausa.")
    else:
        accel_note = f"su {gpu_name}" if accel else "su CPU XNNPACK"
        print(f"  ✅  Cadenza FPS ottimale: {meas_fps:.2f} FPS su {target_fps:.1f} richiesti.")
        print(f"  ✅  Inferenza MediaPipe stabile a {infer_ms:.2f} ms {accel_note}.")

    print("=" * 70)


def main():
    parser = argparse.ArgumentParser(description="XR Animator Pipeline & Hardware Profiler")
    parser.add_argument("--port", "-p", type=int, default=8000, help="Porta server (default: 8000, con auto-discovery)")
    parser.add_argument("--watch", "-w", type=float, default=0.0, help="Aggiornamento continuo ogni N secondi")
    parser.add_argument("--json", action="store_true", help="Emetti output grezzo JSON dello stato completo")
    args = parser.parse_args()

    port, status = find_server(args.port)

    if args.json:
        full_report = {
            "port": port,
            "status": status,
            "system": {
                "cpu": get_cpu_info(),
                "drm_gpus": get_drm_gpus(),
                "nvidia": get_nvidia_metrics(),
            }
        }
        print(json.dumps(full_report, indent=2))
        return

    if args.watch > 0:
        try:
            while True:
                os.system("clear")
                p, s = find_server(args.port)
                print_profile(p or args.port, s, sample_core_load=False)
                print(f"\n[Watch mode: aggiornamento ogni {args.watch:.1f}s · Premi Ctrl+C per uscire]")
                time.sleep(args.watch)
        except KeyboardInterrupt:
            print("\nProfiler terminato.")
    else:
        print_profile(port or args.port, status, sample_core_load=True)


if __name__ == "__main__":
    main()
