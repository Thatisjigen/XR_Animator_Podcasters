#!/usr/bin/env python3
"""
Automated Test Suite for XR Animator Motion Scenarios:
1. Desk Occlusion: Hand dropped under desk -> decays to rest after 180ms, wrist anchored to live elbow.
2. Active Arm Tracking: Upper arm raised or lateral -> maintains arm position and wrist tracks elbow displacement.
3. Camera Exit: Empty room / chair hallucination without face -> rejected with reason 'no_human_subject' and empty: True.
4. Camera Re-entry: User returns -> immediate reacquisition on frame 1.
5. Processing Performance: Stabilizer and wire transformation latency benchmark (<5ms).
"""

import os
import sys
import time
import unittest

# Add project root to sys.path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from xra_backends.capture import CaptureSource
from xra_backends.engine import to_wire, ENGINE


def make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(305.0, 230.0), wrist_xy=(310.0, 310.0), wrist_score=0.85):
    """Generate 33 BlazePose dummy keypoints with customizable arm configuration."""
    kps = []
    for i in range(33):
        kps.append({
            "x": 300.0, "y": 200.0, "z": 0.0,
            "score": 0.75, "visibility": 0.75,
            "position": {"x": 300.0, "y": 200.0, "z": 0.0}
        })
    # Left shoulder (11), Right shoulder (12)
    kps[11]["position"] = {"x": 260.0, "y": shoulder_y, "z": 0.0}
    kps[11]["x"] = 260.0; kps[11]["y"] = shoulder_y
    kps[12]["position"] = {"x": 340.0, "y": shoulder_y, "z": 0.0}
    kps[12]["x"] = 340.0; kps[12]["y"] = shoulder_y

    # Right elbow (14) & wrist (16)
    kps[14]["position"] = {"x": elbow_xy[0], "y": elbow_xy[1], "z": 0.0}
    kps[14]["x"] = elbow_xy[0]; kps[14]["y"] = elbow_xy[1]
    kps[14]["score"] = 0.80; kps[14]["visibility"] = 0.80

    kps[16]["position"] = {"x": wrist_xy[0], "y": wrist_xy[1], "z": 0.0}
    kps[16]["x"] = wrist_xy[0]; kps[16]["y"] = wrist_xy[1]
    kps[16]["score"] = wrist_score; kps[16]["visibility"] = wrist_score

    # Hips (23, 24)
    kps[23]["position"] = {"x": 270.0, "y": 320.0, "z": 0.0}
    kps[23]["x"] = 270.0; kps[23]["y"] = 320.0
    kps[24]["position"] = {"x": 330.0, "y": 320.0, "z": 0.0}
    kps[24]["x"] = 330.0; kps[24]["y"] = 320.0

    return kps


class TestMotionScenarios(unittest.TestCase):

    def setUp(self):
        self.engine = CaptureSource()
        self.engine._reset_landmark_stabilizer("test_model")
        ENGINE._arm_active_state = {15: False, 16: False}
        ENGINE._arm_down_frames = {15: 0, 16: 0}

    def test_01_desk_occlusion_decay(self):
        """Scenario 1: Hand dropped under desk -> decays naturally to rest without freezing."""
        print("\n--- Test 1: Desk Occlusion & Natural Decay ---")
        # Frame 0: User seated, arm down, hand visible
        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 230.0), wrist_xy=(350.0, 310.0), wrist_score=0.85)
        payload = {"keypoints": kps, "keypoints3D": [dict(p) for p in kps]}
        out = self.engine._stabilize_payload(payload, 640, 360)
        self.assertGreaterEqual(out["keypoints"][16]["score"], 0.40, "Initial valid wrist must be accepted")

        # Now wrist goes under the desk (score drops to 0.05)
        # Frame 1: 50ms later (within 180ms grace period)
        time.sleep(0.05)
        kps_under = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 230.0), wrist_xy=(350.0, 310.0), wrist_score=0.05)
        payload1 = {"keypoints": kps_under, "keypoints3D": [dict(p) for p in kps_under]}
        out1 = self.engine._stabilize_payload(payload1, 640, 360)
        self.assertAlmostEqual(out1["keypoints"][16]["score"], 0.08, delta=0.01,
                               msg="Within 180ms grace period, score should be transient hold 0.08")

        # Frame 2: after 200ms of occlusion (> 180ms grace period)
        time.sleep(0.20)
        kps_under2 = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 230.0), wrist_xy=(350.0, 310.0), wrist_score=0.05)
        payload2 = {"keypoints": kps_under2, "keypoints3D": [dict(p) for p in kps_under2]}
        out2 = self.engine._stabilize_payload(payload2, 640, 360)

        wrist_out = out2["keypoints"][16]
        elbow_out = out2["keypoints"][14]

        # Assertions
        self.assertEqual(wrist_out["score"], 0.0, "Wrist score must decay to 0.0 (rest pose), NOT stay held at 0.50!")
        self.assertGreaterEqual(elbow_out["score"], 0.70, "Live elbow must continue being tracked live!")
        self.assertGreater(wrist_out["position"]["y"], elbow_out["position"]["y"],
                           "Wrist must be projected downward from live elbow into lap/under desk")
        print("  ✓ Decayed to score=0.0 after grace period")
        print("  ✓ Elbow remains live and tracked at (%.1f, %.1f)" % (elbow_out["x"], elbow_out["y"]))
        print("  ✓ Wrist anchored naturally downward from live elbow at (%.1f, %.1f)" % (wrist_out["x"], wrist_out["y"]))

    def test_02_upper_arm_active_tracking(self):
        """Scenario 2: Upper arm pointing up or lateral -> maintains arm position and tracks elbow movement."""
        print("\n--- Test 2: Active Upper Arm & Forearm Follow ---")
        # Shoulder at (340, 200). Elbow raised/lateral at (420, 160) -> dx=+80, dy=-40 (pointing up and right!)
        # Wrist at (460, 130) -> rel offset to elbow is dx=+40, dy=-30.
        kps = make_dummy_keypoints(shoulder_y=200.0, elbow_xy=(420.0, 160.0), wrist_xy=(460.0, 130.0), wrist_score=0.88)
        payload = {"keypoints": kps, "keypoints3D": [dict(p) for p in kps]}
        self.engine._stabilize_payload(payload, 640, 360)

        # Now wrist is occluded behind microphone (score drops to 0.05)
        # User moves elbow up and right by (+25, -20) -> new elbow at (445.0, 140.0)
        time.sleep(0.05)
        kps_mv1 = make_dummy_keypoints(shoulder_y=200.0, elbow_xy=(445.0, 140.0), wrist_xy=(0.0, 0.0), wrist_score=0.05)
        payload_mv1 = {"keypoints": kps_mv1, "keypoints3D": [dict(p) for p in kps_mv1]}
        out_mv1 = self.engine._stabilize_payload(payload_mv1, 640, 360)

        w1 = out_mv1["keypoints"][16]
        # Expected wrist: elbow(445, 140) + offset(40, -30) = (485, 110)
        self.assertEqual(w1["score"], 0.55, "Arm is active: wrist must NOT be put to rest, score must be 0.55!")
        self.assertAlmostEqual(w1["x"], 485.0, delta=2.0, msg="Wrist X must dynamically follow elbow displacement!")
        self.assertAlmostEqual(w1["y"], 110.0, delta=2.0, msg="Wrist Y must dynamically follow elbow displacement!")
        print("  ✓ Step 1: Elbow moved to (445, 140) -> Wrist dynamically followed to (%.1f, %.1f) with score=0.55" % (w1["x"], w1["y"]))

        # Even after 250ms (beyond standard rest grace period), arm must STILL be kept in position because upper arm is active!
        time.sleep(0.25)
        kps_mv2 = make_dummy_keypoints(shoulder_y=200.0, elbow_xy=(410.0, 175.0), wrist_xy=(0.0, 0.0), wrist_score=0.05)
        payload_mv2 = {"keypoints": kps_mv2, "keypoints3D": [dict(p) for p in kps_mv2]}
        out_mv2 = self.engine._stabilize_payload(payload_mv2, 640, 360)

        w2 = out_mv2["keypoints"][16]
        # Expected wrist: elbow(410, 175) + offset(40, -30) = (450, 145)
        self.assertEqual(w2["score"], 0.55, "Upper arm active: wrist must NEVER snap to rest even after 250ms!")
        self.assertAlmostEqual(w2["x"], 450.0, delta=2.0, msg="Wrist X must continue tracking elbow!")
        self.assertAlmostEqual(w2["y"], 145.0, delta=2.0, msg="Wrist Y must continue tracking elbow!")
        print("  ✓ Step 2: After 300ms, elbow moved to (410, 175) -> Wrist followed to (%.1f, %.1f) without dropping to rest" % (w2["x"], w2["y"]))

    def test_03_camera_exit_anti_background(self):
        """Scenario 3: Empty room / chair hallucination without face -> rejected as no_human_subject."""
        print("\n--- Test 3: Camera Exit (Empty Chair / Anti-Background) ---")
        # Weak hallucinated skeleton on chair back:
        # No face, low shoulder score (0.30), small shoulder span (45px on 640w = 0.07 norm)
        kps = []
        for i in range(33):
            kps.append({"x": 300.0, "y": 200.0, "z": 0.0, "score": 0.30, "position": {"x": 300.0, "y": 200.0, "z": 0.0}})
        # Shoulders
        kps[11]["x"] = 280.0; kps[11]["y"] = 150.0; kps[11]["score"] = 0.32
        kps[12]["x"] = 320.0; kps[12]["y"] = 150.0; kps[12]["score"] = 0.35

        payload = {
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "face": None, # No face in camera!
            "leftHand": None,
            "rightHand": None,
        }

        wire = to_wire(payload, capture_hint=(640, 360))
        self.assertTrue(wire["empty"], "Wireframe must be flagged as empty when user left the camera!")
        self.assertEqual(wire["geometry"]["reason"], "no_human_subject",
                         "Geometry reason must be 'no_human_subject' to reject chair/background!")
        self.assertEqual(len(wire["keypoints"]), 0, "Keypoints must be cleared on exit!")
        self.assertEqual(len(wire["keypoints3D"]), 0, "Keypoints3D must be cleared on exit!")
        print("  ✓ Camera exit detected: empty=True, reason='no_human_subject', 0 phantom keypoints sent")

    def test_04_camera_reentry_instant_reacquisition(self):
        """Scenario 4: User sits back down -> immediate frame-1 reacquisition."""
        print("\n--- Test 4: Camera Re-entry (Instant Reacquisition) ---")
        # Real user returns: face detected, clear body
        kps = make_dummy_keypoints(shoulder_y=140.0, elbow_xy=(345.0, 220.0), wrist_xy=(350.0, 300.0), wrist_score=0.85)
        face = {
            "landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0, "score": 0.95}],
            "blendshapes": {"native": {"jawOpen": 0.1}}
        }
        payload = {
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "face": face,
            "leftHand": None,
            "rightHand": None,
        }

        wire = to_wire(payload, capture_hint=(640, 360))
        self.assertFalse(wire["empty"], "Wire must NOT be empty when user re-enters!")
        self.assertTrue(wire["geometry"]["valid"], "Geometry must be valid immediately on re-entry!")
        self.assertIn(wire["geometry"]["reason"], {"ok", "upper_body_only"}, "Reason must be valid immediately!")
        self.assertEqual(len(wire["keypoints"]), 33, "All 33 keypoints must be tracked immediately on frame 1!")
        print("  ✓ Re-entry verified: empty=False, reason='%s', all 33 keypoints live" % wire["geometry"]["reason"])

    def test_05_processing_latency_benchmark(self):
        """Scenario 5: Stabilizer and wire transformation latency benchmark (<5ms)."""
        print("\n--- Test 5: Pipeline Latency Benchmark (<5ms budget) ---")
        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 230.0), wrist_xy=(350.0, 310.0), wrist_score=0.85)
        payload = {
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]},
            "leftHand": None,
            "rightHand": None,
        }

        # Warmup
        for _ in range(10):
            out = self.engine._stabilize_payload(payload, 640, 360)
            _ = to_wire(out, capture_hint=(640, 360))

        # Benchmark 100 frames
        n_iters = 100
        start = time.perf_counter()
        for _ in range(n_iters):
            out = self.engine._stabilize_payload(payload, 640, 360)
            _ = to_wire(out, capture_hint=(640, 360))
        total_time = time.perf_counter() - start
        avg_ms = (total_time / n_iters) * 1000.0

        print("  ✓ Average Python pipeline latency: %.2f ms / frame (Budget: < 5.0 ms)" % avg_ms)
        self.assertLess(avg_ms, 5.0, "Stabilize + to_wire latency must be under 5.0 ms!")


    def test_06_raised_arm_wire_preservation(self):
        """Scenario 6: Arm raised high (elbow above shoulder) with hand invisible (fist/occluded) ->
        engine.py desk_wrist_guard must NOT suppress the wrist; score must remain above 0."""
        print("\n--- Test 6: Raised Arm Without MediaPipe Hands (Wrist Preservation) ---")
        # Shoulder at y=150, left elbow raised to y=100 (dy_se = 100-150 = -50, i.e. elbow above shoulder)
        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 230.0), wrist_xy=(350.0, 310.0), wrist_score=0.85)
        # Overwrite left shoulder(11), left elbow(13), left wrist(15) for the raised-arm scenario
        kps[11]["x"] = 260.0; kps[11]["y"] = 150.0
        kps[11]["position"] = {"x": 260.0, "y": 150.0, "z": 0.0}
        kps[11]["score"] = 0.85
        kps[13]["x"] = 260.0; kps[13]["y"] = 100.0
        kps[13]["position"] = {"x": 260.0, "y": 100.0, "z": 0.0}
        kps[13]["score"] = 0.80; kps[13]["visibility"] = 0.80
        # Wrist weak — MediaPipe hand not detected (fist/occluded), below desk_thresh=0.45
        kps[15]["x"] = 260.0; kps[15]["y"] = 50.0
        kps[15]["position"] = {"x": 260.0, "y": 50.0, "z": 0.0}
        kps[15]["score"] = 0.32; kps[15]["visibility"] = 0.32

        payload = {
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0, "score": 0.95}]},
            "leftHand": [],   # No hand detected — fist or occluded
            "rightHand": None,
        }

        wire = to_wire(payload, capture_hint=(640, 360))
        left_wrist = wire["keypoints"][15] if len(wire["keypoints"]) > 15 else None
        self.assertIsNotNone(left_wrist, "Keypoint 15 must exist in output")
        # desk_wrist_guard MUST skip suppression because arm is raised (elbow above shoulder)
        self.assertGreater(left_wrist.get("score", 0.0), 0.0,
                           "Raised arm wrist must NOT be suppressed by desk_wrist_guard even when hand is absent!")
        print("  ✓ Raised arm wrist preserved: score=%.3f (not suppressed to 0)" % left_wrist.get("score", 0.0))

    def test_07_hands_touching_acceptance(self):
        """Scenario 7: Both hands visible in front of body, fingers overlapping ->
        capture.py must not drop the hand due to reduced landmark confidence."""
        print("\n--- Test 7: Touching Hands Acceptance (Relaxed Thresholds) ---")
        engine = CaptureSource()
        engine._reset_landmark_stabilizer("test_model_07")

        def make_hand(wrist_score, median_score, n=21):
            """Simulate partially-overlapping hand: median confidence drops."""
            pts = []
            for i in range(n):
                s = wrist_score if i == 0 else median_score
                pts.append({"x": 300.0 + i, "y": 260.0, "z": 0.0, "score": s, "visibility": s,
                            "position": {"x": 300.0 + i, "y": 260.0, "z": 0.0}})
            return pts

        # Build keypoints with both wrists live
        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 200.0), wrist_xy=(350.0, 260.0), wrist_score=0.85)
        kps[11]["score"] = 0.85; kps[11]["y"] = 150.0
        kps[13]["x"] = 255.0; kps[13]["y"] = 200.0
        kps[13]["position"] = {"x": 255.0, "y": 200.0, "z": 0.0}
        kps[13]["score"] = 0.80
        kps[15]["x"] = 250.0; kps[15]["y"] = 260.0
        kps[15]["position"] = {"x": 250.0, "y": 260.0, "z": 0.0}
        kps[15]["score"] = 0.85; kps[15]["visibility"] = 0.85

        healthy_hand = make_hand(wrist_score=0.85, median_score=0.75)
        payload_warm = {
            "keypoints": [dict(p) for p in kps],
            "keypoints3D": [dict(p) for p in kps],
            "leftHand": healthy_hand[:],
            "rightHand": healthy_hand[:],
        }
        engine._stabilize_payload(payload_warm, 640, 360)

        # Now simulate touching: finger confidence drops to ~0.22 (below old 0.35 threshold, above new 0.18)
        touching_hand = make_hand(wrist_score=0.55, median_score=0.22)
        payload_touch = {
            "keypoints": [dict(p) for p in kps],
            "keypoints3D": [dict(p) for p in kps],
            "leftHand": touching_hand[:],
            "rightHand": touching_hand[:],
        }
        out = engine._stabilize_payload(payload_touch, 640, 360)

        lh = out.get("leftHand") or []
        rh = out.get("rightHand") or []
        self.assertEqual(len(lh), 21, "Left hand must remain live when touching (relaxed threshold=0.18 with wrist live)")
        self.assertEqual(len(rh), 21, "Right hand must remain live when touching (relaxed threshold=0.18 with wrist live)")
        lh_scores = [p.get("score", 0) for p in lh]
        self.assertGreater(min(lh_scores), 0.0, "All left hand landmark scores must be > 0 during touch")
        print("  ✓ Both hands accepted during touch: leftHand=%d pts, rightHand=%d pts, min_score=%.3f" % (
            len(lh), len(rh), min(lh_scores)))

    def test_08_runtime_resolution_and_infer_mode_switch(self):
        """Scenario 8: Runtime resolution and infer_mode changes ->
        engine reloads cleanly without crashing, freezing, or returning None."""
        print("\n--- Test 8: Runtime Resolution & Infer Mode Switch ---")
        import numpy as np
        from xra_backends.engine import ENGINE
        from xra_backends import registry

        res = ENGINE.load(registry.MEDIAPIPE_TASKS_ID, force=True)
        if not ENGINE.ready:
            self.skipTest(f"MediaPipe tasks unavailable in test environment: {res.get('error')}")

        # Frame 1: 640x360
        f1 = np.zeros((360, 640, 3), dtype=np.uint8)
        out1 = ENGINE.infer(f1)
        self.assertIsNotNone(out1, "Inference on 640x360 must succeed")

        # Frame 2: 1280x720 (camera resolution change)
        f2 = np.zeros((720, 1280, 3), dtype=np.uint8)
        out2 = ENGINE.infer(f2)
        self.assertIsNotNone(out2, "Inference on 1280x720 must succeed after auto-reload")

        # Frame 3: 512x288 (infer_mode change)
        f3 = np.zeros((288, 512, 3), dtype=np.uint8)
        out3 = ENGINE.infer(f3)
        self.assertIsNotNone(out3, "Inference on 512x288 must succeed after auto-reload")

        # Frame 4: 640x360 (switch back)
        f4 = np.zeros((360, 640, 3), dtype=np.uint8)
        out4 = ENGINE.infer(f4)
        self.assertIsNotNone(out4, "Inference on 640x360 must succeed after auto-reload")
        print("  ✓ Dynamic resolution switches (640x360 -> 1280x720 -> 512x288 -> 640x360) all succeeded cleanly")

    def test_09_adaptive_frame_skip_toggle(self):
        """Scenario 9: Adaptive frame skip toggle ->
        correctly updates configuration and status without side-effects."""
        print("\n--- Test 9: Adaptive Frame Skip Toggle ---")
        capture = CaptureSource()
        st = capture.configure(adaptive_frame_skip=True)
        self.assertTrue(st["adaptive_frame_skip"], "adaptive_frame_skip must be True after configure")
        st2 = capture.configure(adaptive_frame_skip=False)
        self.assertFalse(st2["adaptive_frame_skip"], "adaptive_frame_skip must be False after configure")
        print("  ✓ Adaptive frame skip toggle verified in CaptureSource configure & status")


    def test_10_forearm_lift_without_hands(self):
        """Scenario 10: Forearm / wrist raised in front of chest (wrist above elbow) without hands ->
        wrist must be preserved and arm must follow."""
        print("\n--- Test 10: Forearm Lift Without MediaPipe Hands ---")
        kps = make_dummy_keypoints(
            shoulder_y=140.0,
            elbow_xy=(345.0, 200.0),    # Elbow down from shoulder
            wrist_xy=(345.0, 150.0),    # Wrist raised up (above elbow, chest level)
            wrist_score=0.35,           # Sub-threshold score (0.35 < 0.45 desk_wrist_threshold)
        )
        payload = {
            "score": 0.90,
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300, "y": 90, "z": 0}]},
            "leftHand": [],             # Hands occluded or fist
            "rightHand": None,
        }
        wire = to_wire(payload, capture_hint=(640, 360))
        right_wrist = wire["keypoints"][16]
        self.assertGreater(right_wrist.get("score", 0.0), 0.0,
                           "Raised forearm wrist must NOT be suppressed even when MediaPipe Hands is absent!")
        print("  ✓ Forearm wrist raised at chest level preserved: score=%.3f" % right_wrist.get("score", 0.0))

    def test_11_cpu_affinity_toggle(self):
        """Scenario 11: CPU affinity toggle ->
        correctly updates configuration and status without error."""
        print("\n--- Test 11: CPU Affinity Toggle ---")
        capture = CaptureSource()
        st1 = capture.configure(cpu_affinity=True)
        self.assertTrue(st1["cpu_affinity"], "cpu_affinity must be True")
        st2 = capture.configure(cpu_affinity=False)
        self.assertFalse(st2["cpu_affinity"], "cpu_affinity must be False")
        st3 = capture.configure(cpu_affinity=True)
        self.assertTrue(st3["cpu_affinity"], "cpu_affinity must be restored to True")
        print("  ✓ CPU affinity toggle verified in CaptureSource configure & status")

    def test_12_arm_raised_laterally_without_hands(self):
        """Scenario 12: Arm raised laterally / horizontally without MediaPipe Hands ->
        wrist is preserved via body pose, and hand array is empty [] so Arm IK does not glitch."""
        print("\n--- Test 12: Lateral Arm Raised Without MediaPipe Hands ---")
        kps = make_dummy_keypoints(
            shoulder_y=150.0,
            elbow_xy=(440.0, 150.0),    # Elbow raised horizontally outward
            wrist_xy=(520.0, 150.0),    # Wrist raised horizontally outward
            wrist_score=0.85,
        )
        payload = {
            "score": 0.90,
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300, "y": 90, "z": 0}]},
            "leftHand": [],
            "rightHand": [],            # No hand detected (fist / side)
        }
        wire = to_wire(payload, capture_hint=(640, 360))
        right_wrist = wire["keypoints"][16]
        right_hand = wire["rightHand"]
        self.assertGreaterEqual(right_wrist.get("score", 0.0), 0.50,
                                "Raised lateral wrist must be preserved with high score")
        self.assertEqual(len(right_hand), 0,
                         "Must NOT synthesize fake hand landmarks so avatar does not trigger unwanted Arm IK")
        print("  ✓ Lateral wrist score=%.3f, hand correctly empty []" % right_wrist.get("score", 0.0))

    def test_13_shoulder_to_elbow_raised_wrist_occluded(self):
        """Scenario 13: Shoulder to elbow raised, but wrist occluded / weak ->
        wrist is projected along forearm and hand array remains empty []."""
        print("\n--- Test 13: Shoulder to Elbow Raised with Occluded Wrist ---")
        kps = make_dummy_keypoints(
            shoulder_y=150.0,
            elbow_xy=(430.0, 140.0),    # Elbow raised up/outward
            wrist_xy=(0.0, 0.0),        # Wrist occluded
            wrist_score=0.08,           # Very weak / occluded wrist
        )
        payload = {
            "score": 0.90,
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300, "y": 90, "z": 0}]},
            "leftHand": [],
            "rightHand": [],
        }
        wire = to_wire(payload, capture_hint=(640, 360))
        right_wrist = wire["keypoints"][16]
        right_hand = wire["rightHand"]
        self.assertGreaterEqual(right_wrist.get("score", 0.0), 0.50,
                                "Occluded wrist must be projected with score >= 0.50 when upper arm is raised")
        self.assertGreater(right_wrist["x"], wire["keypoints"][14]["x"],
                           "Projected wrist must extend outwards from raised elbow")
        self.assertEqual(len(right_hand), 0,
                         "Must NOT synthesize fake hand landmarks when hands are occluded")
        print("  ✓ Projected wrist at (%.3f, %.3f) score=%.3f, hand correctly empty []" % (
            right_wrist["x"], right_wrist["y"], right_wrist["score"]
        ))

    def test_14_downward_arm_continuation_and_no_fake_hands(self):
        """Scenario 14: Upper arm pointing downwards with occluded or flipped wrist ->
        forearm continues DOWNWARDS along the elbow line, and hand array is empty [] to avoid IK."""
        print("\n--- Test 14: Downward Arm Extension Without Fake Hands ---")
        kps = make_dummy_keypoints(
            shoulder_y=150.0,
            elbow_xy=(355.0, 230.0),    # Upper arm pointing downwards (dy = +80px)
            wrist_xy=(340.0, 160.0),    # Tracker hallucinated wrist upwards near chest
            wrist_score=0.10,           # Weak wrist
        )
        payload = {
            "score": 0.90,
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300, "y": 90, "z": 0}]},
            "leftHand": [],
            "rightHand": [],
        }
        wire = to_wire(payload, capture_hint=(640, 360))
        right_elbow = wire["keypoints"][14]
        right_wrist = wire["keypoints"][16]
        right_hand = wire["rightHand"]

        self.assertGreater(right_wrist["y"], right_elbow["y"],
                           "When upper arm points downwards, forearm wrist MUST continue downwards below elbow!")
        self.assertGreaterEqual(right_wrist["score"], 0.50,
                                "Downwards wrist must have valid confidence")
        self.assertEqual(len(right_hand), 0,
                         "Hands must be empty [] when not visible so Arm IK stays OFF!")
        print("  ✓ Elbow at y=%.3f -> Forearm wrist continued down to y=%.3f, hand correctly empty []" % (
            right_elbow["y"], right_wrist["y"]
        ))

    def test_15_smart_arm_sync_toggle(self):
        """Scenario 15: smart_arm_sync toggle ->
        when False, pure MediaPipe behavior with desk guard;
        when True, smart arm downward alignment is active."""
        print("\n--- Test 15: Smart Arm Sync Toggle ---")
        capture = CaptureSource()
        st_on = capture.configure(smart_arm_sync=True)
        self.assertTrue(st_on["smart_arm_sync"], "smart_arm_sync must be True")

        # With smart_arm_sync = False
        capture.configure(smart_arm_sync=False)
        self.assertFalse(ENGINE._smart_arm_sync, "ENGINE._smart_arm_sync must be False")

        kps = make_dummy_keypoints(
            shoulder_y=150.0,
            elbow_xy=(355.0, 230.0),
            wrist_xy=(340.0, 160.0),    # hallucinated upwards
            wrist_score=0.10,
        )
        payload = {
            "score": 0.90,
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300, "y": 90, "z": 0}]},
            "leftHand": [],
            "rightHand": [],
        }
        wire_off = to_wire(payload, capture_hint=(640, 360))
        # When smart_arm_sync is False and wrist is weak/flipped upwards, desk guard suppresses it
        self.assertEqual(wire_off["keypoints"][16].get("score", 0.0), 0.0,
                         "When smart_arm_sync is False and wrist is weak, wrist is suppressed by desk guard")
        self.assertEqual(len(wire_off["rightHand"]), 0,
                         "When smart_arm_sync is False, rightHand must be empty []")

        # Restore smart_arm_sync = True
        capture.configure(smart_arm_sync=True)
        self.assertTrue(ENGINE._smart_arm_sync, "ENGINE._smart_arm_sync must be True")
        wire_on = to_wire(payload, capture_hint=(640, 360))
        self.assertGreater(wire_on["keypoints"][16]["y"], wire_on["keypoints"][14]["y"],
                           "When smart_arm_sync is True, wrist is straightened downwards below elbow")
        print("  ✓ Smart arm sync toggle verified: False suppresses weak wrist, True straightens arm down")

    def test_16_shoulder_shrug_does_not_bend_arm(self):
        """Scenario 16: User lifts only their shoulder (shrug) while forearm is down/occluded ->
        elbow remains down and wrist is NOT bent upwards onto chest."""
        print("\n--- Test 16: Shoulder Shrug Isolation (No Phantom Arm Curl) ---")
        # Shoulder shrugged up (120 vs normal 150), elbow down at 230, wrist weak/occluded
        kps = make_dummy_keypoints(
            shoulder_y=120.0,
            elbow_xy=(345.0, 230.0),    # Elbow hanging down (dy_se = +110px)
            wrist_xy=(345.0, 310.0),    # Wrist down in lap
            wrist_score=0.15,
        )
        payload = {
            "score": 0.90,
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300, "y": 90, "z": 0}]},
            "leftHand": [],
            "rightHand": [],
        }
        # Run through capture stabilizer first
        stabilized = self.engine._stabilize_payload(payload, 640, 360)
        wire = to_wire(stabilized, capture_hint=(640, 360))

        right_elbow = wire["keypoints"][14]
        right_wrist = wire["keypoints"][16]

        self.assertGreater(right_wrist["y"], right_elbow["y"],
                           "Shoulder shrug must NEVER cause the forearm or wrist to bend upwards above elbow!")
        print("  ✓ Shoulder shrugged (y=120) -> Elbow (y=%.3f), Wrist maintained below elbow (y=%.3f)" % (
            right_elbow["y"], right_wrist["y"]
        ))

    def test_17_raising_hand_with_downward_elbow(self):
        """Scenario 17: User raises hand to gesture/scratch chin while elbow remains down ->
        real hand landmarks are emitted and wrist is raised above elbow."""
        print("\n--- Test 17: Raising Real Hand with Downward Elbow ---")
        kps = make_dummy_keypoints(
            shoulder_y=150.0,
            elbow_xy=(345.0, 240.0),    # Elbow down from shoulder
            wrist_xy=(345.0, 160.0),    # Forearm bent up (wrist above elbow, chin level)
            wrist_score=0.85,
        )
        real_hand = [{"x": 345.0/640.0, "y": 150.0/360.0, "z": 0.0, "score": 0.90} for _ in range(21)]
        payload = {
            "score": 0.95,
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300, "y": 90, "z": 0}]},
            "leftHand": [],
            "rightHand": real_hand,     # Real hand detected in camera!
        }
        wire = to_wire(payload, capture_hint=(640, 360))
        right_elbow = wire["keypoints"][14]
        right_wrist = wire["keypoints"][16]
        right_hand = wire["rightHand"]

        self.assertLess(right_wrist["y"], right_elbow["y"],
                        "When raising hand with downward elbow, wrist MUST be above elbow!")
        self.assertEqual(len(right_hand), 21,
                         "Real detected hand landmarks MUST be passed through!")
        print("  ✓ Elbow (y=%.3f) -> Wrist raised to (y=%.3f), %d real hand landmarks passed through" % (
            right_elbow["y"], right_wrist["y"], len(right_hand)
        ))

    def test_18_hand_at_chin_closed_fist(self):
        """Scenario 18: Hand at chin/neck with clenched fist (no 21-pt hand detected,
        wrist score ~0.42, elbow downward). The arm MUST NOT drop to the desk!"""
        print("\n--- Test 18: Hand at Chin with Clenched Fist (Arm Drop Prevention) ---")
        kps = make_dummy_keypoints(
            shoulder_y=120.0,
            elbow_xy=(345.0, 240.0),    # Elbow down along body (y=240 / 360 = 0.667)
            wrist_xy=(330.0, 140.0),    # Wrist curled up at chin (y=140 / 360 = 0.389)
            wrist_score=0.42,           # Moderate score typical of chin/neck occlusion
        )
        payload = {
            "score": 0.95,
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300, "y": 90, "z": 0}]},
            "leftHand": [],
            "rightHand": [],            # Fist clenched at chin -> no 21-pt hand detector output
        }
        wire = to_wire(payload, capture_hint=(640, 360))
        right_elbow = wire["keypoints"][14]
        right_wrist = wire["keypoints"][16]

        self.assertLess(right_wrist["y"], right_elbow["y"],
                        "Hand at chin MUST stay above elbow even without 21-pt hand detection!")
        self.assertGreaterEqual(right_wrist["score"], 0.30,
                                "Wrist score at chin must be preserved and not zeroed out!")
        print("  ✓ Elbow (y=%.3f) -> Wrist at chin (y=%.3f, score=%.3f) preserved without dropping to rest" % (
            right_elbow["y"], right_wrist["y"], right_wrist["score"]
        ))

    def test_19_desk_wrist_phantom_prevention(self):
        """Scenario 19: User seated at desk with hands on keyboard/lap.
        Both smart_arm_sync and desk_wrist_guard are enabled.
        MediaPipe outputs a phantom wrist near desk level (score 0.40, dy_ew=-10px, dy_se=+80px).
        Neither capture nor engine must raise the arm: wrist must be aligned naturally downwards!"""
        print("\n--- Test 19: Desk Phantom Wrist Prevention (Both Sync + Guard Active) ---")
        capture = CaptureSource()
        capture.configure(smart_arm_sync=True, desk_wrist_guard=True)
        self.assertTrue(capture._smart_arm_sync)
        self.assertTrue(capture._desk_wrist_guard)
        self.assertTrue(ENGINE._smart_arm_sync)
        self.assertTrue(ENGINE._desk_wrist_guard)

        # 1. Capture level: parent elbow occluded (score=0.10), phantom wrist score=0.40, no hand
        kps = make_dummy_keypoints(
            shoulder_y=150.0,
            elbow_xy=(355.0, 230.0),    # Elbow occluded at desk edge
            wrist_xy=(345.0, 220.0),    # Phantom wrist hovering near desk surface
            wrist_score=0.40,           # Sub-desk threshold or fluctuating
        )
        kps[14]["score"] = 0.10         # Occluded elbow
        kps[14]["visibility"] = 0.10
        payload = {
            "score": 0.90,
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "leftHand": [],
            "rightHand": [],
        }
        # Stabilizer must NOT fabricate an elbow from an unverified phantom wrist
        stabilized = capture._stabilize_payload(payload, 640, 360)
        stab_elbow = stabilized["keypoints"][14]
        self.assertLess(stab_elbow.get("score", 0.0), 0.20,
                        "Stabilizer must NOT synthesize elbow from unverified phantom desk wrist!")

        # 2. Engine level: to_wire with both enabled must NOT raise arm
        kps_live_el = make_dummy_keypoints(
            shoulder_y=150.0,
            elbow_xy=(355.0, 230.0),    # Elbow hanging down
            wrist_xy=(345.0, 215.0),    # Phantom wrist hovering slightly above elbow
            wrist_score=0.38,
        )
        payload2 = {
            "score": 0.90,
            "keypoints": kps_live_el,
            "keypoints3D": [dict(p) for p in kps_live_el],
            "leftHand": [],
            "rightHand": [],
        }
        wire = to_wire(payload2, capture_hint=(640, 360))
        right_elbow = wire["keypoints"][14]
        right_wrist = wire["keypoints"][16]
        right_hand = wire["rightHand"]

        # Assertions
        self.assertEqual(len(right_hand), 0, "Hand landmarks must be empty []")
        self.assertGreater(right_wrist["y"], right_elbow["y"],
                           "Wrist must be straightened downwards into rest pose, NEVER raised up!")
        print("  ✓ Phantom desk wrist suppressed: wrist (y=%.3f) aligned downwards below elbow (y=%.3f)" % (
            right_wrist["y"], right_elbow["y"]
        ))

    def test_20_raising_arm_from_under_desk_straight_forearm(self):
        """Scenario 20: Raising arm from under desk (elbow lifted outward/forward below shoulder, wrist occluded) ->
        wrist is projected straight along shoulder->elbow direction, not suppressed, hand empty []."""
        print("\n--- Test 20: Raising Arm from Under Desk (Straight Forearm Projection) ---")
        kps = make_dummy_keypoints(
            shoulder_y=150.0,
            elbow_xy=(385.0, 200.0),    # Elbow angled outward/upward at ~45 deg, but below shoulder (dy_se = +50px > 0)
            wrist_xy=(0.0, 0.0),        # Wrist hidden under desk
            wrist_score=0.05,
        )
        payload = {
            "score": 0.90,
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300, "y": 90, "z": 0}]},
            "leftHand": [],
            "rightHand": [],
        }
        wire = to_wire(payload, capture_hint=(640, 360))
        right_elbow = wire["keypoints"][14]
        right_wrist = wire["keypoints"][16]
        right_hand = wire["rightHand"]

        self.assertGreaterEqual(right_wrist["score"], 0.50,
                                "Wrist must be projected with confident score when arm is raised from desk")
        self.assertGreater(right_wrist["x"], right_elbow["x"],
                           "Wrist must extend straight outwards along upper arm direction")
        self.assertGreater(right_wrist["y"], right_elbow["y"],
                           "Wrist must extend along upper arm direction")
        self.assertEqual(len(right_hand), 0,
                         "Must NOT emit fake hand landmarks so Arm IK does not glitch")
        print("  ✓ Elbow at (%.3f, %.3f) -> Projected straight wrist at (%.3f, %.3f) score=%.3f, hand empty []" % (
            right_elbow["x"], right_elbow["y"], right_wrist["x"], right_wrist["y"], right_wrist["score"]
        ))

    def test_21_hand_raised_elbow_occluded_flicker_free(self):
        """Scenario 21: Hand raised beside head with elbow occluded by desk ->
        tracking is 100% flicker-free across fluctuating confidence scores (no disappearing hand, no wrist dropping to desk)."""
        print("\n--- Test 21: Hand Raised with Occluded Elbow (Flicker-Free Continuous Tracking) ---")
        import random
        random.seed(42)

        drops = 0
        disappears = 0
        frames_tested = 30

        for frame in range(frames_tested):
            kps = make_dummy_keypoints(
                shoulder_y=140.0,
                elbow_xy=(360.0, 220.0),
                wrist_xy=(360.0, 320.0),
                wrist_score=0.20,
            )
            # Occluded hips (desk seating)
            kps[23] = None
            kps[24] = None
            kps[14]["score"] = 0.75

            # Fluctuating scores dipping into low confidence (0.16 - 0.50)
            sc = 0.16 + random.random() * 0.35
            hand = [{"x": 420.0, "y": 80.0, "z": 0.0, "score": sc} for _ in range(21)]
            payload = {
                "score": 0.95,
                "keypoints": kps,
                "keypoints3D": [dict(p) if p else None for p in kps],
                "face": {"landmarks": [{"x": 300, "y": 90, "z": 0}]},
                "leftHand": [],
                "rightHand": hand,
            }
            stab = self.engine._stabilize_payload(payload, 640, 360)
            wire = to_wire(stab, capture_hint=(640, 360))
            wy = wire["keypoints"][16]["y"]
            hlen = len(wire["rightHand"])
            if wy > 0.40:
                drops += 1
            if hlen != 21:
                disappears += 1

        self.assertEqual(drops, 0, "Wrist must NEVER drop to desk while hand is raised!")
        self.assertEqual(disappears, 0, "Hand must NEVER disappear during continuous tracking!")
        print("  ✓ %d frames verified: 0 drops, 0 disappearances (100%% flicker-free)" % frames_tested)

    def test_22_raised_hand_occluded_elbow_no_snap(self):
        """Scenario 22: Hand raised while elbow is occluded -> elbow synthesized at natural midpoint,
        no abrupt jump/snap when elbow is re-acquired."""
        print("\n--- Test 22: Raised Hand Occluded Elbow (No Snap on Re-acquisition) ---")
        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(340.0, 200.0), wrist_xy=(400.0, 100.0), wrist_score=0.90)
        kps[14]["score"] = 0.05  # occluded right elbow
        payload = {"keypoints": kps, "keypoints3D": [dict(p) for p in kps]}
        out1 = self.engine._stabilize_payload(payload, 640, 360)
        el1 = out1["keypoints"][14]

        # Elbow must NOT be projected down to waist (y >= 150 + 170*0.85 = 294px)
        self.assertLess(el1["y"], 240.0, "Elbow must NOT be forced down to waist while hand is raised!")
        self.assertGreater(el1["x"], 340.0, "Elbow must be synthesized laterally outward towards hand")
        print("  ✓ Step 1: Occluded elbow synthesized naturally at (%.1f, %.1f) with score=%.2f" % (el1["x"], el1["y"], el1["score"]))

        # Step 2: Live elbow detected at (385.0, 145.0) (score = 0.85)
        kps2 = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(385.0, 145.0), wrist_xy=(400.0, 100.0), wrist_score=0.90)
        kps2[14]["score"] = 0.85
        payload2 = {"keypoints": kps2, "keypoints3D": [dict(p) for p in kps2]}
        out2 = self.engine._stabilize_payload(payload2, 640, 360)
        el2 = out2["keypoints"][14]

        # Max frame-to-frame jump must be smooth (< 35px), NOT a 100+ px snap from waist
        jump = ((el2["x"] - el1["x"]) ** 2 + (el2["y"] - el1["y"]) ** 2) ** 0.5
        self.assertLess(jump, 35.0, f"Re-acquisition jump ({jump:.1f}px) must be smooth and continuous, no snap from waist!")
        print("  ✓ Step 2: Live elbow smoothly re-acquired at (%.1f, %.1f) with jump=%.1fpx (smooth transition)" % (el2["x"], el2["y"], jump))

    def test_23_snappy_arm_lowering(self):
        """Scenario 23: Hand/arm lowering -> decays quickly to rest without lingering/sluggish lag."""
        print("\n--- Test 23: Snappy Arm Lowering (Fast Response) ---")
        # Frame 0: Wrist raised at (360, 160)
        kps0 = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 220.0), wrist_xy=(360.0, 160.0), wrist_score=0.88)
        self.engine._stabilize_payload({"keypoints": kps0, "keypoints3D": [dict(p) for p in kps0]}, 640, 360)

        # Frame 1: Hand lowering down fast to (360, 240)
        time.sleep(0.03)
        kps1 = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 220.0), wrist_xy=(360.0, 240.0), wrist_score=0.88)
        self.engine._stabilize_payload({"keypoints": kps1, "keypoints3D": [dict(p) for p in kps1]}, 640, 360)
        self.assertTrue(self.engine._wrist_moving_down[16], "Wrist downward motion must be detected!")

        # Frame 2: Hand drops under desk / occluded (score = 0.05) after 60ms
        time.sleep(0.06)
        kps2 = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 220.0), wrist_xy=(360.0, 240.0), wrist_score=0.05)
        out2 = self.engine._stabilize_payload({"keypoints": kps2, "keypoints3D": [dict(p) for p in kps2]}, 640, 360)
        w2 = out2["keypoints"][16]
        # Because it was moving down, it must transition to rest (score=0.0) without holding for 250ms!
        self.assertEqual(w2["score"], 0.0, "Lowering wrist must transition to rest immediately, NOT hang in the air!")
        print("  ✓ Lowering wrist decayed to rest pose (score=0.0) in <= 60ms (snappy and responsive)")

    def test_24_arm_raising_responsiveness_desk_guard(self):
        """Scenario 24: Raising arm from desk -> active immediately, desk guard does NOT pin down intentional lift."""
        print("\n--- Test 24: Arm Raising Responsiveness with Desk Guard Active ---")
        capture = CaptureSource()
        capture.configure(smart_arm_sync=True, desk_wrist_guard=True)

        # Frame 0: Hand resting down on desk at (350, 310) below elbow at (345, 230)
        kps0 = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 230.0), wrist_xy=(350.0, 310.0), wrist_score=0.85)
        capture._stabilize_payload({"keypoints": kps0, "keypoints3D": [dict(p) for p in kps0]}, 640, 360)

        # Frame 1: Hand lifts off desk to (350, 195) (above elbow by 35px), no 21-pt hand yet
        kps1 = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 230.0), wrist_xy=(350.0, 195.0), wrist_score=0.65)
        payload1 = {
            "score": 0.90,
            "keypoints": kps1,
            "keypoints3D": [dict(p) for p in kps1],
            "leftHand": [],
            "rightHand": [],
        }
        wire = to_wire(payload1, capture_hint=(640, 360))
        el = wire["keypoints"][14]
        wr = wire["keypoints"][16]

        # Wrist must be raised above elbow, NOT suppressed by desk guard!
        self.assertLess(wr["y"], el["y"], "Lifting wrist must immediately rise above elbow!")
        self.assertGreaterEqual(wr["score"], 0.50, "Lifting wrist must remain confident and active!")
        print("  ✓ Elbow (y=%.3f) -> Rising wrist at (y=%.3f, score=%.3f) active immediately without delay" % (
            el["y"], wr["y"], wr["score"]
        ))

    @unittest.skip("Superseded by milestone 3 clean kinematics")
    def test_25_mouse_movement_no_latch_no_hallucination(self):
        """Scenario 25: Micro-movements on mousepad (dy_w < -2px) must not permanently latch _wrist_moving_up
        or synthesize a raised wrist when wrist confidence drops at the desk."""
        print("\n--- Test 25: Mousepad Motion Latch Trap Prevention ---")
        capture = CaptureSource()
        capture.configure(smart_arm_sync=True, desk_wrist_guard=True)

        # Frame 0: Right hand on mouse at (380, 290) below elbow at (360, 220)
        kps0 = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(360.0, 220.0), wrist_xy=(380.0, 290.0), wrist_score=0.85)
        capture._stabilize_payload({"keypoints": kps0, "keypoints3D": [dict(p) for p in kps0]}, 640, 360)

        # Frame 1: User nudges mouse forward by 3px -> dy_w = -3px (rising motion on mousepad)
        kps1 = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(360.0, 220.0), wrist_xy=(380.0, 287.0), wrist_score=0.85)
        capture._stabilize_payload({"keypoints": kps1, "keypoints3D": [dict(p) for p in kps1]}, 640, 360)
        self.assertTrue(capture._wrist_moving_up[16], "Wrist upward motion detected on mouse nudge")

        # Frame 2: Mouse is stationary (dy_w = 0)
        kps2 = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(360.0, 220.0), wrist_xy=(380.0, 287.0), wrist_score=0.85)
        capture._stabilize_payload({"keypoints": kps2, "keypoints3D": [dict(p) for p in kps2]}, 640, 360)
        self.assertFalse(capture._wrist_moving_up[16], "Stationary mouse MUST clear _wrist_moving_up to False!")

        # Frame 3: Wrist drops into low score / occlusion on desk edge (score = 0.05)
        kps3 = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(360.0, 220.0), wrist_xy=(380.0, 287.0), wrist_score=0.05)
        time.sleep(0.15)  # past grace period
        out3 = capture._stabilize_payload({"keypoints": kps3, "keypoints3D": [dict(p) for p in kps3]}, 640, 360)
        wr3 = out3["keypoints"][16]
        # Must NOT synthesize a raised wrist! It must decay to rest (score=0.0)
        self.assertEqual(wr3["score"], 0.0, "Desk wrist must decay to rest pose, NEVER hallucinate in the air!")
        print("  ✓ Mousepad nudge did not trap rising latch; decayed cleanly to rest pose (score=0.0)")

    @unittest.skip("Superseded by milestone 3 clean kinematics")
    def test_26_hand_rotation_stability_no_snap(self):
        """Scenario 26: Rotating hand causing 21-pt hand detector drop must preserve
        wrist position at confident Pose landmark without snapping down or jumping."""
        print("\n--- Test 26: Hand Rotation Stability (No Snap on Hand Drop) ---")
        # Hand resting or gesturing with forearm bent forward (elbow y=220, wrist y=240, score=0.82)
        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(360.0, 220.0), wrist_xy=(375.0, 240.0), wrist_score=0.82)
        # MediaPipe Hand detector produces 0 points because hand is edge-on / rotated
        payload = {
            "score": 0.90,
            "keypoints": kps,
            "keypoints3D": [dict(p) for p in kps],
            "leftHand": [],
            "rightHand": [],
        }
        wire = to_wire(payload, capture_hint=(640, 360))
        wr = wire["keypoints"][16]
        # Wrist position must NOT be overwritten with rigid straight line (y=240/360 = 0.667)
        expected_y = 240.0 / 360.0
        self.assertAlmostEqual(wr["y"], expected_y, delta=0.02,
                               msg="Wrist position must be preserved from Pose detection, NOT overwritten by rigid elbow line!")
        self.assertGreaterEqual(wr["score"], 0.70, "Confident wrist score must be preserved!")
        print("  ✓ Confident wrist during hand rotation preserved at y=%.3f (expected ~%.3f) without snapping" % (
            wr["y"], expected_y
        ))

    @unittest.skip("Superseded by milestone 3 clean kinematics")
    def test_27_lateral_arm_projection_symmetry(self):
        """Scenario 27: Lateral arm synthesis and rest projection must flare OUTWARD
        away from torso centerline for both left and right arms, preventing chest clipping."""
        print("\n--- Test 27: Lateral Arm Projection Symmetry (No Chest Clipping) ---")
        capture = CaptureSource()
        capture.configure(smart_arm_sync=True)

        # Standard non-mirrored frame: Left shoulder (11) at x=400, Right shoulder (12) at x=240
        # Torso center is x=320.
        # Both arms occluded with elbows occluded: project to rest pose
        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(240.0, 230.0), wrist_xy=(240.0, 310.0), wrist_score=0.0)
        kps[11]["position"]["x"] = 400.0; kps[11]["x"] = 400.0; kps[11]["score"] = 0.85
        kps[12]["position"]["x"] = 240.0; kps[12]["x"] = 240.0; kps[12]["score"] = 0.85
        kps[13]["score"] = 0.0  # L elbow occluded
        kps[14]["score"] = 0.0  # R elbow occluded
        kps[15]["score"] = 0.0  # L wrist occluded
        kps[16]["score"] = 0.0  # R wrist occluded

        time.sleep(0.15)
        out = capture._stabilize_payload({"keypoints": kps, "keypoints3D": [dict(p) for p in kps]}, 640, 360)
        lw = out["keypoints"][15]
        rw = out["keypoints"][16]

        # Left wrist (11 is at x=400 > 320) must be projected OUTWARD (x >= 400), NOT inward towards 320!
        self.assertGreaterEqual(lw["position"]["x"], 400.0,
                                "Left arm must project outward to the right (+x), away from chest!")
        # Right wrist (12 is at x=240 < 320) must be projected OUTWARD (x <= 240), NOT inward towards 320!
        self.assertLessEqual(rw["position"]["x"], 240.0,
                             "Right arm must project outward to the left (-x), away from chest!")
        print("  ✓ Left wrist projected laterally at x=%.1f (>=400.0)" % lw["position"]["x"])
        print("  ✓ Right wrist projected laterally at x=%.1f (<=240.0)" % rw["position"]["x"])

    @unittest.skip("Superseded by milestone 3 clean kinematics")
    def test_28_phantom_chest_hand_rejection(self):
        """Scenario 28: User seated with arms resting on desk/lap.
        MediaPipe detects phantom hand candidates on the hoodie collar/upper chest (confidence ~0.25).
        Pipeline MUST reject the phantom hands and keep wrists resting downwards below elbows."""
        print("\n--- Test 28: Phantom Chest Hand Rejection (Arms Resting on Desk) ---")
        capture = CaptureSource()
        capture._reset_landmark_stabilizer("test_model_28")

        # Seated posture: shoulders at y=150, elbows pointing down to y=240, wrists at desk (y=310, score=0.20)
        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 240.0), wrist_xy=(345.0, 310.0), wrist_score=0.20)
        kps[11]["position"] = {"x": 260.0, "y": 150.0, "z": 0.0}; kps[11]["x"] = 260.0; kps[11]["y"] = 150.0; kps[11]["score"] = 0.85
        kps[12]["position"] = {"x": 340.0, "y": 150.0, "z": 0.0}; kps[12]["x"] = 340.0; kps[12]["y"] = 150.0; kps[12]["score"] = 0.85
        kps[13]["position"] = {"x": 255.0, "y": 240.0, "z": 0.0}; kps[13]["x"] = 255.0; kps[13]["y"] = 240.0; kps[13]["score"] = 0.75
        kps[15]["position"] = {"x": 250.0, "y": 310.0, "z": 0.0}; kps[15]["x"] = 250.0; kps[15]["y"] = 310.0; kps[15]["score"] = 0.20

        # Phantom hands hallucinated on chest/collar at x=300 (center), y=145 (collar) with weak score 0.25
        phantom_hand = [{"x": 300.0, "y": 145.0, "z": 0.0, "score": 0.25} for _ in range(21)]

        payload = {
            "score": 0.90,
            "keypoints": [dict(p) for p in kps],
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]},
            "leftHand": phantom_hand[:],
            "rightHand": phantom_hand[:],
        }

        stab = capture._stabilize_payload(payload, 640, 360)
        wire = to_wire(stab, capture_hint=(640, 360))

        # Assertions
        lh = wire.get("leftHand") or []
        rh = wire.get("rightHand") or []
        self.assertEqual(len(lh), 0, "Phantom left hand on chest MUST be rejected ([])")
        self.assertEqual(len(rh), 0, "Phantom right hand on chest MUST be rejected ([])")

        rw = wire["keypoints"][16]
        re = wire["keypoints"][14]
        # Wrist must stay below elbow pointing down to desk, not raised to chest!
        self.assertGreater(rw["y"], re["y"],
                           "Right wrist must remain below elbow pointing towards desk, NOT raised to chest!")
        print("  ✓ Phantom chest hands rejected: leftHand=[] rightHand=[]")
        print("  ✓ Wrists maintained below elbows at rest (rw_y=%.3f > re_y=%.3f)" % (rw["y"], re["y"]))

    @unittest.skip("Superseded by milestone 3 clean kinematics")
    def test_29_hand_near_face_single_hand_no_mirroring(self):
        """Scenario 29: User sitting with left arm resting on desk, right hand raised in front of face.
        MediaPipe detects real rightHand at face, but hallucinates / duplicates a leftHand candidate at face.
        Pipeline MUST reject the duplicate left hand and keep left wrist resting downwards below elbow."""
        print("\n--- Test 29: Hand Near Face Single Hand (No Hallucinated Twin) ---")
        capture = CaptureSource()
        capture._reset_landmark_stabilizer("test_model_29")

        # Seated posture: shoulders at y=150.
        # Left arm resting on desk: L elbow (13) at (255, 240), L wrist (15) at (250, 310) with score 0.25.
        # Right arm raised to face: R elbow (14) at (345, 180), R wrist (16) at (300, 100) with score 0.85.
        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 180.0), wrist_xy=(300.0, 100.0), wrist_score=0.85)
        kps[11]["position"] = {"x": 260.0, "y": 150.0, "z": 0.0}; kps[11]["x"] = 260.0; kps[11]["y"] = 150.0; kps[11]["score"] = 0.85
        kps[12]["position"] = {"x": 340.0, "y": 150.0, "z": 0.0}; kps[12]["x"] = 340.0; kps[12]["y"] = 150.0; kps[12]["score"] = 0.85
        kps[13]["position"] = {"x": 255.0, "y": 240.0, "z": 0.0}; kps[13]["x"] = 255.0; kps[13]["y"] = 240.0; kps[13]["score"] = 0.75
        kps[15]["position"] = {"x": 250.0, "y": 310.0, "z": 0.0}; kps[15]["x"] = 250.0; kps[15]["y"] = 310.0; kps[15]["score"] = 0.25

        # Hands near face (x=300, y=100)
        rh_pts = [{"x": 300.0 + i, "y": 100.0, "z": 0.0, "score": 0.85, "visibility": 0.85, "position": {"x": 300.0 + i, "y": 100.0, "z": 0.0}} for i in range(21)]
        lh_pts = [{"x": 304.0 + i, "y": 102.0, "z": 0.0, "score": 0.85, "visibility": 0.85, "position": {"x": 304.0 + i, "y": 102.0, "z": 0.0}} for i in range(21)]

        payload = {
            "score": 0.90,
            "keypoints": [dict(p) for p in kps],
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]},
            "leftHand": lh_pts[:],
            "rightHand": rh_pts[:],
        }

        stab = capture._stabilize_payload(payload, 640, 360)
        wire = to_wire(stab, capture_hint=(640, 360))

        lh = wire.get("leftHand") or []
        rh = wire.get("rightHand") or []
        self.assertEqual(len(lh), 0, "Duplicate left hand on face MUST be rejected ([])")
        self.assertEqual(len(rh), 21, "Genuine right hand at face MUST be accepted (21 pts)")

        lw = wire["keypoints"][15]
        le = wire["keypoints"][13]
        # Resting left wrist must stay below left elbow pointing to desk, NOT raised to face!
        self.assertGreater(lw["y"], le["y"],
                           "Resting left wrist must remain below elbow pointing towards desk, NOT raised to face!")
        print("  ✓ Duplicate left hand rejected: leftHand=[] rightHand=21 pts")
        print("  ✓ Resting left arm maintained below elbow (lw_y=%.3f > le_y=%.3f)" % (lw["y"], le["y"]))

    @unittest.skip("Superseded by milestone 3 clean kinematics")
    def test_30_adaptive_smoothing_calm_jitter_free(self):
        """Scenario 30: Small frame-to-frame landmark jitter (< 5px) is filtered smoothly (alpha ~ 0.32),
        providing rock-solid steady hands without vibration or jerking."""
        print("\n--- Test 30: Adaptive Speed-Sensitive Hand Landmark Smoothing ---")
        capture = CaptureSource()
        capture._reset_landmark_stabilizer("test_model_30")

        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 200.0), wrist_xy=(350.0, 160.0), wrist_score=0.85)

        # Frame 0: Hand at (350, 160)
        h0 = [{"x": 350.0 + i, "y": 160.0, "z": 0.0, "score": 0.85, "visibility": 0.85, "position": {"x": 350.0 + i, "y": 160.0, "z": 0.0}} for i in range(21)]
        out0 = capture._stabilize_payload({
            "score": 0.90, "keypoints": [dict(p) for p in kps], "keypoints3D": [dict(p) for p in kps],
            "face": None, "leftHand": [], "rightHand": h0
        }, 640, 360)

        # Frame 1: Minor 2.0px sensor jitter to (352, 161)
        time.sleep(0.02)
        h1 = [{"x": 352.0 + i, "y": 161.0, "z": 0.0, "score": 0.85, "visibility": 0.85, "position": {"x": 352.0 + i, "y": 161.0, "z": 0.0}} for i in range(21)]
        out1 = capture._stabilize_payload({
            "score": 0.90, "keypoints": [dict(p) for p in kps], "keypoints3D": [dict(p) for p in kps],
            "face": None, "leftHand": [], "rightHand": h1
        }, 640, 360)

        rh1 = out1.get("rightHand") or []
        self.assertEqual(len(rh1), 21)
        w1_x = rh1[0]["position"]["x"]
        # Expected smoothed x: 350.0 * (1 - 0.32) + 352.0 * 0.32 = 350.0 * 0.68 + 112.64 = 350.64
        self.assertLess(w1_x, 351.0, "Adaptive smoothing must attenuate micro-jitter (alpha ~ 0.32)")
        self.assertGreater(w1_x, 350.3, "Adaptive smoothing must track gently forward")
        print("  ✓ Sensor jitter (350.0 -> 352.0) smoothed calmly to x=%.3f (alpha ~ 0.32)" % w1_x)

    @unittest.skip("Superseded by milestone 3 clean kinematics")
    def test_31_desk_reaching_mouse_click_no_phantom_wave(self):
        """Scenario 31: User reaches forward to touch mouse / desk at end of session.
        Hand was previously gesturing up, then drops off-screen (w_sc=0.0, has_hand=False).
        Elbow is down below shoulder (dy_se > 0) with slight lateral reach.
        The stabilizer must NOT recycle the old upward wrist vector or synthesize a wave in the air."""
        print("\n--- Test 31: Mouse Reaching at End of Session (No Phantom Wave) ---")
        capture = CaptureSource()
        capture._reset_landmark_stabilizer("test_model_31")

        # Step 1: User gestures with hand up near chest/chin
        kps_up = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 220.0), wrist_xy=(345.0, 160.0), wrist_score=0.85)
        h_up = [{"x": 345.0/640.0, "y": 160.0/360.0, "z": 0.0, "score": 0.85, "position": {"x": 345.0, "y": 160.0, "z": 0.0}} for _ in range(21)]
        capture._stabilize_payload({
            "score": 0.90, "keypoints": [dict(p) for p in kps_up], "keypoints3D": [dict(p) for p in kps_up],
            "face": None, "leftHand": [], "rightHand": h_up
        }, 640, 360)

        # Step 2: User reaches forward to mouse. Hand drops off bottom edge of camera view.
        # Wrist occluded (score=0.0), no 21-pt hand. Elbow sits at desk height (y=230, below shoulder y=150).
        time.sleep(0.08)
        kps_mouse = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(360.0, 230.0), wrist_xy=(0.0, 0.0), wrist_score=0.00)
        out = capture._stabilize_payload({
            "score": 0.90, "keypoints": [dict(p) for p in kps_mouse], "keypoints3D": [dict(p) for p in kps_mouse],
            "face": None, "leftHand": [], "rightHand": []
        }, 640, 360)

        rw = out["keypoints"][16]
        re = out["keypoints"][14]
        # Wrist must NOT be projected up into the air (rw['y'] must be >= re['y'])
        self.assertGreaterEqual(rw["y"], re["y"], "Wrist must NOT jump into air above elbow when reaching for mouse!")
        print("  ✓ Mouse reaching verified: wrist (y=%.1f) naturally below elbow (y=%.1f), no upward phantom jump" % (rw["y"], re["y"]))

    def test_32_touching_and_overlapping_hands_both_kept(self):
        """Scenario 32: Raising both hands and bringing them close together (clapping, praying, joined hands).
        Both hands are within dist_between < torso * 0.15.
        Superposition check must NEVER delete either hand when both arms are raised!"""
        print("\n--- Test 32: Touching Hands Superposition (Both Hands Kept) ---")
        capture = CaptureSource()
        capture._reset_landmark_stabilizer("test_model_32")

        # Both arms raised in front of chest/body:
        # Left arm: shoulder (260, 150), elbow (255, 185), wrist (295, 175)
        # Right arm: shoulder (340, 150), elbow (345, 185), wrist (305, 175)
        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 185.0), wrist_xy=(305.0, 175.0), wrist_score=0.85)
        kps[11]["position"] = {"x": 260.0, "y": 150.0, "z": 0.0}; kps[11]["x"] = 260.0; kps[11]["y"] = 150.0; kps[11]["score"] = 0.85
        kps[12]["position"] = {"x": 340.0, "y": 150.0, "z": 0.0}; kps[12]["x"] = 340.0; kps[12]["y"] = 150.0; kps[12]["score"] = 0.85
        kps[13]["position"] = {"x": 255.0, "y": 185.0, "z": 0.0}; kps[13]["x"] = 255.0; kps[13]["y"] = 185.0; kps[13]["score"] = 0.80
        kps[14]["position"] = {"x": 345.0, "y": 185.0, "z": 0.0}; kps[14]["x"] = 345.0; kps[14]["y"] = 185.0; kps[14]["score"] = 0.80
        kps[15]["position"] = {"x": 295.0, "y": 175.0, "z": 0.0}; kps[15]["x"] = 295.0; kps[15]["y"] = 175.0; kps[15]["score"] = 0.85
        kps[16]["position"] = {"x": 305.0, "y": 175.0, "z": 0.0}; kps[16]["x"] = 305.0; kps[16]["y"] = 175.0; kps[16]["score"] = 0.85

        # Wrists are within 10px of each other (dist_between < torso * 0.15)
        lh_pts = [{"x": (295.0 + i * 0.5) / 640.0, "y": (175.0 + i * 0.5) / 360.0, "z": 0.0,
                   "score": 0.85, "visibility": 0.85,
                   "position": {"x": 295.0 + i * 0.5, "y": 175.0 + i * 0.5, "z": 0.0}} for i in range(21)]
        rh_pts = [{"x": (305.0 + i * 0.5) / 640.0, "y": (175.0 + i * 0.5) / 360.0, "z": 0.0,
                   "score": 0.85, "visibility": 0.85,
                   "position": {"x": 305.0 + i * 0.5, "y": 175.0 + i * 0.5, "z": 0.0}} for i in range(21)]

        payload = {
            "score": 0.90,
            "keypoints": [dict(p) for p in kps],
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]},
            "leftHand": lh_pts[:],
            "rightHand": rh_pts[:],
        }

        stab = capture._stabilize_payload(payload, 640, 360)
        wire = to_wire(stab, capture_hint=(640, 360))

        lh = wire.get("leftHand") or []
        rh = wire.get("rightHand") or []
        self.assertEqual(len(lh), 21, "Left hand must NOT be rejected when both hands are close together!")
        self.assertEqual(len(rh), 21, "Right hand must NOT be rejected when both hands are close together!")
        print("  ✓ Both hands preserved when touching/close together: leftHand=21 pts, rightHand=21 pts")

    def test_33_raising_single_hand_keeps_resting_arm_calm(self):
        """Scenario 33: User seated at desk. Left arm resting on armrest/desk with elbow slightly flared.
        User raises only the right hand.
        The pipeline must NOT raise the resting left arm into the air!"""
        print("\n--- Test 33: Raising Single Hand (Resting Arm Remains Calm) ---")
        capture = CaptureSource()
        capture._reset_landmark_stabilizer("test_model_33")

        # Torso span: ~150px.
        # Right arm: raised to face (elbow y=180, wrist y=110, 21-pt hand present).
        # Left arm: resting on armrest with slight lateral angle (elbow x=245, y=215, wrist x=250, y=285, score=0.44).
        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(345.0, 180.0), wrist_xy=(310.0, 110.0), wrist_score=0.88)
        # Left shoulder at (260, 150), Right shoulder at (340, 150)
        kps[11]["position"] = {"x": 260.0, "y": 150.0, "z": 0.0}; kps[11]["x"] = 260.0; kps[11]["y"] = 150.0; kps[11]["score"] = 0.85
        kps[12]["position"] = {"x": 340.0, "y": 150.0, "z": 0.0}; kps[12]["x"] = 340.0; kps[12]["y"] = 150.0; kps[12]["score"] = 0.85
        # Left elbow: flared slightly on armrest (dx_se = -15px, dy_se = +65px)
        kps[13]["position"] = {"x": 245.0, "y": 215.0, "z": 0.0}; kps[13]["x"] = 245.0; kps[13]["y"] = 215.0; kps[13]["score"] = 0.70
        # Left wrist: resting down towards desk (y=285 > 215, score=0.44 < desk_thresh)
        kps[15]["position"] = {"x": 250.0, "y": 285.0, "z": 0.0}; kps[15]["x"] = 250.0; kps[15]["y"] = 285.0; kps[15]["score"] = 0.44

        rh_pts = [{"x": (310.0 + i) / 640.0, "y": (110.0 + i) / 360.0, "z": 0.0,
                   "score": 0.88, "visibility": 0.88,
                   "position": {"x": 310.0 + i, "y": 110.0 + i, "z": 0.0}} for i in range(21)]

        payload = {
            "score": 0.90,
            "keypoints": [dict(p) for p in kps],
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]},
            "leftHand": [],     # No hand for resting left arm
            "rightHand": rh_pts[:],
        }

        stab = capture._stabilize_payload(payload, 640, 360)
        wire = to_wire(stab, capture_hint=(640, 360))

        lh = wire.get("leftHand") or []
        rh = wire.get("rightHand") or []
        self.assertEqual(len(lh), 0, "Resting left arm must have NO fake hand landmarks!")
        self.assertEqual(len(rh), 21, "Raised right arm must have 21 hand landmarks!")

        lw = wire["keypoints"][15]
        le = wire["keypoints"][13]
        rw = wire["keypoints"][16]
        re = wire["keypoints"][14]

        # Right wrist is raised above right elbow
        self.assertLess(rw["y"], re["y"], "Raised right wrist must be higher than right elbow!")
        # Left wrist MUST stay below left elbow pointing down at desk/lap
        self.assertGreater(lw["y"], le["y"], "Resting left wrist must stay BELOW left elbow, NEVER raised up!")
        print("  ✓ Raised right arm active (rw_y=%.3f < re_y=%.3f, 21 hand pts)" % (rw["y"], re["y"]))
        print("  ✓ Resting left arm calm at rest (lw_y=%.3f > le_y=%.3f, 0 hand pts)" % (lw["y"], le["y"]))

    def test_34_downward_hand_noise_no_false_activation(self):
        """Scenario 34: MediaPipe generates noisy hand landmarks pointing downwards near desk edge or lap.
        Even with desk guard off, this downward resting hand noise must NOT activate gesture mode or
        synthesize an elbow up in the air. When the hand is raised, it activates with zero delay."""
        print("\n--- Test 34: Downward Hand Noise (No False Gesture Activation) ---")
        capture = CaptureSource()
        capture.configure(smart_arm_sync=True, desk_wrist_guard=False)

        # Shoulder y=150, Elbow y=220, Downward hand at y=320 (bottom edge of 360)
        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(360.0, 220.0), wrist_xy=(380.0, 320.0), wrist_score=0.85)
        # 21 hand points pointing down at y=320..350
        rh_pts = [{"x": 380.0 / 640.0, "y": (320.0 + i) / 360.0, "z": 0.0,
                   "score": 0.60, "visibility": 0.60,
                   "position": {"x": 380.0, "y": 320.0 + i, "z": 0.0}} for i in range(21)]

        payload = {
            "score": 0.90,
            "keypoints": [dict(p) for p in kps],
            "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]},
            "leftHand": [],
            "rightHand": rh_pts,
        }

        wire = to_wire(payload, capture_hint=(640, 360))
        rh = wire.get("rightHand") or []
        re = wire["keypoints"][14]
        rw = wire["keypoints"][16]

        # 1. Downward resting hand noise must NOT be sent to frontend
        self.assertEqual(len(rh), 0, "Downward resting hand noise must NOT be passed to frontend ([])!")
        # 2. Right wrist must remain down below elbow
        self.assertGreaterEqual(rw["y"], re["y"], "Wrist must stay below elbow when resting downwards!")
        # 3. Elbow must not be synthesized high up in the air
        self.assertGreaterEqual(re["y"], 0.50, "Elbow must stay naturally down near torso, NOT high in the air!")
        print("  ✓ Step 1: Downward resting hand noise rejected (rightHand=[]), elbow calm at rest")

        # Now raise hand above chest (y=120)
        rh_raised = [{"x": 380.0 / 640.0, "y": (120.0 + i) / 360.0, "z": 0.0,
                      "score": 0.85, "visibility": 0.85,
                      "position": {"x": 380.0, "y": 120.0 + i, "z": 0.0}} for i in range(21)]
        kps_raised = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(360.0, 200.0), wrist_xy=(380.0, 120.0), wrist_score=0.85)
        payload_raised = {
            "score": 0.90,
            "keypoints": [dict(p) for p in kps_raised],
            "keypoints3D": [dict(p) for p in kps_raised],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]},
            "leftHand": [],
            "rightHand": rh_raised,
        }

        wire_raised = to_wire(payload_raised, capture_hint=(640, 360))
        rh_r = wire_raised.get("rightHand") or []
        rw_r = wire_raised["keypoints"][16]
        re_r = wire_raised["keypoints"][14]

        self.assertEqual(len(rh_r), 21, "Raised hand must immediately pass 21 landmarks on frame 1!")
        self.assertLess(rw_r["y"], re_r["y"], "Raised wrist must be above elbow!")
        print("  ✓ Step 2: Raised hand activated immediately on frame 1 with 21 landmarks and zero delay")

    def test_35_raised_hand_palms_facing_webcam_wrist_noise_no_drop(self):
        """Scenario 35: User has hand raised with palm facing the webcam.
        Due to model noise on the palm-facing posture, the wrist landmark drops downward below the elbow.
        The hand must NEVER disappear (rightHand != []), wrist must not drop to 0, and arm must stay active."""
        print("\n--- Test 35: Raised Hand Palms Facing Webcam (Wrist Noise Does Not Vanish) ---")
        capture = CaptureSource()
        capture.configure(smart_arm_sync=True, desk_wrist_guard=False)

        # Hand raised with palm facing webcam: fingers at y=100..150, wrist at y=180, elbow at y=220
        # Landmark 9 (middle MCP) is at (380, 140), landmark 0 (wrist) at (380, 180)
        rh_pts = [{"x": 380.0 / 640.0, "y": (100.0 + i * 4.0) / 360.0, "z": 0.0,
                   "score": 0.85, "visibility": 0.85,
                   "position": {"x": 380.0, "y": 100.0 + i * 4.0, "z": 0.0}} for i in range(21)]
        # Make sure landmark 0 is wrist (180), landmark 9 is middle MCP (140)
        rh_pts[0]["position"]["y"] = 180.0; rh_pts[0]["y"] = 180.0 / 360.0
        rh_pts[9]["position"]["y"] = 140.0; rh_pts[9]["y"] = 140.0 / 360.0

        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(360.0, 220.0), wrist_xy=(380.0, 180.0), wrist_score=0.85)
        payload = {
            "score": 0.90, "keypoints": [dict(p) for p in kps], "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]}, "leftHand": [], "rightHand": rh_pts,
        }
        wire0 = to_wire(payload, capture_hint=(640, 360))
        self.assertEqual(len(wire0.get("rightHand") or []), 21)
        print("  ✓ Step 1: Hand raised with palm facing camera tracked with 21 landmarks")

        # Frame 1: Noise in model causes wrist landmark 0 to drop downwards below elbow (y=245 > elbow 220)
        # while fingers/palm remain raised in front of webcam (landmark 9 is still at y=140)
        rh_pts_noisy = [dict(p) for p in rh_pts]
        rh_pts_noisy[0]["position"]["y"] = 245.0
        rh_pts_noisy[0]["y"] = 245.0 / 360.0
        kps_noisy = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(360.0, 220.0), wrist_xy=(380.0, 245.0), wrist_score=0.45)

        payload_noisy = {
            "score": 0.90, "keypoints": [dict(p) for p in kps_noisy], "keypoints3D": [dict(p) for p in kps_noisy],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]}, "leftHand": [], "rightHand": rh_pts_noisy,
        }
        wire1 = to_wire(payload_noisy, capture_hint=(640, 360))
        rh1 = wire1.get("rightHand") or []
        rw1 = wire1["keypoints"][16]
        re1 = wire1["keypoints"][14]

        # 1. Hand MUST NOT disappear!
        self.assertEqual(len(rh1), 21, "Hand MUST NOT disappear when wrist fluctuates downward in palm-facing pose!")
        # 2. Wrist MUST NOT be suppressed to 0.0!
        self.assertGreaterEqual(rw1["score"], 0.50, "Wrist score must remain confident, NOT suppressed!")
        # 3. Wrist position must not plunge into void away from palm
        self.assertLess(rw1["y"], 0.65, "Wrist must stay connected near palm, NOT drop into void!")
        print("  ✓ Step 2: Wrist noise (dropping below elbow) did NOT cause hand to vanish: rightHand=21 pts, score=%.2f" % rw1["score"])

    def test_36_slow_hand_lowering_no_boundary_oscillation(self):
        """Scenario 36: User slowly lowers hand towards the bottom edge of camera view.
        With sensor noise fluctuating around the boundary (y=0.74..0.84), Schmitt trigger
        hysteresis and debouncing must prevent oscillation/chatter (hand MUST NOT alternate 21 <-> 0)."""
        print("\n--- Test 36: Slow Hand Lowering (Zero Boundary Oscillation) ---")
        capture = CaptureSource()
        capture.configure(smart_arm_sync=True, desk_wrist_guard=False)

        # Start with hand raised at y=0.50 (active gesture)
        rh_pts = [{"x": 380.0 / 640.0, "y": (180.0 + i * 2.0) / 360.0, "z": 0.0,
                   "score": 0.85, "visibility": 0.85,
                   "position": {"x": 380.0, "y": 180.0 + i * 2.0, "z": 0.0}} for i in range(21)]
        kps = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(360.0, 200.0), wrist_xy=(380.0, 180.0), wrist_score=0.85)
        payload = {
            "score": 0.90, "keypoints": [dict(p) for p in kps], "keypoints3D": [dict(p) for p in kps],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]}, "leftHand": [], "rightHand": rh_pts,
        }
        wire_start = to_wire(payload, capture_hint=(640, 360))
        self.assertEqual(len(wire_start.get("rightHand") or []), 21, "Hand must start active (21 pts)")

        # Slowly lower hand across the critical 0.74 .. 0.84 boundary with noise:
        # y positions: 0.74, 0.76, 0.75, 0.77, 0.79, 0.81, 0.80, 0.83, 0.85
        y_steps = [266.0, 274.0, 270.0, 277.0, 284.0, 292.0, 288.0, 299.0, 306.0]
        drops = 0
        for step_idx, y_px in enumerate(y_steps):
            rh_step = [{"x": 380.0 / 640.0, "y": (y_px + i * 1.5) / 360.0, "z": 0.0,
                        "score": 0.80, "visibility": 0.80,
                        "position": {"x": 380.0, "y": y_px + i * 1.5, "z": 0.0}} for i in range(21)]
            kps_step = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(360.0, 220.0), wrist_xy=(380.0, y_px), wrist_score=0.80)
            p_step = {
                "score": 0.90, "keypoints": [dict(p) for p in kps_step], "keypoints3D": [dict(p) for p in kps_step],
                "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]}, "leftHand": [], "rightHand": rh_step,
            }
            wire_step = to_wire(p_step, capture_hint=(640, 360))
            pts_count = len(wire_step.get("rightHand") or [])
            if pts_count == 0:
                drops += 1

        self.assertEqual(drops, 0, f"Slow descent must NOT chatter or drop hands across boundary! Dropped frames: {drops}/{len(y_steps)}")
        print("  ✓ Slow descent verified: 0 drops across boundary (%d frames smoothly tracked with 21 landmarks)" % len(y_steps))

    def test_37_heavily_occluded_elbow_no_snap_or_desk_drop(self):
        """Scenario 37: User's elbow is heavily occluded (e.g. by desk/chair/clothing).
        MediaPipe elbow is occluded (score < 0.20) while hand is raised (y=120).
        1. Natural triangular elbow must be maintained in the natural zone.
        2. Fluctuations in occluded score must NOT cause instability."""
        print("\n--- Test 37: Heavily Occluded Elbow (Synthesis in Natural Zone) ---")
        capture = CaptureSource()
        capture.configure(smart_arm_sync=True, desk_wrist_guard=False)

        # Shoulder y=150, Hand raised at y=120, occluded elbow (score=0.15)
        rh_pts = [{"x": 380.0 / 640.0, "y": (120.0 + i) / 360.0, "z": 0.0,
                   "score": 0.85, "visibility": 0.85,
                   "position": {"x": 380.0, "y": 120.0 + i, "z": 0.0}} for i in range(21)]
        kps_desk_phantom = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(360.0, 310.0), wrist_xy=(380.0, 120.0), wrist_score=0.85)
        kps_desk_phantom[14]["score"] = 0.15  # occluded elbow score (< 0.20)

        payload1 = {
            "score": 0.90, "keypoints": [dict(p) for p in kps_desk_phantom], "keypoints3D": [dict(p) for p in kps_desk_phantom],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]}, "leftHand": [], "rightHand": rh_pts,
        }
        wire1 = to_wire(payload1, capture_hint=(640, 360))
        el1 = wire1["keypoints"][14]

        # 1. Elbow must NOT be at desk (y=310 / 360 = 0.86), must be synthesized naturally (y < 230 / 360 = 0.64)
        self.assertLess(el1["y"], 0.64, "Occluded elbow must be synthesized naturally in upper-body zone!")
        print("  ✓ Step 1: Occluded elbow synthesized naturally at y=%.3f" % el1["y"])

        # Frame 2: Score fluctuates to 0.10
        kps_desk_phantom[14]["score"] = 0.10
        wire2 = to_wire(payload1, capture_hint=(640, 360))
        el2 = wire2["keypoints"][14]
        jump1_2 = ((el2["x"] - el1["x"]) ** 2 + (el2["y"] - el1["y"]) ** 2) ** 0.5
        self.assertLess(jump1_2, 0.05, f"Score fluctuation (0.15 -> 0.10) must NOT snap elbow! Jump was: {jump1_2:.4f}")
        print("  ✓ Step 2: Score fluctuation (0.15 -> 0.10) resulted in stable elbow (jump=%.4f)" % jump1_2)

    def test_38_lateral_abduction_vs_cross_body_elbow_kinematics(self):
        """Scenario 38: Adaptive Biomechanical Elbow Kinematics.
        1. When hand is abducted laterally (Image 2), elbow must flare outward (ex <= sx).
        2. When hand reaches across chest (adduction), elbow must fold towards sternum (ex > sx)."""
        print("\n--- Test 38: Lateral Abduction vs Cross-Body Kinematics ---")
        capture = CaptureSource()
        capture.configure(smart_arm_sync=True, desk_wrist_guard=False)

        # Pose 1: Lateral Abduction (Image 2 pose)
        # Right shoulder at x=230 (0.359), Hand raised outward at x=90 (0.141), Elbow occluded (score=0.05)
        rh_lateral = [{"x": 90.0 / 640.0, "y": (130.0 + i) / 360.0, "z": 0.0,
                       "score": 0.85, "visibility": 0.85,
                       "position": {"x": 90.0, "y": 130.0 + i, "z": 0.0}} for i in range(21)]
        kps1 = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(200.0, 250.0), wrist_xy=(90.0, 130.0), wrist_score=0.85)
        kps1[12]["position"]["x"] = 230.0; kps1[12]["x"] = 230.0 / 640.0  # Right shoulder
        kps1[14]["score"] = 0.05  # occluded elbow

        payload1 = {
            "score": 0.90, "keypoints": [dict(p) for p in kps1], "keypoints3D": [dict(p) for p in kps1],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]}, "leftHand": [], "rightHand": rh_lateral,
        }
        wire1 = to_wire(payload1, capture_hint=(640, 360))
        sh1 = wire1["keypoints"][12]
        el1 = wire1["keypoints"][14]

        # Elbow MUST be to the left of the shoulder (lateral, outward), NOT pulled inside across the chest!
        self.assertLessEqual(el1["x"], sh1["x"], "In lateral abduction, elbow must flare OUTWARD (ex <= sx), NEVER collapse into chest!")
        print("  ✓ Step 1: Lateral abduction verified: elbow (x=%.3f) flares outward relative to shoulder (x=%.3f)" % (el1["x"], sh1["x"]))

        # Pose 2: Cross-body reach (scratching opposite shoulder / touching chest)
        # Hand reaches across chest to x=360 (0.562, past shoulder at 0.359)
        rh_cross = [{"x": 360.0 / 640.0, "y": (130.0 + i) / 360.0, "z": 0.0,
                     "score": 0.85, "visibility": 0.85,
                     "position": {"x": 360.0, "y": 130.0 + i, "z": 0.0}} for i in range(21)]
        kps2 = make_dummy_keypoints(shoulder_y=150.0, elbow_xy=(200.0, 250.0), wrist_xy=(360.0, 130.0), wrist_score=0.85)
        kps2[12]["position"]["x"] = 230.0; kps2[12]["x"] = 230.0 / 640.0
        kps2[14]["score"] = 0.05

        payload2 = {
            "score": 0.90, "keypoints": [dict(p) for p in kps2], "keypoints3D": [dict(p) for p in kps2],
            "face": {"landmarks": [{"x": 300.0, "y": 90.0, "z": 0.0}]}, "leftHand": [], "rightHand": rh_cross,
        }
        wire2 = to_wire(payload2, capture_hint=(640, 360))
        sh2 = wire2["keypoints"][12]
        el2 = wire2["keypoints"][14]

        # Elbow MUST point towards sternum (medial, ex > sx) when reaching across chest!
        self.assertGreater(el2["x"], sh2["x"], "When reaching across chest, elbow must naturally fold towards sternum (ex > sx)!")
        print("  ✓ Step 2: Cross-body reach verified: elbow (x=%.3f) folds naturally towards sternum (sh_x=%.3f)" % (el2["x"], sh2["x"]))


if __name__ == '__main__':
    unittest.main()


