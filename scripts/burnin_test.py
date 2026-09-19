#!/usr/bin/env python3
"""XR Animator - 20/30 Minute Long-Run Stability & Burn-In Benchmark.

Monitors CPU, RAM leak rate, GPU/CPU temperatures, and frame delivery over time.
Usage:
  python3 scripts/burnin_test.py [--minutes 20] [--interval 5] [--output scripts/burnin_report.json]
"""

import argparse
import datetime
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen


def get_cpu_temp() -> float | None:
    thermal_dir = Path("/sys/class/thermal")
    if thermal_dir.exists():
        for zone in sorted(thermal_dir.glob("thermal_zone*")):
            type_file = zone / "type"
            temp_file = zone / "temp"
            if type_file.exists() and temp_file.exists():
                try:
                    ztype = type_file.read_text().strip().lower()
                    if any(t in ztype for t in ("x86_pkg_temp", "core", "cpu")):
                        raw = float(temp_file.read_text().strip())
                        return raw / 1000.0 if raw > 1000 else raw
                except Exception:
                    pass
        z0 = thermal_dir / "thermal_zone0" / "temp"
        if z0.exists():
            try:
                raw = float(z0.read_text().strip())
                return raw / 1000.0 if raw > 1000 else raw
            except Exception:
                pass
    return None


def get_nvidia_gpu() -> dict:
    try:
        res = subprocess.run(
            ["nvidia-smi", "--query-gpu=temperature.gpu,power.draw,utilization.gpu,memory.used",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=2
        )
        if res.returncode == 0 and res.stdout.strip():
            parts = [p.strip() for p in res.stdout.strip().split(",")]
            return {
                "temp_c": float(parts[0]) if len(parts) > 0 else None,
                "power_w": float(parts[1]) if len(parts) > 1 else None,
                "util_pct": float(parts[2]) if len(parts) > 2 else None,
                "mem_mb": float(parts[3]) if len(parts) > 3 else None,
            }
    except Exception:
        pass
    return {}


def get_process_metrics() -> dict:
    metrics = {"server": None, "browser": None, "gpu": None}
    try:
        output = subprocess.check_output(
            ["ps", "-eo", "pid,pcpu,rss,comm,args"],
            text=True
        )
        for line in output.strip().splitlines()[1:]:
            parts = line.strip().split(None, 4)
            if len(parts) < 5:
                continue
            pid, pcpu, rss, comm, args = parts
            pid = int(pid)
            cpu = float(pcpu.replace(",", "."))
            rss_mb = float(rss) / 1024.0

            if "xra_server" in comm or "xr_server.py" in args:
                if metrics["server"] is None or cpu > metrics["server"]["cpu"]:
                    metrics["server"] = {"pid": pid, "cpu": cpu, "ram_mb": rss_mb}
            elif "xra_browser" in comm or "nw" in comm or "XR_Animator" in comm:
                if "--type=gpu-process" in args:
                    metrics["gpu"] = {"pid": pid, "cpu": cpu, "ram_mb": rss_mb}
                elif "--type=" not in args:
                    if metrics["browser"] is None or rss_mb > metrics["browser"]["ram_mb"]:
                        metrics["browser"] = {"pid": pid, "cpu": cpu, "ram_mb": rss_mb}
    except Exception:
        pass
    return metrics


def get_backend_status() -> dict:
    try:
        with urlopen("http://127.0.0.1:8000/__xra_backend/status", timeout=2) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return {}


def main():
    parser = argparse.ArgumentParser(description="XR Animator Burn-In & Stability Monitor")
    parser.add_argument("--minutes", type=float, default=20.0, help="Test duration in minutes (default: 20)")
    parser.add_argument("--interval", type=float, default=5.0, help="Sampling interval in seconds (default: 5)")
    parser.add_argument("--output", type=str, default="scripts/burnin_report.json", help="Report JSON output path")
    args = parser.parse_args()

    total_seconds = int(args.minutes * 60)
    samples = []
    start_time = time.time()
    end_time = start_time + total_seconds

    print("=" * 70)
    print(f"XR ANIMATOR LONG-RUN STABILITY BENCHMARK ({args.minutes:.0f} MIN)")
    print(f"Sampling every {args.interval}s · Target duration: {args.minutes:.1f} minutes")
    print("=" * 70)

    try:
        sample_idx = 0
        while time.time() < end_time:
            now = time.time()
            elapsed = now - start_time
            procs = get_process_metrics()
            status = get_backend_status()
            cap = status.get("capture") or {}
            active_engine = status.get("active") or {}

            cpu_temp = get_cpu_temp()
            gpu_info = get_nvidia_gpu()

            sample = {
                "elapsed_s": round(elapsed, 1),
                "timestamp": datetime.datetime.now().isoformat(),
                "server_cpu": procs["server"]["cpu"] if procs["server"] else 0.0,
                "server_ram_mb": procs["server"]["ram_mb"] if procs["server"] else 0.0,
                "browser_cpu": procs["browser"]["cpu"] if procs["browser"] else 0.0,
                "browser_ram_mb": procs["browser"]["ram_mb"] if procs["browser"] else 0.0,
                "gpu_cpu": procs["gpu"]["cpu"] if procs["gpu"] else 0.0,
                "gpu_ram_mb": procs["gpu"]["ram_mb"] if procs["gpu"] else 0.0,
                "infer_ms": cap.get("last_infer_ms", 0.0),
                "measured_fps": cap.get("measured_fps", 0.0),
                "effective_fps": cap.get("effective_fps", 0.0),
                "target_fps": cap.get("target_fps", 0.0),
                "mode": active_engine.get("mode", "unknown"),
                "cpu_temp_c": cpu_temp,
                "gpu_temp_c": gpu_info.get("temp_c"),
                "gpu_power_w": gpu_info.get("power_w"),
            }
            samples.append(sample)
            sample_idx += 1

            remaining = max(0, int(end_time - now))
            rem_m, rem_s = divmod(remaining, 60)
            cpu_t_str = f"{cpu_temp:.0f}C" if cpu_temp else "N/A"
            gpu_t_str = f"{gpu_info.get('temp_c'):.0f}C" if gpu_info.get('temp_c') else "N/A"
            fps_str = f"{sample['measured_fps']:.1f}" if sample["measured_fps"] else "--"

            sys.stdout.write(
                f"\r[{rem_m:02d}:{rem_s:02d}] "
                f"Mode: {sample['mode'].upper():<8} | "
                f"FPS: {fps_str:>4} | "
                f"Infer: {sample['infer_ms']:>4.1f}ms | "
                f"RAM Server: {sample['server_ram_mb']:>5.0f}MB, Browser: {sample['browser_ram_mb']:>5.0f}MB | "
                f"Temp CPU: {cpu_t_str}, GPU: {gpu_t_str}    "
            )
            sys.stdout.flush()

            time.sleep(args.interval)

    except KeyboardInterrupt:
        print("\n\nBenchmark interrotto manualmente dall'utente.")

    total_elapsed = time.time() - start_time
    print("\n\n" + "=" * 70)
    print("REPORT FINALE DI STABILITA & CONSUMI")
    print("=" * 70)

    if not samples:
        print("Nessun dato campionato.")
        return

    first_10 = samples[:max(1, len(samples) // 5)]
    last_10 = samples[-max(1, len(samples) // 5):]

    ram_srv_init = sum(s["server_ram_mb"] for s in first_10) / len(first_10)
    ram_srv_final = sum(s["server_ram_mb"] for s in last_10) / len(last_10)
    ram_srv_delta = ram_srv_final - ram_srv_init

    ram_brw_init = sum(s["browser_ram_mb"] for s in first_10) / len(first_10)
    ram_brw_final = sum(s["browser_ram_mb"] for s in last_10) / len(last_10)
    ram_brw_delta = ram_brw_final - ram_brw_init

    avg_fps = sum(s["measured_fps"] for s in samples if s["measured_fps"] > 0) / max(1, sum(1 for s in samples if s["measured_fps"] > 0))
    avg_infer = sum(s["infer_ms"] for s in samples if s["infer_ms"] > 0) / max(1, sum(1 for s in samples if s["infer_ms"] > 0))

    cpu_temps = [s["cpu_temp_c"] for s in samples if s["cpu_temp_c"] is not None]
    max_cpu_t = max(cpu_temps) if cpu_temps else None
    avg_cpu_t = (sum(cpu_temps) / len(cpu_temps)) if cpu_temps else None

    gpu_temps = [s["gpu_temp_c"] for s in samples if s["gpu_temp_c"] is not None]
    max_gpu_t = max(gpu_temps) if gpu_temps else None
    avg_gpu_t = (sum(gpu_temps) / len(gpu_temps)) if gpu_temps else None

    print(f"Durata monitorata:       {total_elapsed / 60:.1f} minuti ({len(samples)} campioni)")
    print(f"Cadenza FPS media:       {avg_fps:.1f} FPS (tempo inferenza medio: {avg_infer:.1f} ms)")
    print(f"RAM Server Python:       Iniziale: {ram_srv_init:.0f} MB -> Finale: {ram_srv_final:.0f} MB (Delta: {ram_srv_delta:+.1f} MB)")
    print(f"RAM Browser Chromium:    Iniziale: {ram_brw_init:.0f} MB -> Finale: {ram_brw_final:.0f} MB (Delta: {ram_brw_delta:+.1f} MB)")
    if avg_cpu_t:
        print(f"Temperatura CPU (Media): {avg_cpu_t:.1f}C (Picco: {max_cpu_t:.1f}C)")
    if avg_gpu_t:
        print(f"Temperatura GPU (Media): {avg_gpu_t:.1f}C (Picco: {max_gpu_t:.1f}C)")

    print("-" * 70)
    leaks = []
    if ram_srv_delta > 100.0:
        leaks.append(f"Possibile leak memoria Server (+{ram_srv_delta:.0f} MB)")
    if ram_brw_delta > 150.0:
        leaks.append(f"Possibile leak memoria Browser (+{ram_brw_delta:.0f} MB)")

    if not leaks:
        print("STABILITA MEMORIA: PERFETTA. Nessun memory leak rilevato nel tempo.")
    else:
        print("AVVISO MEMORIA:", ", ".join(leaks))

    if max_cpu_t and max_cpu_t < 75.0:
        print("TEMPERATURE CPU: OTTIME (Sotto 75C, nessun throttling).")
    elif max_cpu_t and max_cpu_t < 85.0:
        print("TEMPERATURE CPU: NORMALI per laptop con i9.")
    elif max_cpu_t:
        print("TEMPERATURE CPU ELEVATE (Consigliato limitare render FPS o usare modalita Face).")

    print("=" * 70)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "duration_minutes": round(total_elapsed / 60, 2),
        "total_samples": len(samples),
        "avg_fps": round(avg_fps, 2),
        "avg_infer_ms": round(avg_infer, 2),
        "ram_server": {"init_mb": round(ram_srv_init, 1), "final_mb": round(ram_srv_final, 1), "delta_mb": round(ram_srv_delta, 1)},
        "ram_browser": {"init_mb": round(ram_brw_init, 1), "final_mb": round(ram_brw_final, 1), "delta_mb": round(ram_brw_delta, 1)},
        "cpu_temp": {"avg": round(avg_cpu_t, 1) if avg_cpu_t else None, "max": max_cpu_t},
        "gpu_temp": {"avg": round(avg_gpu_t, 1) if avg_gpu_t else None, "max": max_gpu_t},
    }
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Report completo salvato in: {out_path.resolve()}")


if __name__ == "__main__":
    main()
