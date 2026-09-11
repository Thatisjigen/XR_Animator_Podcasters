# XRA_UNIVERSAL_RUNTIME_V9
#!/usr/bin/env python3
"""One-click launcher for the HTTP version of XR Animator.

The application intentionally stays on http://127.0.0.1 instead of loading the
HTML as a file or a chrome-extension URL. Several XR Animator services and its
custom UI depend on that origin.
"""

from __future__ import annotations

import argparse
import json
import multiprocessing
import os
from pathlib import Path
import subprocess
import threading
import time
import urllib.error
import urllib.request
import webbrowser

from xr_server import Handler, ThreadingHTTPServer


HOST = "127.0.0.1"
DEFAULT_PORT = 8000


def app_url(port: int, chat: bool = False) -> str:
    page = "p2p_chat.html" if chat else "XR_Animator.html"
    return f"http://{HOST}:{port}/{page}"


def is_xr_server(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/__xra_profile", timeout=1.2) as response:
            return response.status == 200 and "application/json" in response.headers.get("Content-Type", "")
    except (OSError, urllib.error.URLError):
        return False


def open_browser_when_ready(port: int, chat: bool) -> None:
    for _ in range(40):
        if is_xr_server(port):
            url = app_url(port, chat)
            root_dir = Path(__file__).resolve().parent
            nw_bin = root_dir / "dist_nwjs" / "nw"
            if nw_bin.exists() and os.access(nw_bin, os.X_OK):
                # Read profile for GPU preference
                gpu_pref = "default"
                prof_file = root_dir / "xra_profile.json"
                if prof_file.exists():
                    try:
                        with open(prof_file, "r", encoding="utf-8") as f:
                            pdata = json.load(f)
                            gpu_pref = pdata.get("custom", {}).get("performance", {}).get("gpu_preference", "default")
                    except Exception:
                        pass

                env = os.environ.copy()
                nw_cmd = [
                    str(nw_bin),
                    f"--url={url}",
                    "--enable-webaudio-input",
                    "--auto-accept-camera-and-microphone-capture",
                    "--autoplay-policy=no-user-gesture-required",
                ]

                if gpu_pref == "high-performance":
                    print("[XRA] Avvio runtime NW.js con GPU Dedicata (NVIDIA RTX Offload)")
                    env["__NV_PRIME_RENDER_OFFLOAD"] = "1"
                    env["__GLX_VENDOR_LIBRARY_NAME"] = "nvidia"
                    env["__VK_LAYER_NV_optimus"] = "NVIDIA_only"
                    nw_cmd.extend(["--ignore-gpu-blocklist", "--enable-gpu-rasterization"])
                else:
                    print(f"[XRA] Avvio runtime NW.js con GPU di Sistema / Integrata ({gpu_pref})")
                    env["DRI_PRIME"] = "0"
                    env.pop("__NV_PRIME_RENDER_OFFLOAD", None)
                    env.pop("__GLX_VENDOR_LIBRARY_NAME", None)
                    env.pop("__VK_LAYER_NV_optimus", None)

                try:
                    subprocess.Popen(nw_cmd, cwd=str(root_dir / "dist_nwjs"), env=env)
                    return
                except Exception as e:
                    print(f"[XRA] Avvio NW.js fallito ({e}), fallback su browser predefinito.")

            webbrowser.open(url, new=2)
            return
        time.sleep(0.1)
    print("[XRA] Il server non ha risposto in tempo; apri manualmente:")
    print(app_url(port, chat))


def find_available_port(host: str, preferred: int = DEFAULT_PORT) -> int:
    import socket
    for port in [preferred, *range(preferred + 1, preferred + 50)]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Avvia XR Animator sul suo server HTTP locale")
    parser.add_argument("--port", type=int, default=None, help="porta locale (default: 8000 con fallback su porta libera)")
    parser.add_argument("--no-browser", action="store_true", help="avvia soltanto il server")
    parser.add_argument("--chat", action="store_true", help="apri direttamente Studio Link")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    explicit_port = args.port is not None
    port = args.port or DEFAULT_PORT

    if not 1 <= port <= 65535:
        raise SystemExit("La porta deve essere compresa tra 1 e 65535")

    if is_xr_server(port):
        url = app_url(port, args.chat)
        print(f"[XRA] Server già attivo: {url}")
        if not args.no_browser:
            webbrowser.open(url, new=2)
        return 0

    server = None
    try:
        server = ThreadingHTTPServer((HOST, port), Handler)
    except OSError as error:
        if explicit_port:
            print(f"[XRA] Impossibile usare http://{HOST}:{port}: {error}")
            print("[XRA] Scegli un'altra porta con --port NUMERO")
            return 2
        port = find_available_port(HOST, DEFAULT_PORT + 1)
        try:
            server = ThreadingHTTPServer((HOST, port), Handler)
            print(f"[XRA] Porta 8000 occupata: utilizzo porta libera {port}")
        except OSError as fallback_error:
            print(f"[XRA] Impossibile avviare il server locale su alcuna porta: {fallback_error}")
            return 2

    server.daemon_threads = True
    url = app_url(port, args.chat)
    print("XR Animator · launcher locale")
    print(url)
    print("Premi Ctrl+C per arrestare il server.")

    if not args.no_browser:
        threading.Thread(target=open_browser_when_ready, args=(port, args.chat), daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[XRA] Arresto server…")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    multiprocessing.freeze_support()
    raise SystemExit(main())
