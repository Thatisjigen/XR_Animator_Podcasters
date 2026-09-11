"""XR Animator ONNX mocap backends (server-side).

This package is intentionally self-contained: everything the friend needs to
run an ONNX (RTMPose / RTMW) mocap backend lives inside the repository. No
separate ``pip install`` is required -- the launcher bootstraps the vendored
ONNX Runtime wheels from ``xra_backends/wheels`` on first use.

Modules
-------
runtime   : locate/import onnxruntime, pick the best execution provider
            dynamically (no hardcoded GPU vendor), report capabilities.
registry  : catalogue of downloadable model definitions + on-disk layout.
"""
