#!/usr/bin/env python3
"""Generate high quality, lightweight GLB 2.0 models for props and stages.

Produces:
- props/cell_phone.glb
- props/cup.glb
- props/microphone.glb
- stages/default_stage.glb

Coordinates are in XR Animator world units (avatar height ~17 units, matching MMD/VRM scene scale):
- Avatar height: ~17 units (~1.7 meters, 1 unit = 10 cm)
- Floor: Y = 0.0
- Desk height: Y = 8.0
- Avatar facing: +Z
"""

import json
import math
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def pad_bytes(b, align=4):
    while len(b) % align != 0:
        b.append(0)
    return b


def build_scene_glb(parts):
    """Build a standard glTF 2.0 binary (.glb) containing multiple parts/materials."""
    accessors = []
    buffer_views = []
    meshes = []
    materials = []
    nodes = []
    total_bin = bytearray()

    for i, p in enumerate(parts):
        v_bytes = bytearray()
        min_pos = [float("inf")] * 3
        max_pos = [float("-inf")] * 3
        for v in p["vertices"]:
            for j in range(3):
                min_pos[j] = min(min_pos[j], v[j])
                max_pos[j] = max(max_pos[j], v[j])
            v_bytes += struct.pack("<fff", *v)
        v_bytes = pad_bytes(v_bytes)

        n_bytes = bytearray()
        for n in p["normals"]:
            n_bytes += struct.pack("<fff", *n)
        n_bytes = pad_bytes(n_bytes)

        i_bytes = bytearray()
        min_idx = min(p["indices"]) if p["indices"] else 0
        max_idx = max(p["indices"]) if p["indices"] else 0
        for idx in p["indices"]:
            i_bytes += struct.pack("<H", idx)
        i_bytes = pad_bytes(i_bytes)

        offset_v = len(total_bin)
        total_bin += v_bytes
        offset_n = len(total_bin)
        total_bin += n_bytes
        offset_i = len(total_bin)
        total_bin += i_bytes

        bv_v = len(buffer_views)
        buffer_views.append({"buffer": 0, "byteOffset": offset_v, "byteLength": len(v_bytes), "target": 34962})
        bv_n = len(buffer_views)
        buffer_views.append({"buffer": 0, "byteOffset": offset_n, "byteLength": len(n_bytes), "target": 34962})
        bv_i = len(buffer_views)
        buffer_views.append({"buffer": 0, "byteOffset": offset_i, "byteLength": len(i_bytes), "target": 34963})

        acc_v = len(accessors)
        accessors.append({"bufferView": bv_v, "byteOffset": 0, "componentType": 5126, "count": len(p["vertices"]), "type": "VEC3", "min": min_pos, "max": max_pos})
        acc_n = len(accessors)
        accessors.append({"bufferView": bv_n, "byteOffset": 0, "componentType": 5126, "count": len(p["normals"]), "type": "VEC3"})
        acc_i = len(accessors)
        accessors.append({"bufferView": bv_i, "byteOffset": 0, "componentType": 5123, "count": len(p["indices"]), "type": "SCALAR", "min": [min_idx], "max": [max_idx]})

        mat_idx = len(materials)
        materials.append({
            "name": p.get("name", f"Material_{i}"),
            "pbrMetallicRoughness": {
                "baseColorFactor": list(p.get("color", (0.8, 0.8, 0.8, 1.0))),
                "metallicFactor": p.get("metallic", 0.1),
                "roughnessFactor": p.get("roughness", 0.5),
            },
            "doubleSided": True,
        })

        mesh_idx = len(meshes)
        meshes.append({
            "name": p.get("name", f"Mesh_{i}"),
            "primitives": [{
                "attributes": {"POSITION": acc_v, "NORMAL": acc_n},
                "indices": acc_i,
                "material": mat_idx,
            }]
        })

        nodes.append({"mesh": mesh_idx, "name": p.get("name", f"Node_{i}")})

    total_bin = pad_bytes(total_bin)

    gltf_dict = {
        "asset": {"version": "2.0", "generator": "XR-Animator-Studio-Builder"},
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "materials": materials,
        "meshes": meshes,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(total_bin)}],
    }

    json_bytes = bytearray(json.dumps(gltf_dict, separators=(",", ":")).encode("utf-8"))
    while len(json_bytes) % 4 != 0:
        json_bytes.append(0x20)

    magic = 0x46546C67
    version = 2
    total_len = 12 + 8 + len(json_bytes) + 8 + len(total_bin)
    header = struct.pack("<III", magic, version, total_len)
    chunk0_header = struct.pack("<II", len(json_bytes), 0x4E4F534A)
    chunk1_header = struct.pack("<II", len(total_bin), 0x004E4942)

    return header + chunk0_header + json_bytes + chunk1_header + total_bin


def make_box(dx, dy, dz, offset=(0, 0, 0)):
    ox, oy, oz = offset
    hx, hy, hz = dx / 2, dy / 2, dz / 2
    faces = [
        ([(-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)], (0, 0, 1)),
        ([(hx, -hy, -hz), (-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz)], (0, 0, -1)),
        ([(hx, -hy, hz), (hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz)], (1, 0, 0)),
        ([(-hx, -hy, -hz), (-hx, -hy, hz), (-hx, hy, hz), (-hx, -hy, -hz)], (-1, 0, 0)),
        ([(-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz), (-hx, hy, -hz)], (0, 1, 0)),
        ([(-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz), (-hx, -hy, hz)], (0, -1, 0)),
    ]
    vertices, normals, indices = [], [], []
    idx = 0
    for quad, norm in faces:
        for p in quad:
            vertices.append((p[0] + ox, p[1] + oy, p[2] + oz))
            normals.append(norm)
        indices.extend([idx, idx + 1, idx + 2, idx, idx + 2, idx + 3])
        idx += 4
    return vertices, normals, indices


def make_cylinder(r_top, r_bot, height, segments=20, offset=(0, 0, 0)):
    ox, oy, oz = offset
    vertices, normals, indices = [], [], []
    half_h = height / 2

    # Side faces
    for i in range(segments):
        theta1 = 2 * math.pi * i / segments
        theta2 = 2 * math.pi * (i + 1) / segments

        x1_t, z1_t = r_top * math.cos(theta1), r_top * math.sin(theta1)
        x2_t, z2_t = r_top * math.cos(theta2), r_top * math.sin(theta2)
        x1_b, z1_b = r_bot * math.cos(theta1), r_bot * math.sin(theta1)
        x2_b, z2_b = r_bot * math.cos(theta2), r_bot * math.sin(theta2)

        n1 = (math.cos(theta1), 0, math.sin(theta1))
        n2 = (math.cos(theta2), 0, math.sin(theta2))

        base_idx = len(vertices)
        vertices.extend([
            (x1_b + ox, -half_h + oy, z1_b + oz),
            (x2_b + ox, -half_h + oy, z2_b + oz),
            (x2_t + ox, half_h + oy, z2_t + oz),
            (x1_t + ox, half_h + oy, z1_t + oz),
        ])
        normals.extend([n1, n2, n2, n1])
        indices.extend([base_idx, base_idx + 1, base_idx + 2, base_idx, base_idx + 2, base_idx + 3])

    # Bottom disc
    bot_center = len(vertices)
    vertices.append((ox, -half_h + oy, oz))
    normals.append((0, -1, 0))
    for i in range(segments):
        th = 2 * math.pi * i / segments
        vertices.append((r_bot * math.cos(th) + ox, -half_h + oy, r_bot * math.sin(th) + oz))
        normals.append((0, -1, 0))
    for i in range(segments):
        idx1 = bot_center + 1 + i
        idx2 = bot_center + 1 + ((i + 1) % segments)
        indices.extend([bot_center, idx2, idx1])

    # Top disc
    top_center = len(vertices)
    vertices.append((ox, half_h + oy, oz))
    normals.append((0, 1, 0))
    for i in range(segments):
        th = 2 * math.pi * i / segments
        vertices.append((r_top * math.cos(th) + ox, half_h + oy, r_top * math.sin(th) + oz))
        normals.append((0, 1, 0))
    for i in range(segments):
        idx1 = top_center + 1 + i
        idx2 = top_center + 1 + ((i + 1) % segments)
        indices.extend([top_center, idx1, idx2])

    return vertices, normals, indices


def merge_geometries(geom_list):
    all_v, all_n, all_i = [], [], []
    offset = 0
    for v, n, idxs in geom_list:
        all_v.extend(v)
        all_n.extend(n)
        for i in idxs:
            all_i.append(i + offset)
        offset += len(v)
    return all_v, all_n, all_i


def main():
    props_dir = ROOT / "props"
    stages_dir = ROOT / "stages"
    props_dir.mkdir(parents=True, exist_ok=True)
    stages_dir.mkdir(parents=True, exist_ok=True)

    # -------------------------------------------------------------
    # 1. Cell Phone (Realistic dimensions in XR Animator units: 7.5cm x 15.5cm x 8mm)
    # -------------------------------------------------------------
    phone_body_v, phone_body_n, phone_body_i = make_box(0.75, 1.55, 0.08)
    phone_screen_v, phone_screen_n, phone_screen_i = make_box(0.70, 1.45, 0.01, offset=(0, 0, 0.041))
    phone_cam_v, phone_cam_n, phone_cam_i = make_box(0.25, 0.30, 0.03, offset=(-0.20, 0.55, -0.045))

    phone_glb = build_scene_glb([
        {
            "name": "PhoneBody",
            "vertices": phone_body_v,
            "normals": phone_body_n,
            "indices": phone_body_i,
            "color": (0.16, 0.18, 0.22, 1.0),
            "metallic": 0.5,
            "roughness": 0.35,
        },
        {
            "name": "PhoneScreen",
            "vertices": phone_screen_v,
            "normals": phone_screen_n,
            "indices": phone_screen_i,
            "color": (0.05, 0.07, 0.10, 1.0),
            "metallic": 0.1,
            "roughness": 0.05,
        },
        {
            "name": "PhoneCameraBump",
            "vertices": phone_cam_v,
            "normals": phone_cam_n,
            "indices": phone_cam_i,
            "color": (0.10, 0.10, 0.12, 1.0),
            "metallic": 0.7,
            "roughness": 0.25,
        },
    ])
    (props_dir / "cell_phone.glb").write_bytes(phone_glb)
    print(f"Created {props_dir / 'cell_phone.glb'} ({len(phone_glb)} bytes)")

    # -------------------------------------------------------------
    # 2. Coffee Cup (8.4cm diameter x 10.5cm height)
    # -------------------------------------------------------------
    cup_body = make_cylinder(0.42, 0.36, 1.05, segments=24)
    cup_handle = make_box(0.14, 0.50, 0.28, offset=(0.48, 0.0, 0))
    cup_v, cup_n, cup_i = merge_geometries([cup_body, cup_handle])
    coffee_v, coffee_n, coffee_i = make_cylinder(0.38, 0.38, 0.04, segments=20, offset=(0, 0.42, 0))

    cup_glb = build_scene_glb([
        {
            "name": "CupCeramic",
            "vertices": cup_v,
            "normals": cup_n,
            "indices": cup_i,
            "color": (0.92, 0.92, 0.96, 1.0),
            "metallic": 0.05,
            "roughness": 0.2,
        },
        {
            "name": "CoffeeSurface",
            "vertices": coffee_v,
            "normals": coffee_n,
            "indices": coffee_i,
            "color": (0.18, 0.10, 0.06, 1.0),
            "metallic": 0.1,
            "roughness": 0.3,
        },
    ])
    (props_dir / "cup.glb").write_bytes(cup_glb)
    print(f"Created {props_dir / 'cup.glb'} ({len(cup_glb)} bytes)")

    # -------------------------------------------------------------
    # 3. Dynamic Microphone (19cm total length)
    # -------------------------------------------------------------
    mic_handle_v, mic_handle_n, mic_handle_i = make_cylinder(0.17, 0.13, 1.25, segments=20, offset=(0, -0.35, 0))
    mic_ring_v, mic_ring_n, mic_ring_i = make_cylinder(0.19, 0.19, 0.08, segments=20, offset=(0, 0.30, 0))
    mic_grill_v, mic_grill_n, mic_grill_i = make_cylinder(0.26, 0.21, 0.60, segments=20, offset=(0, 0.65, 0))

    mic_glb = build_scene_glb([
        {
            "name": "MicHandle",
            "vertices": mic_handle_v,
            "normals": mic_handle_n,
            "indices": mic_handle_i,
            "color": (0.18, 0.18, 0.20, 1.0),
            "metallic": 0.2,
            "roughness": 0.5,
        },
        {
            "name": "MicRing",
            "vertices": mic_ring_v,
            "normals": mic_ring_n,
            "indices": mic_ring_i,
            "color": (0.35, 0.35, 0.38, 1.0),
            "metallic": 0.8,
            "roughness": 0.2,
        },
        {
            "name": "MicGrill",
            "vertices": mic_grill_v,
            "normals": mic_grill_n,
            "indices": mic_grill_i,
            "color": (0.75, 0.75, 0.80, 1.0),
            "metallic": 0.7,
            "roughness": 0.25,
        },
    ])
    (props_dir / "microphone.glb").write_bytes(mic_glb)
    print(f"Created {props_dir / 'microphone.glb'} ({len(mic_glb)} bytes)")

    # -------------------------------------------------------------
    # 4. Default Stage: Floor (Y=0), Desk (in front at Z=3.5, top Y=8.0),
    #    and Studio Back Wall (Z=-7.0, Y up to 24.0).
    # -------------------------------------------------------------
    # Floor: top surface at Y=0.0
    floor_v, floor_n, floor_i = make_box(40.0, 0.4, 40.0, offset=(0, -0.2, 0))

    # Desk Top: surface at Y=8.0 (thickness 0.4, offset Y=7.8, Z=3.5)
    desk_top_v, desk_top_n, desk_top_i = make_box(16.0, 0.4, 5.5, offset=(0, 7.8, 3.5))

    # Desk Base (Leg panels + Front modesty panel)
    desk_leg_l = make_box(0.5, 7.6, 4.5, offset=(-7.2, 3.8, 3.5))
    desk_leg_r = make_box(0.5, 7.6, 4.5, offset=(7.2, 3.8, 3.5))
    desk_modesty = make_box(13.9, 5.0, 0.2, offset=(0, 4.5, 4.8))
    desk_base_v, desk_base_n, desk_base_i = merge_geometries([desk_leg_l, desk_leg_r, desk_modesty])

    # Studio Acoustic Back Wall (Z=-7.0)
    wall_main = make_box(36.0, 22.0, 0.4, offset=(0, 11.0, -7.0))
    wall_slat_l = make_box(8.0, 18.0, 0.3, offset=(-10.0, 11.0, -6.7))
    wall_slat_r = make_box(8.0, 18.0, 0.3, offset=(10.0, 11.0, -6.7))
    wall_v, wall_n, wall_i = merge_geometries([wall_main])
    slats_v, slats_n, slats_i = merge_geometries([wall_slat_l, wall_slat_r])

    stage_glb = build_scene_glb([
        {
            "name": "StudioFloor",
            "vertices": floor_v,
            "normals": floor_n,
            "indices": floor_i,
            "color": (0.18, 0.18, 0.21, 1.0),
            "metallic": 0.1,
            "roughness": 0.6,
        },
        {
            "name": "DeskTopWalnut",
            "vertices": desk_top_v,
            "normals": desk_top_n,
            "indices": desk_top_i,
            "color": (0.34, 0.24, 0.18, 1.0),
            "metallic": 0.05,
            "roughness": 0.4,
        },
        {
            "name": "DeskBaseDark",
            "vertices": desk_base_v,
            "normals": desk_base_n,
            "indices": desk_base_i,
            "color": (0.15, 0.15, 0.17, 1.0),
            "metallic": 0.3,
            "roughness": 0.5,
        },
        {
            "name": "BackWallAcoustic",
            "vertices": wall_v,
            "normals": wall_n,
            "indices": wall_i,
            "color": (0.13, 0.16, 0.22, 1.0),
            "metallic": 0.05,
            "roughness": 0.8,
        },
        {
            "name": "AcousticWoodSlats",
            "vertices": slats_v,
            "normals": slats_n,
            "indices": slats_i,
            "color": (0.42, 0.28, 0.18, 1.0),
            "metallic": 0.05,
            "roughness": 0.5,
        },
    ])
    (stages_dir / "default_stage.glb").write_bytes(stage_glb)
    print(f"Created {stages_dir / 'default_stage.glb'} ({len(stage_glb)} bytes)")


if __name__ == "__main__":
    main()
