#!/usr/bin/env python3
"""Derive a real JPEG crop from a SHA-verified mother PNG; no model calls."""
import hashlib
import io
import json
from pathlib import Path
import sys


def derive(plan, output):
    from PIL import Image
    parent = Path(plan["source"]["png_path"])
    if parent.is_symlink() or not parent.is_file() or parent.suffix.lower() != ".png" or parent.stat().st_size > 64 * 1024 * 1024:
        raise ValueError("crop_source_file")
    raw = parent.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n" or hashlib.sha256(raw).hexdigest() != plan["source"]["png_sha256"] or plan["output_format"] != "jpeg":
        raise ValueError("crop_source_hash_or_format")
    destination = Path(output)
    if not destination.is_absolute() or destination.suffix.lower() not in [".jpg", ".jpeg"]:
        raise ValueError("crop_jpeg_destination")
    r = plan["roi"]
    with Image.open(io.BytesIO(raw)) as image:
        if image.format != "PNG" or image.size != (plan["source"]["width"], plan["source"]["height"]):
            raise ValueError("crop_source_dimensions")
        if any(type(r[k]) is not int for k in ["x", "y", "width", "height"]) or r["x"] < 0 or r["y"] < 0 or r["width"] < 1 or r["height"] < 1 or r["x"]+r["width"] > image.width or r["y"]+r["height"] > image.height:
            raise ValueError("crop_roi_bounds")
        crop = image.convert("RGB").crop((r["x"],r["y"],r["x"]+r["width"],r["y"]+r["height"]))
        maximum=plan["resize_max_dimension"]
        if type(maximum) is not int or not 1 <= maximum <= 4096:
            raise ValueError("crop_resize_limit")
        crop.thumbnail((maximum,maximum))
        with destination.open("xb") as handle:
            crop.save(handle,format="JPEG",quality=90)
        result={"id":plan["id"],"path":str(destination),"sha256":hashlib.sha256(destination.read_bytes()).hexdigest(),"format":"jpeg","width":crop.width,"height":crop.height,"source":plan["source"],"roi":r,"mapping":{"origin_x":r["x"],"origin_y":r["y"],"scale_x":r["width"]/crop.width,"scale_y":r["height"]/crop.height},"prompt_version":plan["prompt_version"],"prompt_sha256":plan["prompt_sha256"]}
    return result


if __name__ == "__main__":
    if len(sys.argv)!=2:
        raise SystemExit("usage: region_image.py ABSOLUTE_JPEG_OUTPUT < crop-plan.json")
    payload=sys.stdin.buffer.read(65537)
    if len(payload)>65536:
        raise SystemExit("crop_plan_size")
    print(json.dumps(derive(json.loads(payload),sys.argv[1]),ensure_ascii=False))
