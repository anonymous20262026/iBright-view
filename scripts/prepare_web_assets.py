#!/usr/bin/env python3
"""Build compact web PLYs (SH0 only) and copy images/videos into webpage/assets."""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "ibright-gs-webpage-assets"
BASELINES = ROOT / "ibright-gs-webpage-baselines"
WEB = ROOT / "webpage" / "assets"

SCENES = ["sofa", "bike", "BlueHawaii", "Cupcake", "Sculpture", "GearWorks"]
MAX_VERTS = 340_000
MAX_MB = 88.0


def parse_ply(path: Path):
    with open(path, "rb") as f:
        header_lines = []
        while True:
            line = f.readline()
            header_lines.append(line)
            if line.strip() == b"end_header":
                break
        header = b"".join(header_lines).decode("ascii")
        n = int([ln for ln in header.splitlines() if ln.startswith("element vertex")][0].split()[2])
        props = []
        for ln in header.splitlines():
            if ln.startswith("property "):
                parts = ln.split()
                props.append((parts[1], parts[2]))
        dtype = np.dtype([(name, "<f4" if typ == "float" else "<i4") for typ, name in props])
        data = np.frombuffer(f.read(n * dtype.itemsize), dtype=dtype)
    return data


def write_ply(path: Path, data: np.ndarray, names: list[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    out = np.empty(len(data), dtype=np.dtype([(n, "<f4") for n in names]))
    for n in names:
        out[n] = data[n]
    with open(path, "wb") as f:
        hdr = ["ply", "format binary_little_endian 1.0", f"element vertex {len(data)}"]
        for n in names:
            hdr.append(f"property float {n}")
        hdr.append("end_header")
        f.write(("\n".join(hdr) + "\n").encode("ascii"))
        f.write(out.tobytes())


WEB_FIELDS = [
    "x", "y", "z",
    "f_dc_0", "f_dc_1", "f_dc_2",
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
]


def cull_floaters(data: np.ndarray) -> np.ndarray:
    xyz = np.stack([data["x"], data["y"], data["z"]], 1).astype(np.float64)
    center = np.median(xyz, axis=0)
    dist = np.linalg.norm(xyz - center, axis=1)
    radius = float(np.percentile(dist, 99.2))
    keep = dist < max(radius * 1.2, 1.15)
    scale = np.stack([data["scale_0"], data["scale_1"], data["scale_2"]], 1)
    keep &= scale.max(axis=1) < np.percentile(scale.max(axis=1), 99.7)
    return data[keep]


def convert_ply(src: Path, dst: Path, max_verts: int = MAX_VERTS):
    data = cull_floaters(parse_ply(src))
    names = [n for n in data.dtype.names]
    bytes_per = max(len(names), 1) * 4
    cap = min(max_verts, int(MAX_MB * 1e6 / bytes_per))
    if len(data) > cap:
        rng = np.random.default_rng(0)
        data = data[rng.choice(len(data), size=cap, replace=False)]
    write_ply(dst, data, names)
    return len(data), dst.stat().st_size


def camera_from_scene(meta_path: Path, ply_path: Path, scene: str) -> dict:
    data = cull_floaters(parse_ply(ply_path))
    xyz = np.stack([data["x"], data["y"], data["z"]], 1).astype(np.float64)
    center = np.median(xyz, axis=0)
    prefer = {"BlueHawaii": {"0025"}, "sofa": {"9"}, "bike": {"1", "9"}}
    want = prefer.get(scene, {"0009", "9"})
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    chosen = None
    for kf in meta.get("keyframes", []):
        stem = Path(kf.get("info", {}).get("name", "")).stem
        if stem in want:
            chosen = kf
            break
    if chosen is None:
        tests = [kf for kf in meta.get("keyframes", []) if kf.get("info", {}).get("is_test")]
        chosen = tests[0] if tests else meta["keyframes"][0]
    Rt = np.array(chosen["Rt"], dtype=np.float64)
    R, t = Rt[:3, :3], Rt[:3, 3]
    cam = -R.T @ t
    fwd = R.T @ np.array([0.0, 0.0, 1.0])
    cam = cam - fwd * 0.85
    look = cam + fwd * 2.4
    return {
        "position": cam.tolist(),
        "lookAt": look.tolist(),
        "up": [0.0, -1.0, 0.0],
    }


def copy_file(src: Path, dst: Path):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        return
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def main():
    cameras = {}
    ply_info = {}
    web_ply = WEB / "ply"
    web_ply.mkdir(parents=True, exist_ok=True)

    for scene in SCENES:
        src_dir = ASSETS / "ply" / scene
        meta = src_dir / "metadata.json"
        cameras[scene] = camera_from_scene(meta, src_dir / "hierarchy_enh_supersplat.ply", scene)
        copy_file(meta, web_ply / scene / "metadata.json")
        for kind, name in [("bright", "hierarchy_enh_supersplat.ply"), ("dark", "hierarchy_supersplat.ply")]:
            src = src_dir / name
            dst = web_ply / scene / f"{kind}.ply"
            n, size = convert_ply(src, dst)
            ply_info[f"{scene}/{kind}"] = {"vertices": n, "size_mb": round(size / 1e6, 2)}
            print(f"{scene}/{kind}: {n} verts, {size/1e6:.1f} MB")

    (WEB / "cameras.json").write_text(json.dumps(cameras, indent=2), encoding="utf-8")
    (WEB / "ply_manifest.json").write_text(json.dumps(ply_info, indent=2), encoding="utf-8")

    img_map = {
        "input_lowlight.jpg": (ASSETS, "input_lowlight.jpg"),
        "gt.jpg": (ASSETS, "gt.jpg"),
        "ours.jpg": (ASSETS, "ours.jpg"),
        "i3dgs.jpg": (ASSETS, "i3dgs.jpg"),
        "3dgs.jpg": (BASELINES, "3dgs.jpg"),
        "llgs.jpg": (BASELINES, "llgs.jpg"),
        "luminance-gs.jpg": (BASELINES, "luminance-gs.jpg"),
        "lita-gs.jpg": (BASELINES, "lita-gs.jpg"),
        "retinexgs.jpg": (BASELINES, "retinexgs.jpg"),
        "wo_bright_sh0.jpg": (ASSETS, "wo_bright_sh0.jpg"),
        "wo_freeze_geo.jpg": (ASSETS, "wo_freeze_geo.jpg"),
    }
    for scene in SCENES:
        for out_name, (root, fname) in img_map.items():
            src = root / "images" / scene / fname
            if src.is_file():
                copy_file(src, WEB / "images" / scene / out_name)

    video_dirs = [ASSETS / "videos", BASELINES / "videos"]
    out_v = WEB / "videos"
    out_v.mkdir(parents=True, exist_ok=True)
    for d in video_dirs:
        if not d.is_dir():
            continue
        for mp4 in d.glob("*.mp4"):
            copy_file(mp4, out_v / mp4.name)

    print("done")


if __name__ == "__main__":
    main()
