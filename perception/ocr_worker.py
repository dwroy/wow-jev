#!/usr/bin/env python3
"""Bounded resident local OCR, raw PNG only. No credentials, cloud or model downloads.
Install RapidOCR in a project-owned venv and supply a SHA-pinned local manifest.
"""
import argparse
import hashlib
import importlib.metadata
import io
import json
import math
from pathlib import Path
import re
import socket
import struct
import sys

MAX_LINE = 131072
MAX_IMAGE = 64 * 1024 * 1024
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SHA = re.compile(r"^[a-f0-9]{64}$")


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError("ocr_fields")


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValueError("ocr_identifier")


def integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("ocr_integer")
    return value


def safe_file(value, root, limit):
    path = Path(value)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("ocr_file_type")
    resolved = path.resolve()
    if not resolved.is_relative_to(root.resolve()) or path.stat().st_size > limit:
        raise ValueError("ocr_file_root_or_size")
    return resolved.read_bytes(), resolved


def validate_request(request, image_root):
    exact(request, ["version", "kind", "id", "frame_id", "source_observation_id", "captured_at_ms", "image_path", "image_sha256", "width", "height", "model_id", "regions"])
    if request["version"] != 1 or request["kind"] != "local-ocr-request":
        raise ValueError("ocr_request_kind")
    for key in ["id", "frame_id", "source_observation_id", "model_id"]:
        identifier(request[key])
    integer(request["captured_at_ms"], 0, 9007199254740991)
    width, height = integer(request["width"], 1, 65535), integer(request["height"], 1, 65535)
    if width * height > 64_000_000 or not SHA.fullmatch(request["image_sha256"]):
        raise ValueError("ocr_image_metadata")
    raw, path = safe_file(request["image_path"], image_root, MAX_IMAGE)
    if path.suffix.lower() != ".png" or raw[:8] != b"\x89PNG\r\n\x1a\n" or len(raw) < 24:
        raise ValueError("ocr_png_required")
    if hashlib.sha256(raw).hexdigest() != request["image_sha256"] or struct.unpack(">II", raw[16:24]) != (width, height):
        raise ValueError("ocr_image_hash_or_dimensions")
    regions = request["regions"]
    if not isinstance(regions, list) or not 1 <= len(regions) <= 16:
        raise ValueError("ocr_region_count")
    ids = set()
    for region in regions:
        exact(region, ["id", "roi", "content_sha256"])
        identifier(region["id"])
        if region["id"] in ids or not SHA.fullmatch(region["content_sha256"]):
            raise ValueError("ocr_region_id_or_hash")
        ids.add(region["id"])
        roi = region["roi"]
        exact(roi, ["x", "y", "width", "height"])
        x, y = integer(roi["x"], 0, width - 1), integer(roi["y"], 0, height - 1)
        w, h = integer(roi["width"], 1, width), integer(roi["height"], 1, height)
        if x + w > width or y + h > height or w * h > 1_000_000:
            raise ValueError("ocr_roi_bounds")
    return raw


class Worker:
    def __init__(self, project_root, image_root, manifest_path=None, engine_factory=None):
        self.project_root, self.image_root = Path(project_root).resolve(), Path(image_root).resolve()
        self.manifest_path = Path(manifest_path).resolve() if manifest_path else None
        self.engine_factory, self.engine = engine_factory, None
        self.manifest = None
        self.engine_version = None
        self.seen = set()
        self.cache = {}

    def load_engine(self, model_id):
        if self.engine is not None:
            if model_id != self.manifest["id"]:
                raise ValueError("ocr_model_mismatch")
            return
        if self.manifest_path is None:
            raise RuntimeError("ocr_model_unconfigured")
        raw, _ = safe_file(str(self.manifest_path), self.project_root, 65536)
        manifest = json.loads(raw)
        exact(manifest, ["version", "kind", "id", "engine", "engine_version", "architecture", "models"])
        if manifest["version"] != 1 or manifest["kind"] != "local-ocr-model" or manifest["engine"] != "rapidocr" or manifest["architecture"] not in ["PP-OCRv5", "PP-OCRv6"]:
            raise ValueError("ocr_model_manifest")
        identifier(manifest["id"])
        if model_id != manifest["id"] or not re.fullmatch(r"3\.9\.\d+", manifest["engine_version"]):
            raise ValueError("ocr_model_version")
        paths = {}
        for model in manifest["models"]:
            exact(model, ["role", "path", "sha256"])
            if model["role"] not in ["det", "rec", "cls"] or model["role"] in paths or not SHA.fullmatch(model["sha256"]):
                raise ValueError("ocr_model_role")
            candidate = self.manifest_path.parent / model["path"]
            model_raw, path = safe_file(str(candidate), self.manifest_path.parent, 512 * 1024 * 1024)
            if hashlib.sha256(model_raw).hexdigest() != model["sha256"]:
                raise ValueError("ocr_model_sha256")
            paths[model["role"]] = str(path)
        if not {"det", "rec"}.issubset(paths):
            raise ValueError("ocr_model_missing")
        if self.engine_factory:
            engine = self.engine_factory(paths)
        else:
            prefix = Path(sys.prefix).resolve()
            if sys.prefix == sys.base_prefix or not prefix.is_relative_to(self.project_root):
                raise RuntimeError("ocr_project_venv_required")
            try:
                version = importlib.metadata.version("rapidocr")
            except importlib.metadata.PackageNotFoundError as error:
                raise RuntimeError("rapidocr_dependency_missing") from error
            if version != manifest["engine_version"]:
                raise RuntimeError("rapidocr_version_mismatch")
            # Dependencies must use supplied files; prohibit network in this resident process.
            def no_network(*_args, **_kwargs):
                raise OSError("ocr_network_disabled")
            socket.socket.connect = no_network
            socket.create_connection = no_network
            try:
                from rapidocr import RapidOCR
                params = {"Det.model_path": paths["det"], "Rec.model_path": paths["rec"], "Global.use_cls": "cls" in paths}
                if "cls" in paths:
                    params["Cls.model_path"] = paths["cls"]
                engine = RapidOCR(params=params)
            except ImportError as error:
                raise RuntimeError("rapidocr_dependency_missing") from error
        self.engine, self.manifest, self.engine_version = engine, manifest, manifest["engine_version"]

    def process(self, request):
        result = {"version": 1, "kind": "local-ocr-result", "id": request.get("id", "invalid"), "frame_id": request.get("frame_id", "invalid"),
                  "image_sha256": request.get("image_sha256", "0" * 64), "model_id": request.get("model_id", "invalid"),
                  "engine_version": None, "status": "failed", "reason": "ocr_invalid_request", "regions": []}
        try:
            raw = validate_request(request, self.image_root)
            if request["id"] in self.seen or len(self.seen) >= 4096:
                raise ValueError("ocr_duplicate_or_capacity")
            self.seen.add(request["id"])
            self.load_engine(request["model_id"])
            try:
                from PIL import Image
                import numpy as np
            except ImportError as error:
                raise RuntimeError("ocr_image_dependency_missing") from error
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != "PNG" or image.size != (request["width"], request["height"]):
                    raise ValueError("ocr_decoded_image_metadata")
                rgb = image.convert("RGB")
                for region in request["regions"]:
                    r = region["roi"]
                    crop = rgb.crop((r["x"], r["y"], r["x"] + r["width"], r["y"] + r["height"]))
                    if hashlib.sha256(crop.tobytes()).hexdigest() != region["content_sha256"]:
                        raise ValueError("ocr_roi_sha256")
                    key = (request["model_id"], region["content_sha256"], r["width"], r["height"])
                    if key not in self.cache:
                        # RapidOCR expects BGR arrays, while ROI hashes are canonical RGB bytes.
                        output = self.engine(np.asarray(crop)[:, :, ::-1].copy())
                        boxes, txts, scores = getattr(output, "boxes", None), getattr(output, "txts", None), getattr(output, "scores", None)
                        lines = []
                        if boxes is not None and txts is not None and scores is not None:
                            if not (len(boxes) == len(txts) == len(scores) <= 256):
                                raise ValueError("ocr_output_lengths")
                            for box, text, score in zip(boxes, txts, scores):
                                points = [[float(v) for v in point] for point in box]
                                if len(points) != 4 or not isinstance(text, str) or len(text) > 4096 or not math.isfinite(float(score)) or not 0 <= float(score) <= 1:
                                    raise ValueError("ocr_output_format")
                                if any(len(point) != 2 or not all(math.isfinite(v) for v in point) or not 0 <= point[0] <= r["width"] or not 0 <= point[1] <= r["height"] for point in points):
                                    raise ValueError("ocr_output_bounds")
                                lines.append({"text": text, "confidence": float(score), "box": points})
                        if len(self.cache) >= 256:
                            self.cache.pop(next(iter(self.cache)))
                        self.cache[key] = lines
                    lines = self.cache[key]
                    result["regions"].append({**region, "status": "known" if lines else "unknown", "lines": lines})
            result.update(status="ok", reason="local_ocr_processed", engine_version=self.engine_version)
        except RuntimeError as error:
            result.update(status="unsupported", reason=str(error), regions=[])
        except (ValueError, TypeError, KeyError, OSError, json.JSONDecodeError) as error:
            result.update(status="failed", reason=str(error) if re.fullmatch(r"[a-z0-9_]+", str(error)) else "ocr_processing_failed", regions=[])
        except Exception:
            result.update(status="failed", reason="ocr_engine_failed", regions=[])
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--image-root", type=Path, required=True)
    parser.add_argument("--model-manifest", type=Path)
    args = parser.parse_args()
    worker = Worker(args.project_root, args.image_root, args.model_manifest)
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not line:
            break
        if len(line) > MAX_LINE or not line.endswith(b"\n"):
            # A corrupted transport is terminal; never treat fragments as subsequent requests.
            break
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("object_required")
            response = worker.process(request)
        except (ValueError, UnicodeDecodeError):
            response = {"version": 1, "kind": "local-ocr-result", "id": "invalid", "frame_id": "invalid", "image_sha256": "0" * 64,
                        "model_id": "invalid", "engine_version": None, "status": "failed", "reason": "ocr_invalid_json", "regions": []}
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_LINE:
            break
        sys.stdout.buffer.write(encoded + b"\n")
        sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
