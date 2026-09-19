"""Native MediaPipe inference dispatcher and browser wire normalization.

The backend intentionally supports only bundled MediaPipe Tasks:
HolisticLandmarker for full-body tracking and FaceLandmarker for face-only mode.
"""

from __future__ import annotations

import atexit
import math
import os
import threading
import time
from typing import Optional


def _write_debug_log(msg: str) -> None:
    log_file = os.environ.get("XRA_DEBUG_LOG")
    if log_file:
        try:
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(msg + "\n")
        except Exception:
            pass

import numpy as np

from . import native_mediapipe as _native
from . import registry


def to_wire(payload: dict, capture_hint: Optional[tuple[int, int]] = None) -> dict:
    """Build the explicit browser wire contract.

    2D landmarks are normalized image coordinates. 3D landmarks are bounded,
    hip-centred body/world units; pixel coordinates are never placed in the 3D
    fields consumed by the XR Animator stabilizer and IK.
    """
    if not payload:
        return {}

    def _float(value, fallback=0.0):
        try:
            result = float(value)
            return result if result == result and abs(result) != float("inf") else fallback
        except Exception:
            return fallback

    def _clamp(value, lo, hi):
        return max(lo, min(hi, _float(value)))

    def _pos(point):
        position = point.get("position") if isinstance(point, dict) else None
        return position if isinstance(position, dict) else (point if isinstance(point, dict) else {})

    source_2d = payload.get("keypoints") or []
    source_3d = payload.get("keypoints3D") or []
    width, height = capture_hint or (0, 0)
    width = _float(width)
    height = _float(height)
    if width <= 0 or height <= 0:
        max_x = max((_float(_pos(point).get("x")) for point in source_2d), default=1.0)
        max_y = max((_float(_pos(point).get("y")) for point in source_2d), default=1.0)
        width = max(abs(max_x), 1.0)
        height = max(abs(max_y), 1.0)

    def _r4(val, fallback=0.0):
        try:
            f = float(val)
            return round(f, 4) if f == f and abs(f) != float("inf") else fallback
        except Exception:
            return fallback

    def _normalized_point(point):
        position = _pos(point)
        x_raw = _float(position.get("x"))
        y_raw = _float(position.get("y"))
        z_raw = _float(position.get("z"))
        if abs(x_raw) <= 1.5 and abs(y_raw) <= 1.5 and width > 1.5:
            nx = _r4(x_raw)
            ny = _r4(y_raw)
            nz = _r4(z_raw)
        else:
            nx = _r4(x_raw / width)
            ny = _r4(y_raw / height)
            nz = _r4(z_raw / width)
        res = {"x": nx, "y": ny, "z": nz, "position": {"x": nx, "y": ny, "z": nz}}
        if isinstance(point, dict):
            for k in ("score", "visibility", "part", "name"):
                if k in point:
                    res[k] = _r4(point[k]) if k in ("score", "visibility") else point[k]
        return res

    keypoints = [_normalized_point(point) for point in source_2d]
    aspect = width / height

    def _norm_xy(index):
        if index >= len(keypoints):
            return 0.0, 0.0
        point = _pos(keypoints[index])
        return _float(point.get("x")), _float(point.get("y"))

    def _span(a, b):
        ax, ay = _norm_xy(a)
        bx, by = _norm_xy(b)
        return (((ax - bx) * aspect) ** 2 + (ay - by) ** 2) ** 0.5

    shoulder_span = _span(11, 12)
    hip_span = _span(23, 24)
    ls = _norm_xy(11); rs = _norm_xy(12); lh = _norm_xy(23); rh = _norm_xy(24)
    shoulder_mid = ((ls[0] + rs[0]) * 0.5 * aspect, (ls[1] + rs[1]) * 0.5)
    hip_mid_norm = ((lh[0] + rh[0]) * 0.5 * aspect, (lh[1] + rh[1]) * 0.5)
    torso_span = ((shoulder_mid[0] - hip_mid_norm[0]) ** 2
                  + (shoulder_mid[1] - hip_mid_norm[1]) ** 2) ** 0.5
    if shoulder_span > 0.01:
        torso_span = max(torso_span, shoulder_span * 1.25)

    def _score(point):
        if not isinstance(point, dict):
            return 0.5
        for key in ("score", "visibility", "confidence"):
            if key in point:
                return _clamp(point.get(key), 0.0, 1.0)
        return 0.5

    core_scores = [_score(keypoints[i]) if i < len(keypoints) else 0.0
                   for i in (11, 12, 23, 24)]
    core_score_min = min(core_scores) if core_scores else 0.0
    core_score_median = float(np.median(core_scores)) if core_scores else 0.0
    core_valid_count = sum(score >= 0.15 for score in core_scores)
    shoulder_scores = core_scores[:2]
    hip_scores = core_scores[2:]
    shoulders_confident = (
        len(shoulder_scores) == 2
        and min(shoulder_scores) >= 0.15
        and float(np.median(shoulder_scores)) >= 0.25
    )
    hips_confident = len(hip_scores) == 2 and min(hip_scores) >= 0.15
    reason = "ok"
    upper_body_only = False
    raw_face = payload.get("face") if isinstance(payload, dict) else None
    has_raw_face = bool(raw_face and (raw_face.get("landmarks") or raw_face.get("blendshapes")))
    # Human scale gate: prevents tracking tiny background hallucinations (e.g. 27px objects in room).
    # If face is detected, require at least 6.5% of frame width (~42px on 640w).
    # If no face is detected, require at least 10.0% of frame width (~64px on 640w).
    min_shoulder_span = 0.065 if has_raw_face else 0.100
    if len(keypoints) == 0 and has_raw_face:
        reason = "face_only"
    elif len(keypoints) != 33:
        reason = f"expected_33_got_{len(keypoints)}"
    elif not has_raw_face and (core_score_median < 0.50 or min(shoulder_scores) < 0.45 or shoulder_span < 0.14):
        # Empty room / exit gate: when the user leaves the camera, MediaPipe
        # often hallucinates an unnatural body on an empty chair or shadows.
        # If there is no face detected, require strict human torso criteria.
        reason = "no_human_subject"
    elif not shoulders_confident:
        reason = "low_shoulder_confidence"
    elif shoulder_span < min_shoulder_span:
        reason = "shoulder_span"
    elif not hips_confident or hip_span < 0.015:
        # Podcast framing commonly excludes the hips. tracker can then collapse
        # both hip landmarks onto one plausible-looking coordinate. Keep the
        # valid upper body live and explicitly suppress the invented lower body.
        reason = "upper_body_only"
        upper_body_only = True
    elif torso_span < 0.035:
        reason = "torso_span"

    declared_space = str(payload.get("keypoints3d_space") or "").strip().lower()
    body_metric_spaces = {"body_relative", "body_relative_m", "world", "world_m"}
    camera_metric_spaces = {"camera_m", "camera_mm"}
    already_body_space = declared_space in body_metric_spaces
    camera_space = declared_space in camera_metric_spaces
    camera_unit_scale = 0.001 if declared_space == "camera_mm" else 1.0

    raw_for_3d = source_3d if len(source_3d) == len(source_2d) else source_2d
    if raw_for_3d:
        if upper_body_only:
            # When hips are blind/unreliable (desk posture), derive origin from stable shoulder midpoint
            # projected plumb vertical down, preventing jumping hip noise from polluting all 3D joints.
            ls = _pos(raw_for_3d[11]) if len(raw_for_3d) > 12 else {"x": 0, "y": 0, "z": 0}
            rs = _pos(raw_for_3d[12]) if len(raw_for_3d) > 12 else ls
            smid_x = (_float(ls.get("x")) + _float(rs.get("x"))) * 0.5
            smid_y = (_float(ls.get("y")) + _float(rs.get("y"))) * 0.5
            smid_z = (_float(ls.get("z")) + _float(rs.get("z"))) * 0.5
            s_width = ((_float(rs.get("x")) - _float(ls.get("x")))**2 + (_float(rs.get("y")) - _float(ls.get("y")))**2)**0.5
            torso_h = max(0.15, s_width * 1.25)
            origin = {
                "x": smid_x,
                "y": smid_y + torso_h,
                "z": smid_z,
            }
        else:
            left_hip = _pos(raw_for_3d[23]) if len(raw_for_3d) > 24 else {"x": 0, "y": 0, "z": 0}
            right_hip = _pos(raw_for_3d[24]) if len(raw_for_3d) > 24 else left_hip
            origin = {
                axis: (_float(left_hip.get(axis)) + _float(right_hip.get(axis))) * 0.5
                for axis in ("x", "y", "z")
            }
    else:
        origin = {"x": 0.0, "y": 0.0, "z": 0.0}

    reference_pixels = shoulder_span * height
    if reference_pixels < 1.0:
        reference_pixels = hip_span * height
    if reference_pixels < 1.0:
        reference_pixels = max(height * 0.18, 1.0)
    metres_per_pixel = _clamp(0.36 / reference_pixels, 0.0001, 0.05)

    keypoints3d = []
    for index, point in enumerate(raw_for_3d):
        position = _pos(point)
        if already_body_space:
            x = _float(position.get("x"))
            y = _float(position.get("y"))
            z = _float(position.get("z"))
        elif camera_space:
            x = (_float(position.get("x")) - origin["x"]) * camera_unit_scale
            y = (_float(position.get("y")) - origin["y"]) * camera_unit_scale
            z = (_float(position.get("z")) - origin["z"]) * camera_unit_scale
        else:
            x = (_float(position.get("x")) - origin["x"]) * metres_per_pixel
            y = (_float(position.get("y")) - origin["y"]) * metres_per_pixel
            z = (_float(position.get("z")) - origin["z"]) * metres_per_pixel
        x = _r4(_clamp(x, -4.0, 4.0))
        y = _r4(_clamp(y, -4.0, 4.0))
        z = _r4(_clamp(z, -4.0, 4.0))
        score = _r4(_score(point))
        entry = dict(point) if isinstance(point, dict) else {}
        entry.update({"x": x, "y": y, "z": z, "score": score, "visibility": score})
        entry["position"] = {"x": x, "y": y, "z": z}
        keypoints3d.append(entry)

    def _normalise_group(group):
        return [_normalized_point(point) for point in (group or [])]

    face = payload.get("face")
    wire_face = {"landmarks": [], "blendshapes": {"native": {}}, "faceInViewConfidence": 0.95}
    if isinstance(face, dict):
        wire_face.update(face)
        if "faceInViewConfidence" not in wire_face or wire_face["faceInViewConfidence"] is None:
            wire_face["faceInViewConfidence"] = 0.95
        wire_face["landmarks"] = _normalise_group(face.get("landmarks"))
        blendshapes = face.get("blendshapes")
        if not isinstance(blendshapes, dict):
            blendshapes = {}
        else:
            blendshapes = dict(blendshapes)
        native = blendshapes.get("native")
        if isinstance(native, dict):
            blendshapes["native"] = {k: _r4(v) for k, v in native.items()}
        else:
            blendshapes["native"] = {}
        wire_face["blendshapes"] = blendshapes

    # -----------------------------------------------------------------------
    # Fase 2a – tracker confidence suppression + kinematic guard
    # XRA_JOINT_CONF_MIN (float, default 0.25): joints with score below this
    #   threshold are zeroed-out (score=0, position zeroed) instead of being
    #   sent with bogus coordinates that hallucinate limbs out of frame.
    # XRA_JOINT_KIN_MAX (float, default 0.55): maximum inter-joint distance
    #   as a fraction of torso_span. Pairs that exceed this limit have both
    #   endpoints suppressed.  Guards against tracker limb fold-in artefacts
    #   (e.g. elbow snapping to opposite shoulder when arm exits frame).
    # Both are env-var-only for now; UI controls can be added later.
    # -----------------------------------------------------------------------
    _CONF_MIN = getattr(ENGINE, "_min_joint_confidence", float(os.environ.get("XRA_JOINT_CONF_MIN", "0.25")))
    _KIN_MAX  = float(os.environ.get("XRA_JOINT_KIN_MAX",  "1.45"))

    def _suppress_joint(kp: dict) -> dict:
        out = dict(kp)
        out["score"] = 0.0
        out["visibility"] = 0.0
        # Preserve position coordinates so IK solver doesn't snap bone to (0,0,0) origin
        return out

    # Step 1: zero score on joints below confidence threshold.
    if _CONF_MIN > 0 and keypoints:
        keypoints = [
            kp if kp.get("score", 0.5) >= _CONF_MIN else _suppress_joint(kp)
            for kp in keypoints
        ]
        keypoints3d = [
            kp if keypoints[i].get("score", 0.5) > 0 else _suppress_joint(kp)
            for i, kp in enumerate(keypoints3d)
        ]

    active_hands: dict[str, bool] = {"leftHand": False, "rightHand": False}
    smart_arm_sync = getattr(ENGINE, "_smart_arm_sync", True)
    desk_guard_enabled = getattr(ENGINE, "_desk_wrist_guard", True)
    desk_thresh = getattr(ENGINE, "_desk_wrist_threshold", 0.50)

    for wrist_idx, hand_key in ((15, "leftHand"), (16, "rightHand")):
        hand_pts = payload.get(hand_key) or []
        has_active_hand = isinstance(hand_pts, list) and len(hand_pts) >= 21
        active_hands[hand_key] = has_active_hand

        if wrist_idx >= len(keypoints):
            continue

        sh_idx = 11 if wrist_idx == 15 else 12
        el_idx = 13 if wrist_idx == 15 else 14
        arm_active = False
        el_pos = None

        if sh_idx < len(keypoints) and el_idx < len(keypoints):
            sh_kp = keypoints[sh_idx]
            el_kp = keypoints[el_idx]
            w_kp = keypoints[wrist_idx]
            sh_sc = sh_kp.get("score", 0.0)
            el_sc = el_kp.get("score", 0.0)
            w_sc = w_kp.get("score", 0.0)
            el_pos = el_kp.get("position") or el_kp

            if not hasattr(ENGINE, "_arm_active_state"):
                ENGINE._arm_active_state = {15: False, 16: False}
            if not hasattr(ENGINE, "_arm_down_frames"):
                ENGINE._arm_down_frames = {15: 0, 16: 0}

            prev_active = ENGINE._arm_active_state.get(wrist_idx, False)

            if has_active_hand and isinstance(hand_pts, list) and len(hand_pts) >= 21:
                sh_pos = sh_kp.get("position") or sh_kp
                sx, sy = _float(sh_pos.get("x")), _float(sh_pos.get("y"))
                ex, ey = _float(el_pos.get("x")), _float(el_pos.get("y"))
                t_span = torso_span if torso_span > 0.02 else 0.25

                h_pt = hand_pts[0]
                norm_h = _normalized_point(h_pt)
                hx, hy, hz = norm_h["x"], norm_h["y"], norm_h["z"]
                dy_ew = hy - ey

                # Top-most point of the detected hand (fingertip or knuckle)
                hand_min_y = min(_float(_normalized_point(p).get("y", 1.0)) for p in hand_pts)

                # Schmitt Trigger Hysteresis for Hand Raising / Gesture Detection:
                # - When already active (prev_active=True): stay active down to y < 0.86 (or torso span + 10%)
                # - When entering from rest (prev_active=False): require hand above y < 0.75 (or shoulder + 85% torso)
                if prev_active:
                    is_hand_raised = bool(hand_min_y < (sy + t_span * 1.10) or hand_min_y < 0.86)
                else:
                    is_hand_raised = bool(hand_min_y < (sy + t_span * 0.95) or hand_min_y < 0.84 or dy_ew <= 0.0)

                # Anatomical wrist clamp: if landmark 0 plunges downward due to model noise,
                # keep it attached to the palm (MCP 9 is middle knuckle)
                if len(hand_pts) > 9:
                    mcp9 = _normalized_point(hand_pts[9])
                    mcp9_y = _float(mcp9.get("y", hy))
                    max_wrist_drop = max(0.12, t_span * 0.40)
                    if hy > mcp9_y + max_wrist_drop:
                        hy = _r4(mcp9_y + max_wrist_drop)
                    dy_ew = hy - ey

                if is_hand_raised:
                    # Hand is in the air / active zone: ALWAYS ACTIVE, never resting low!
                    arm_active = True
                    ENGINE._arm_down_frames[wrist_idx] = 0
                elif not desk_guard_enabled:
                    # Desk guard off: hand is deep at the very bottom edge (y >= 0.86)
                    is_resting_low = (dy_ew >= 0.04 and hy >= sy + t_span * 0.80) or (hy >= 0.88)
                    if prev_active:
                        if is_resting_low:
                            ENGINE._arm_down_frames[wrist_idx] = ENGINE._arm_down_frames.get(wrist_idx, 0) + 1
                            arm_active = bool(ENGINE._arm_down_frames[wrist_idx] < 6)
                        else:
                            arm_active = True
                            ENGINE._arm_down_frames[wrist_idx] = 0
                    else:
                        if is_resting_low:
                            arm_active = False
                            ENGINE._arm_down_frames[wrist_idx] = ENGINE._arm_down_frames.get(wrist_idx, 0) + 1
                        else:
                            arm_active = True
                            ENGINE._arm_down_frames[wrist_idx] = 0
                else:
                    # Desk guard on:
                    if prev_active:
                        if (dy_ew >= 0.02 and hy >= sy + t_span * 0.75) or hy >= 0.86:
                            ENGINE._arm_down_frames[wrist_idx] = ENGINE._arm_down_frames.get(wrist_idx, 0) + 1
                            arm_active = bool(ENGINE._arm_down_frames[wrist_idx] < 6)
                        else:
                            ENGINE._arm_down_frames[wrist_idx] = 0
                            arm_active = True
                    else:
                        if dy_ew <= 0.0 or hy <= sy + t_span * 0.75:
                            arm_active = True
                            ENGINE._arm_down_frames[wrist_idx] = 0
                        else:
                            arm_active = False

                if arm_active:
                    keypoints[wrist_idx] = {
                        "x": hx, "y": hy, "z": hz,
                        "score": 0.85, "visibility": 0.85,
                        "position": {"x": hx, "y": hy, "z": hz}
                    }

                    dist_sh = ((hx - sx) ** 2 * aspect ** 2 + (hy - sy) ** 2) ** 0.5
                    arm_len = t_span * 0.92
                    half_d = min(arm_len * 0.49, dist_sh * 0.5)
                    sagitta = max(0.04, (max(0.0, (arm_len * 0.50) ** 2 - half_d ** 2)) ** 0.5)

                    dist_se = ((ex - sx) ** 2 * aspect ** 2 + (ey - sy) ** 2) ** 0.5
                    if el_sc < 0.20 or dist_se > max(t_span * 2.2, 0.60):
                        side_sign = -1.0 if wrist_idx == 15 else 1.0
                        # Idea B: smooth anatomical triangular bend when elbow is occluded during active arm motion
                        mx = (sx + hx) * 0.5
                        my = (sy + hy) * 0.5
                        synth_el_x = _r4(mx + side_sign * (sagitta / aspect if aspect > 0 else sagitta))
                        synth_el_y = _r4(max(sy + t_span * 0.16, my + t_span * 0.10))

                        keypoints[el_idx] = {
                            "x": synth_el_x, "y": synth_el_y, "z": hz,
                            "score": 0.55, "visibility": 0.55,
                            "position": {"x": synth_el_x, "y": synth_el_y, "z": hz}
                        }
                        el_pos = keypoints[el_idx]

                    # In 3D: anchor 3D wrist relative to 3D elbow along the forearm direction towards the hand.
                    if wrist_idx < len(keypoints3d) and el_idx < len(keypoints3d):
                        el_3d = keypoints3d[el_idx]
                        # If 3D elbow is occluded or suppressed, anchor it naturally:
                        if _float(el_3d.get("score", 0.0)) < 0.20 and sh_idx < len(keypoints3d):
                            sh_3d = keypoints3d[sh_idx]
                            side_sign = -1.0 if wrist_idx == 15 else 1.0
                            mx3 = _float(sh_3d.get("x", 0.0)) + side_sign * max(0.06, sagitta * 0.7)
                            my3 = _float(sh_3d.get("y", 0.0)) + max(0.12, (hy - sy) * 0.55)
                            mz3 = _float(sh_3d.get("z", 0.0)) - 0.04
                            el_3d = {
                                "x": _r4(mx3), "y": _r4(my3), "z": _r4(mz3),
                                "score": 0.55, "visibility": 0.55,
                                "position": {"x": 0.0, "y": 0.0, "z": 0.0}
                            }
                            el_3d["position"] = {"x": el_3d["x"], "y": el_3d["y"], "z": el_3d["z"]}
                            keypoints3d[el_idx] = el_3d

                        ex = _float(el_pos.get("x"))
                        ey = _float(el_pos.get("y"))
                        dx_h = (hx - ex) * aspect
                        dy_h = hy - ey
                        len_h = max(0.001, (dx_h * dx_h + dy_h * dy_h) ** 0.5)
                        p3d_x = _r4(_float(el_3d.get("x", 0.0)) + (dx_h / len_h) * 0.25)
                        p3d_y = _r4(_float(el_3d.get("y", 0.0)) + (dy_h / len_h) * 0.25)
                        p3d_z = _r4(_float(el_3d.get("z", 0.0)) - 0.08)
                        keypoints3d[wrist_idx] = {
                            "x": p3d_x, "y": p3d_y, "z": p3d_z,
                            "score": 0.85, "visibility": 0.85,
                            "position": {"x": p3d_x, "y": p3d_y, "z": p3d_z}
                        }
                else:
                    # Hand is resting low downwards: keep arm calm at rest
                    side_sign = -1.0 if wrist_idx == 15 else 1.0
                    dist_se = ((ex - sx) ** 2 * aspect ** 2 + (ey - sy) ** 2) ** 0.5
                    if el_sc < 0.20 or dist_se > max(t_span * 2.2, 0.60):
                        synth_el_x = _r4(sx + side_sign * 0.04)
                        synth_el_y = _r4(sy + t_span * 0.50)
                        keypoints[el_idx] = {
                            "x": synth_el_x, "y": synth_el_y, "z": hz,
                            "score": 0.55, "visibility": 0.55,
                            "position": {"x": synth_el_x, "y": synth_el_y, "z": hz}
                        }
                        el_pos = keypoints[el_idx]
                    keypoints[wrist_idx] = {
                        "x": _r4(sx + side_sign * 0.05),
                        "y": _r4(sy + t_span * 0.85),
                        "z": hz,
                        "score": 0.55, "visibility": 0.55,
                        "position": {"x": _r4(sx + side_sign * 0.05), "y": _r4(sy + t_span * 0.85), "z": hz}
                    }
                    if wrist_idx < len(keypoints3d):
                        keypoints3d[wrist_idx] = {
                            "x": _r4(sx + side_sign * 0.05),
                            "y": _r4(sy + t_span * 0.85),
                            "z": 0.0,
                            "score": 0.55, "visibility": 0.55,
                            "position": {"x": _r4(sx + side_sign * 0.05), "y": _r4(sy + t_span * 0.85), "z": 0.0}
                        }
            elif sh_sc >= 0.18 and el_sc >= 0.18:
                sh_pos = sh_kp.get("position") or sh_kp
                w_pos = w_kp.get("position") or w_kp
                dx_se = _float(el_pos.get("x")) - _float(sh_pos.get("x"))
                dy_se = _float(el_pos.get("y")) - _float(sh_pos.get("y"))
                dy_ew = _float(w_pos.get("y")) - _float(el_pos.get("y"))
                t_span = torso_span if torso_span > 0.02 else 0.25

                len_se = ((dx_se * aspect) ** 2 + dy_se ** 2) ** 0.5
                u_y = dy_se / (len_se if len_se > 0.001 else 1.0)
                u_x = abs(dx_se * aspect) / (len_se if len_se > 0.001 else 1.0)

                # 1. Upper arm raised above shoulder level:
                if dy_se <= 0.0:
                    if el_sc >= 0.30:
                        arm_active = True
                # 2. Forearm curled/raised upwards (hand at chin, scratch face, fist raised):
                elif dy_ew <= -t_span * 0.12:
                    min_w_sc = 0.38 if not has_active_hand else 0.25
                    if w_sc >= min_w_sc:
                        arm_active = True
                # 3. Upper arm raised horizontally/laterally (T-pose, reaching sideways):
                elif dy_se <= t_span * 0.25 and (u_x >= 0.50 or abs(dx_se) >= max(0.14, t_span * 0.50)):
                    if el_sc >= 0.30:
                        if dy_ew > 0.0 and w_sc < desk_thresh:
                            pass
                        else:
                            arm_active = True
                # 4. Raising arm outward/forward with occluded wrist from under desk (Test 20):
                elif dy_se <= t_span * 0.35 and u_x >= 0.60 and el_sc >= 0.35 and w_sc < 0.20:
                    arm_active = True

                debug_arm = os.environ.get("XRA_DEBUG_ARM", "0") in {"1", "true", "yes"}
                if debug_arm:
                    cur_w_pt = keypoints[wrist_idx] if wrist_idx < len(keypoints) else {}
                    cur_w_sc = _float(cur_w_pt.get("score", 0.0))
                    msg = f"[{time.strftime('%H:%M:%S')}.{int(time.time()*1000)%1000:03d}] [XRA_DEBUG_ARM] {hand_key}: arm_active={arm_active} w_sc={cur_w_sc:.2f} el_sc={el_sc:.2f} has_hand={has_active_hand}"
                    print(msg, flush=True)
                    _write_debug_log(msg)

                if smart_arm_sync:
                    if arm_active:
                        # If wrist is weak/occluded (< 0.35):
                        if w_sc < 0.35:
                            if len_se < 0.05:
                                len_se = t_span * 0.65
                            forearm_len = 0.85 * len_se

                            # Only project straight along shoulder->elbow when the upper arm itself is raised
                            # or reaching outward (not when elbow is down near desk):
                            if dy_se <= 0.0 or (u_y <= 0.80 and dy_se <= t_span * 0.40):
                                udir_x = dx_se / (len_se if len_se > 0 else 1.0)
                                udir_y = dy_se / (len_se if len_se > 0 else 1.0)

                                proj_x = _r4(_float(el_pos.get("x")) + udir_x * forearm_len / aspect)
                                proj_y = _r4(_float(el_pos.get("y")) + udir_y * forearm_len)
                                proj_z = _r4(_float(el_pos.get("z", 0.0)))
                                keypoints[wrist_idx] = {
                                    "x": proj_x, "y": proj_y, "z": proj_z,
                                    "score": 0.65, "visibility": 0.65,
                                    "position": {"x": proj_x, "y": proj_y, "z": proj_z}
                                }
                                if wrist_idx < len(keypoints3d) and el_idx < len(keypoints3d) and sh_idx < len(keypoints3d):
                                    el_3d = keypoints3d[el_idx]
                                    sh_3d = keypoints3d[sh_idx]
                                    dx3 = _float(el_3d.get("x", 0.0)) - _float(sh_3d.get("x", 0.0))
                                    dy3 = _float(el_3d.get("y", 0.0)) - _float(sh_3d.get("y", 0.0))
                                    dz3 = _float(el_3d.get("z", 0.0)) - _float(sh_3d.get("z", 0.0))
                                    len3 = max(0.001, (dx3 * dx3 + dy3 * dy3 + dz3 * dz3) ** 0.5)
                                    p3d_x = _r4(_float(el_3d.get("x", 0.0)) + (dx3 / len3) * 0.25)
                                    p3d_y = _r4(_float(el_3d.get("y", 0.0)) + (dy3 / len3) * 0.25)
                                    p3d_z = _r4(_float(el_3d.get("z", 0.0)) + (dz3 / len3) * 0.25)
                                    keypoints3d[wrist_idx] = {
                                        "x": p3d_x, "y": p3d_y, "z": p3d_z,
                                        "score": 0.65, "visibility": 0.65,
                                        "position": {"x": p3d_x, "y": p3d_y, "z": p3d_z}
                                    }
                    else:
                        # Arm at rest: continue forearm naturally DOWNWARDS following the elbow line.
                        if len_se < 0.05:
                            len_se = t_span * 0.65
                        forearm_len = 0.85 * len_se

                        # When arm is at rest:
                        # Desk guard suppresses weak phantom wrists (< desk_thresh) and occluded wrists (< 0.30)
                        is_phantom_desk_wrist = (desk_guard_enabled and w_sc < desk_thresh)
                        if is_phantom_desk_wrist or w_sc < 0.30:
                            udir_x = dx_se / (len_se if len_se > 0 else 1.0)
                            udir_y = max(0.40, dy_se / (len_se if len_se > 0 else 1.0))
                            proj_x = _r4(_float(el_pos.get("x")) + udir_x * (forearm_len * 0.70) / aspect)
                            proj_y = _r4(_float(el_pos.get("y")) + udir_y * forearm_len)
                            proj_z = _r4(_float(el_pos.get("z", 0.0)))
                            keypoints[wrist_idx] = {
                                "x": proj_x, "y": proj_y, "z": proj_z,
                                "score": 0.55, "visibility": 0.55,
                                "position": {"x": proj_x, "y": proj_y, "z": proj_z}
                            }
                            if wrist_idx < len(keypoints3d):
                                el_3d = keypoints3d[el_idx]
                                p3d_x = _r4(_float(el_3d.get("x", 0.0)) + udir_x * 0.20)
                                p3d_y = _r4(_float(el_3d.get("y", 0.0)) + udir_y * 0.25)
                                p3d_z = _r4(_float(el_3d.get("z", 0.0)))
                                keypoints3d[wrist_idx] = {
                                    "x": p3d_x, "y": p3d_y, "z": p3d_z,
                                    "score": 0.55, "visibility": 0.55,
                                    "position": {"x": p3d_x, "y": p3d_y, "z": p3d_z}
                                }

            ENGINE._arm_active_state[wrist_idx] = arm_active
            is_downward_desk_noise = False
            if has_active_hand and isinstance(hand_pts, list) and len(hand_pts) >= 21:
                h_y = _float(_normalized_point(hand_pts[0]).get("y", 1.0))
                is_downward_desk_noise = bool(not arm_active and h_y >= 0.86 and dy_ew >= 0.02)
            active_hands[hand_key] = bool(has_active_hand and not is_downward_desk_noise)

        if not arm_active and desk_guard_enabled and not has_active_hand:
            cur_w_pos = keypoints[wrist_idx].get("position") or keypoints[wrist_idx]
            w_score = keypoints[wrist_idx].get("score", 0.0)
            if (not smart_arm_sync and w_score < desk_thresh) or el_pos is None:
                keypoints[wrist_idx] = _suppress_joint(keypoints[wrist_idx])
                if wrist_idx < len(keypoints3d):
                    keypoints3d[wrist_idx] = _suppress_joint(keypoints3d[wrist_idx])
                if upper_body_only:
                    elbow_idx = 13 if wrist_idx == 15 else 14
                    if elbow_idx < len(keypoints) and keypoints[elbow_idx].get("score", 0.0) < 0.25:
                        keypoints[elbow_idx] = _suppress_joint(keypoints[elbow_idx])
                        if elbow_idx < len(keypoints3d):
                            keypoints3d[elbow_idx] = _suppress_joint(keypoints3d[elbow_idx])

    if upper_body_only:
        # Seated/desk framing: hips and legs are occluded. Suppress lower body joints (23..32)
        # with score=0.0 so the wireframe does NOT draw the ghost torso trapezoid, and the
        # avatar solver does NOT pull the arms inwards against narrow synthetic hips.
        for idx in range(23, min(33, len(keypoints))):
            keypoints[idx] = _suppress_joint(keypoints[idx])
            if idx < len(keypoints3d):
                keypoints3d[idx] = _suppress_joint(keypoints3d[idx])

    # Step 2: kinematic distance guard on adjacent body joints (2D normalized).
    # Only run when torso_span is reliable (geometry valid, core joints present).
    if _KIN_MAX > 0 and reason == "ok" and torso_span > 0.02 and keypoints:
        _max_dist = torso_span * _KIN_MAX
        # Pairs: (proximal_idx, distal_idx) in BlazePose-33 order.
        _kin_pairs: list[tuple[int, int]] = [
            (11, 13), (13, 15),  # L shoulder→elbow→wrist
            (12, 14), (14, 16),  # R shoulder→elbow→wrist
            (23, 25), (25, 27),  # L hip→knee→ankle
            (24, 26), (26, 28),  # R hip→knee→ankle
        ]
        for prox_i, dist_i in _kin_pairs:
            if prox_i >= len(keypoints) or dist_i >= len(keypoints):
                continue
            prox = keypoints[prox_i]
            dist = keypoints[dist_i]
            if dist_i in {15, 16}:
                hand_key = "leftHand" if dist_i == 15 else "rightHand"
                if payload.get(hand_key):
                    continue
            if prox.get("score", 0.5) <= 0 or dist.get("score", 0.5) <= 0:
                continue
            pp = prox.get("position") or prox
            dp = dist.get("position") or dist
            dx = (_float(pp.get("x")) - _float(dp.get("x"))) * (width / height)
            dy = _float(pp.get("y")) - _float(dp.get("y"))
            if (dx * dx + dy * dy) > (_max_dist * _max_dist):
                keypoints[dist_i] = _suppress_joint(keypoints[dist_i])
                if dist_i < len(keypoints3d):
                    keypoints3d[dist_i] = _suppress_joint(keypoints3d[dist_i])


    # Harmonize 3D wrists when hands are touching/meeting (prayer, clap, joined hands)
    if active_hands.get("leftHand") and active_hands.get("rightHand") and len(keypoints3d) > 16:
        l_pts = payload.get("leftHand") or []
        r_pts = payload.get("rightHand") or []
        if len(l_pts) > 0 and len(r_pts) > 0:
            l_wrist_2d = _normalized_point(l_pts[0])
            r_wrist_2d = _normalized_point(r_pts[0])
            dx_2d = (l_wrist_2d["x"] - r_wrist_2d["x"]) * aspect
            dy_2d = l_wrist_2d["y"] - r_wrist_2d["y"]
            dist_2d = (dx_2d * dx_2d + dy_2d * dy_2d) ** 0.5

            if dist_2d < 0.08:
                # Hands are meeting in 2D space. BlazePose 3D body pose has an artificial
                # ~15cm lateral separation bias between wrists. We interpolate 3D wrists
                # towards contact so palms can touch flush together.
                k_contact = max(0.0, min(1.0, 1.0 - (dist_2d / 0.08)))
                lw_3d = keypoints3d[15]
                rw_3d = keypoints3d[16]
                if lw_3d.get("score", 0.0) > 0 and rw_3d.get("score", 0.0) > 0:
                    mid_x = (_float(lw_3d.get("x")) + _float(rw_3d.get("x"))) * 0.5
                    mid_y = (_float(lw_3d.get("y")) + _float(rw_3d.get("y"))) * 0.5
                    mid_z = (_float(lw_3d.get("z")) + _float(rw_3d.get("z"))) * 0.5

                    # Hand palm thickness allowance: 4cm each side (8cm total separation)
                    target_lx = mid_x - 0.04
                    target_rx = mid_x + 0.04

                    mix = 0.75 * k_contact
                    new_lx = _r4(_float(lw_3d.get("x")) * (1.0 - mix) + target_lx * mix)
                    new_rx = _r4(_float(rw_3d.get("x")) * (1.0 - mix) + target_rx * mix)
                    new_y = _r4(_float(lw_3d.get("y")) * (1.0 - mix) + mid_y * mix)
                    new_z = _r4(_float(lw_3d.get("z")) * (1.0 - mix) + mid_z * mix)

                    lw_3d["x"] = new_lx
                    lw_3d["y"] = new_y
                    lw_3d["z"] = new_z
                    if "position" in lw_3d and isinstance(lw_3d["position"], dict):
                        lw_3d["position"].update({"x": new_lx, "y": new_y, "z": new_z})

                    rw_3d["x"] = new_rx
                    rw_3d["y"] = new_y
                    rw_3d["z"] = new_z
                    if "position" in rw_3d and isinstance(rw_3d["position"], dict):
                        rw_3d["position"].update({"x": new_rx, "y": new_y, "z": new_z})

    geom_valid = reason in {"ok", "upper_body_only", "face_only"}
    if not geom_valid:
        keypoints = []
        keypoints3d = []

    wire = {
        "empty": not geom_valid,
        "keypoints": keypoints,
        "keypoints3D": keypoints3d,
        "keypoints2d_space": "normalized",
        "keypoints3d_space": "body_relative",
        "geometry": {
            "valid": geom_valid,
            "reason": reason,
            "input_3d_space": declared_space or "pixel_relative",
            "converted_from_camera": camera_space,
            "core_score_min": core_score_min,
            "core_score_median": core_score_median,
            "core_valid_count": core_valid_count,
            "shoulder_span": shoulder_span,
            "hip_span": hip_span,
            "torso_span": torso_span,
            "max_abs_3d": max((max(abs(p["x"]), abs(p["y"]), abs(p["z"]))
                                for p in keypoints3d), default=0.0),
        },
        "face": wire_face,
        "leftHand": _normalise_group(payload.get("leftHand")) if active_hands.get("leftHand") else [],
        "rightHand": _normalise_group(payload.get("rightHand")) if active_hands.get("rightHand") else [],
        "leftHandWorld": payload.get("leftHandWorld", []) if active_hands.get("leftHand") else [],
        "rightHandWorld": payload.get("rightHandWorld", []) if active_hands.get("rightHand") else [],
    }
    # Fase 2b – raw hand landmarks for diagnostics (no smoothing/filtering).
    # Set XRA_RAW_HANDS_DEBUG=1 to include raw_hands in the wire payload.
    # Frontend can use this to distinguish data-level defects from adapter bugs.
    if os.environ.get("XRA_RAW_HANDS_DEBUG", "0").lower() in {"1", "true", "yes"}:
        wire["raw_hands"] = {
            "leftHand":  _normalise_group(payload.get("leftHand")),
            "rightHand": _normalise_group(payload.get("rightHand")),
        }

    return wire

# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Native MediaPipe dispatcher
# ---------------------------------------------------------------------------

class EngineDispatcher:
    """Serialized lifecycle for the bundled Holistic and Face task engines."""

    def __init__(self) -> None:
        self._engines = {
            "holistic": _native.HolisticTasksEngine(),
            "face": _native.FaceTasksEngine(),
        }
        self._mode = "holistic"
        self._active_native = None
        self._active_id: Optional[str] = None
        self._model_complexity = 1
        self._lifecycle_lock = threading.RLock()
        self._loading = False
        self._requested_id: Optional[str] = None
        self._last_error = ""
        self._generation = 0
        self._min_tracking_confidence = 0.50
        self._min_pose_confidence = 0.50
        self._min_face_confidence = 0.50
        self._min_joint_confidence = float(os.environ.get("XRA_JOINT_CONF_MIN", "0.25"))
        self._desk_wrist_guard = os.environ.get("XRA_DESK_WRIST_GUARD", "1") not in {"0", "false", "no", "off"}
        self._desk_wrist_threshold = float(os.environ.get("XRA_DESK_WRIST_THRESH", "0.50"))
        self._accelerated = os.environ.get("XRA_FORCE_CPU") != "1"
        self._hardware_mode = os.environ.get("XRA_HARDWARE_MODE", "Auto" if self._accelerated else "CPU")

    @staticmethod
    def _normalize_mode(value) -> str:
        return "face" if str(value or "").strip().lower() == "face" else "holistic"

    @property
    def ready(self) -> bool:
        return bool(not self._loading and self._active_native is not None
                    and self._active_native.ready)

    @property
    def model_id(self) -> Optional[str]:
        return self._active_id

    @property
    def provider(self) -> Optional[str]:
        if self._active_native is None:
            return None
        return f"Native/{self._active_native.name}"

    def status(self) -> dict:
        return {
            "ready": self.ready,
            "model": self._active_id,
            "provider": self.provider,
            "provider_human": getattr(self._active_native, "name", None),
            "model_complexity": self._model_complexity,
            "mode": self._mode,
            "loading": self._loading,
            "requested_model": self._requested_id,
            "generation": self._generation,
            "last_error": self._last_error,
            "accelerated": self._accelerated,
            "gpu_available": _native._check_gpu(),
            "gpu_name": _native._GPU_NAME,
            "hardware_mode": self._hardware_mode,
            "min_tracking_confidence": self._min_tracking_confidence,
            "min_pose_confidence": self._min_pose_confidence,
            "min_face_confidence": self._min_face_confidence,
            "min_joint_confidence": self._min_joint_confidence,
            "desk_wrist_guard": self._desk_wrist_guard,
            "desk_wrist_threshold": self._desk_wrist_threshold,
        }

    def _unload_all(self) -> None:
        for candidate in self._engines.values():
            if candidate.ready:
                candidate.unload()
        self._active_native = None
        self._active_id = None

    def _start_selected(self, model_id: str) -> dict:
        candidate = self._engines[self._mode]
        result = candidate.load(accelerated=self._accelerated)
        if not result.get("ok") and self._accelerated:
            print("[XRA_MP] GPU init failed at startup, falling back to CPU.", flush=True)
            self._accelerated = False
            result = candidate.load(accelerated=False)
        if not result.get("ok"):
            self._last_error = str(result.get("error") or "native load failed")
            return result
        self._active_native = candidate
        self._active_id = model_id
        self._last_error = ""
        return {"ok": True, **self.status(), "ready": True}

    def unload(self) -> None:
        with self._lifecycle_lock:
            self._loading = True
            self._requested_id = None
            try:
                self._unload_all()
                self._last_error = ""
                self._generation += 1
            finally:
                self._loading = False

    def load(self, model_id: str, model_complexity: Optional[int] = None, force: bool = False) -> dict:
        with self._lifecycle_lock:
            if (not force and model_id == self._active_id and self.ready
                    and (model_complexity is None
                         or int(model_complexity) == self._model_complexity)):
                return {"ok": True, "unchanged": True, **self.status()}

            self._loading = True
            self._requested_id = model_id
            self._last_error = ""
            try:
                if not model_id or model_id == registry.MEDIAPIPE_ID:
                    self._unload_all()
                    self._generation += 1
                    return {"ok": True, **self.status()}
                if model_id not in registry.REGISTRY:
                    raise ValueError(f"Unknown backend: {model_id}")
                if not registry.is_installed(model_id):
                    self._unload_all()
                    return {
                        "ok": False,
                        "error": "backend not installed",
                        "needs_download": True,
                        "model": model_id,
                    }
                if model_complexity is not None:
                    self._model_complexity = int(model_complexity)
                self._unload_all()
                result = self._start_selected(model_id)
                self._generation += 1
                return result
            except Exception as exc:
                self._last_error = str(exc)
                self._unload_all()
                return {"ok": False, "error": self._last_error, "model": model_id}
            finally:
                self._loading = False
                self._requested_id = None

    def configure_mode(self, value) -> dict:
        next_mode = self._normalize_mode(value)
        with self._lifecycle_lock:
            if next_mode == self._mode:
                return {"ok": True, "unchanged": True, **self.status()}

            previous_mode = self._mode
            active_id = self._active_id
            self._loading = True
            try:
                self._unload_all()
                self._mode = next_mode
                self._accelerated = (self._hardware_mode.lower() != "cpu")
                if active_id is None:
                    self._generation += 1
                    return {"ok": True, **self.status()}

                result = self._start_selected(active_id)
                if result.get("ok"):
                    self._generation += 1
                    return result

                switch_error = str(result.get("error") or "mode switch failed")
                self._unload_all()
                self._mode = previous_mode
                fallback = self._start_selected(active_id)
                self._generation += 1
                self._last_error = switch_error
                return {
                    "ok": False,
                    "error": switch_error,
                    "fallback_ready": bool(fallback.get("ok")),
                    **self.status(),
                }
            finally:
                self._loading = False

    def configure_hardware(self, mode: str) -> dict:
        with self._lifecycle_lock:
            self._hardware_mode = mode
            is_cpu = str(mode or "").strip().lower() == "cpu"
            if is_cpu:
                os.environ["XRA_FORCE_CPU"] = "1"
            else:
                os.environ.pop("XRA_FORCE_CPU", None)
            next_accel = not is_cpu
            if next_accel == self._accelerated:
                return {"ok": True, "unchanged": True, **self.status()}
            self._accelerated = next_accel
            if self._active_native is not None:
                # Hot-swap
                result = self._active_native.load(accelerated=self._accelerated)
                if not result.get("ok") and self._accelerated:
                    print("[XRA_MP] GPU init failed at runtime, falling back to CPU.", flush=True)
                    self._accelerated = False
                    result = self._active_native.load(accelerated=False)
                if not result.get("ok"):
                    self._last_error = str(result.get("error"))
                    return {"ok": False, "error": self._last_error, **self.status()}
            return {"ok": True, **self.status()}

    def configure_rates(self, **_) -> dict:
        return {"ok": True, "mode": self._mode}

    def configure_confidence(self, min_tracking=None, min_pose=None, min_face=None, min_joint=None, desk_wrist_guard=None, desk_wrist_thresh=None) -> dict:
        with self._lifecycle_lock:
            if min_tracking is not None:
                self._min_tracking_confidence = max(0.1, min(0.95, float(min_tracking)))
            if min_pose is not None:
                self._min_pose_confidence = max(0.1, min(0.95, float(min_pose)))
            if min_face is not None:
                self._min_face_confidence = max(0.1, min(0.95, float(min_face)))
            if min_joint is not None:
                self._min_joint_confidence = max(0.01, min(0.90, float(min_joint)))
            if desk_wrist_guard is not None:
                self._desk_wrist_guard = bool(desk_wrist_guard)
            if desk_wrist_thresh is not None:
                self._desk_wrist_threshold = max(0.1, min(0.95, float(desk_wrist_thresh)))
            for eng in self._engines.values():
                if hasattr(eng, "configure_confidence"):
                    eng.configure_confidence(
                        min_tracking=self._min_tracking_confidence,
                        min_pose=self._min_pose_confidence,
                        min_face=self._min_face_confidence,
                    )
            return {"ok": True, **self.status()}

    def infer(self, frame_bgr: np.ndarray) -> Optional[dict]:
        with self._lifecycle_lock:
            if self._loading or self._active_native is None:
                return None
            return self._active_native.infer(frame_bgr)


ENGINE = EngineDispatcher()
atexit.register(ENGINE.unload)
