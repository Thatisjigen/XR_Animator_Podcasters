#!/usr/bin/env python3
"""XR Animator - Continuous Benchmark & Performance Logger.

Polls http://127.0.0.1:8000/__xra_backend/status and logs time-series
pipeline latency, OS threads, CPU and memory usage to stdout and a JSONL file.

Usage:
    ./.venv311/bin/python scripts/benchmark_logger.py --duration 30 --interval 0.5 --output benchmark_log.jsonl
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime


def fetch_status(port=8000, timeout=1.5):
    try:
        req = urllib.request.urlopen(f"http://127.0.0.1:{port}/__xra_backend/status", timeout=timeout)
        return json.loads(req.read().decode())
    except Exception as exc:
        return {"error": str(exc)}


def get_process_os_threads(pid):
    if not pid:
        return 0, 0.0, 0.0
    try:
        ps_out = subprocess.check_output(
            ["ps", "-T", "-p", str(pid), "-o", "tid,pcpu,comm"], text=True
        )
        lines = ps_out.strip().splitlines()
        drishti_cpu = 0.0
        python_cpu = 0.0
        count = 0
        for line in lines[1:]:
            parts = line.split()
            if len(parts) >= 3:
                count += 1
                pcpu = float(parts[1])
                comm = parts[2]
                if "drishti" in comm:
                    drishti_cpu += pcpu
                else:
                    python_cpu += pcpu
        return count, round(drishti_cpu, 1), round(python_cpu, 1)
    except Exception:
        return 0, 0.0, 0.0


def main():
    parser = argparse.ArgumentParser(description="XR Animator Benchmark Logger")
    parser.add_argument("--duration", type=float, default=20.0, help="Duration in seconds (0 = infinite)")
    parser.add_argument("--interval", type=float, default=0.5, help="Sampling interval in seconds")
    parser.add_argument("--output", type=str, default="benchmark_log.jsonl", help="Output file path (.jsonl)")
    parser.add_argument("--port", type=int, default=8000, help="Backend port")
    args = parser.parse_args()

    print(f"=== XR ANIMATOR BENCHMARK LOGGER ===")
    print(f"Duration: {args.duration if args.duration > 0 else 'Continuous'}s | Interval: {args.interval}s | Output: {args.output}")
    print(f"{'Time':<8} | {'Raw Res':<10} | {'Infer Res':<10} | {'Cap(ms)':<8} | {'Infer(ms)':<9} | {'Proc(ms)':<9} | {'MeasFPS':<8} | {'CPU%':<6} | {'Threads':<7}")
    print("-" * 88)

    start_time = time.time()
    samples = []
    out_file = open(args.output, "a", encoding="utf-8") if args.output else None

    try:
        while True:
            now = time.time()
            elapsed = now - start_time
            if args.duration > 0 and elapsed >= args.duration:
                break

            status = fetch_status(args.port)
            if "error" in status:
                print(f"{elapsed:6.1f}s | ERROR connecting to server: {status['error']}")
                time.sleep(args.interval)
                continue

            cap = status.get("capture", {})
            proc = status.get("process", {})

            pid = proc.get("pid")
            cpu_pct = proc.get("cpu_percent", 0.0)
            rss_mb = proc.get("rss_mb", 0.0)

            os_threads, drishti_cpu, py_cpu = get_process_os_threads(pid)

            infer_ms = cap.get("inference_ema_ms", 0.0)
            last_infer_ms = cap.get("last_infer_ms", 0.0)
            cap_ms = cap.get("last_capture_ms", 0.0)
            proc_ms = cap.get("processing_ema_ms", 0.0)
            eff_fps = float(cap.get("effective_fps", 0.0))
            meas_fps = float(cap.get("measured_fps", 0.0))
            geom_infer = cap.get("inference_geometry", [])
            geom_raw = cap.get("capture_geometry", [])
            misses = cap.get("deadline_misses", 0)
            total_frames = cap.get("frames", 1)

            rec = {
                "timestamp": datetime.now().isoformat(),
                "elapsed_sec": round(elapsed, 2),
                "camera_raw": geom_raw,
                "inference_geom": geom_infer,
                "capture_wait_ms": cap_ms,
                "inference_ema_ms": infer_ms,
                "last_infer_ms": last_infer_ms,
                "processing_ema_ms": proc_ms,
                "measured_fps": meas_fps,
                "effective_fps": eff_fps,
                "deadline_misses": misses,
                "total_frames": total_frames,
                "cpu_percent": cpu_pct,
                "rss_mb": rss_mb,
                "os_threads": os_threads,
                "drishti_cpu": drishti_cpu,
                "python_cpu": py_cpu,
            }
            samples.append(rec)
            if out_file:
                out_file.write(json.dumps(rec) + "\n")
                out_file.flush()

            raw_str = f"{geom_raw[0]}x{geom_raw[1]}" if len(geom_raw) >= 2 else "—"
            inf_str = f"{geom_infer[0]}x{geom_infer[1]}" if len(geom_infer) >= 2 else "—"

            print(f"{elapsed:6.1f}s | {raw_str:<10} | {inf_str:<10} | {cap_ms:8.2f} | {infer_ms:9.2f} | {proc_ms:9.2f} | {meas_fps:8.2f} | {cpu_pct:5.1f}% | {os_threads:3d} ({drishti_cpu:4.0f}d)")

            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nBenchmark interrupted by user.")
    finally:
        if out_file:
            out_file.close()

    if samples:
        avg_infer = sum(s["inference_ema_ms"] for s in samples) / len(samples)
        avg_proc = sum(s["processing_ema_ms"] for s in samples) / len(samples)
        avg_fps = sum(s["measured_fps"] for s in samples) / len(samples)
        avg_cpu = sum(s["cpu_percent"] for s in samples) / len(samples)
        print("\n=== SUMMARY OVER SAMPLES ===")
        print(f"Samples recorded: {len(samples)}")
        print(f"Average Inference EMA: {avg_infer:.2f} ms")
        print(f"Average Total Processing: {avg_proc:.2f} ms")
        print(f"Average Measured FPS: {avg_fps:.2f} FPS")
        print(f"Average CPU: {avg_cpu:.1f}%")
        print(f"Log saved to: {args.output}")


if __name__ == "__main__":
    main()
