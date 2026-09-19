import os
import sys
import time
import statistics
import numpy as np
import cv2

# Set path
sys.path.insert(0, os.path.abspath("."))

from xra_backends.engine import ENGINE
from xra_backends import registry

def generate_test_frames(count=80, width=640, height=360):
    frames = []
    for i in range(count):
        img = np.zeros((height, width, 3), dtype=np.uint8)
        color = (i * 4) % 255
        img[:, :] = (color, (color + 80) % 255, 200)
        center_x = int(width / 2 + np.sin(i * 0.1) * 50)
        center_y = int(height / 3 + np.cos(i * 0.1) * 20)
        cv2.circle(img, (center_x, center_y), 45, (230, 180, 150), -1)
        cv2.rectangle(img, (center_x - 60, center_y + 50), (center_x + 60, height - 20), (50, 80, 180), -1)
        frames.append(img)
    return frames

def benchmark_affinity(name, cpu_set, frames, warmup=15):
    all_cpus = set(range(os.cpu_count()))
    if cpu_set is not None:
        os.sched_setaffinity(0, set(cpu_set))
    else:
        os.sched_setaffinity(0, all_cpus)
    
    current_affinity = sorted(os.sched_getaffinity(0))
    ENGINE.load(registry.MEDIAPIPE_TASKS_ID, force=True)
    
    for i in range(warmup):
        ENGINE.infer(frames[i % len(frames)])
        
    durations = []
    for frame in frames:
        t0 = time.perf_counter()
        ENGINE.infer(frame)
        durations.append((time.perf_counter() - t0) * 1000.0)
        
    mean_lat = statistics.mean(durations)
    median_lat = statistics.median(durations)
    std_lat = statistics.stdev(durations) if len(durations) > 1 else 0.0
    min_lat = min(durations)
    max_lat = max(durations)
    p95_lat = np.percentile(durations, 95)
    p99_lat = np.percentile(durations, 99)
    miss_30fps = sum(d > 33.3 for d in durations)
    miss_15fps = sum(d > 66.7 for d in durations)
    
    return {
        "name": name,
        "affinity": current_affinity,
        "count": len(durations),
        "mean": mean_lat,
        "median": median_lat,
        "std": std_lat,
        "min": min_lat,
        "max": max_lat,
        "p95": p95_lat,
        "p99": p99_lat,
        "miss_30fps": miss_30fps,
        "miss_15fps": miss_15fps,
    }

def main():
    print("==================================================")
    print("  XR Animator: CPU Affinity Benchmark Suite")
    print("==================================================")
    all_online = sorted(os.sched_getaffinity(0))
    print(f"Total logical CPUs online: {len(all_online)}")
    
    frames = generate_test_frames(count=100, width=640, height=360)
    print(f"Generated {len(frames)} benchmark frames at 640x360.\n")
    
    configs = [
        ("1. Default OS Scheduling (All 20 CPUs)", None),
        ("2. Physical Cores (P-cores primary + E-cores)", [0, 2, 4, 6, 8, 10, 12, 13, 14, 15, 16, 17, 18, 19]),
        ("3. P-Cores Only (6 High-Performance Cores)", [0, 2, 4, 6, 8, 10]),
        ("4. Top 4 P-Cores (Turbo cores 5.2-5.4 GHz)", [0, 2, 4, 6]),
        ("5. E-Cores Only (8 Efficiency Cores 4.1 GHz)", [12, 13, 14, 15, 16, 17, 18, 19]),
    ]
    
    results = []
    for name, cpu_set in configs:
        print(f"Testing: {name} ...", flush=True)
        res = benchmark_affinity(name, cpu_set, frames)
        results.append(res)
        print(f"  -> Mean: {res['mean']:.2f}ms | Median: {res['median']:.2f}ms | Jitter(Std): {res['std']:.2f}ms | P95: {res['p95']:.2f}ms | Max: {res['max']:.2f}ms", flush=True)
        time.sleep(0.3)
        
    print("\n" + "="*95)
    print(f"{'Configurazione':<44} | {'Media':<9} | {'Mediana':<8} | {'Jitter (Std)':<12} | {'P95':<8} | {'Max':<8}")
    print("="*95)
    for r in results:
        print(f"{r['name']:<44} | {r['mean']:>6.2f} ms | {r['median']:>5.2f} ms | {r['std']:>10.2f} ms | {r['p95']:>5.2f} ms | {r['max']:>5.2f} ms")
    print("="*95)
    
    os.sched_setaffinity(0, set(all_online))
    print("\nRipristinata affinity default di sistema.")

if __name__ == "__main__":
    main()
