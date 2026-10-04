#!/usr/bin/env python3
"""Bounded, authenticated loopback gateway for a llama.cpp vision backend.

Video is uniformly sampled into ordered images, not a native video token stream.
No request media, prompts, model outputs or credentials are logged/persisted.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import hmac
import http.client
import io
import json
import math
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from PIL import Image, ImageOps

MODEL = "wow-vision-qwen"
MAX_BODY = 24 * 1024 * 1024
MAX_VIDEO_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_IMAGE_PIXELS = 4096 * 4096
MAX_FRAMES = 4
MAX_DURATION_MS = 12000
MAX_PROMPT_CHARS = 8192
MAX_RESPONSE = 1024 * 1024
REQUEST_TIMEOUT = 30.0
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


class Fault(Exception):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code
        super().__init__(code)


def strict_json(raw: bytes):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise Fault(400, "duplicate_json_key")
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(Fault(400, "nonfinite_json")))
    except (UnicodeError, ValueError, RecursionError):
        raise Fault(400, "invalid_json") from None


def bounded_b64(value, maximum: int) -> bytes:
    if not isinstance(value, str) or not value or len(value) > 4 * math.ceil(maximum / 3):
        raise Fault(413, "media_too_large")
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise Fault(400, "invalid_base64") from None
    if not raw or len(raw) > maximum:
        raise Fault(413, "media_too_large")
    return raw


def image_url(raw: bytes, edge: int) -> tuple[str, dict]:
    try:
        with Image.open(io.BytesIO(raw)) as source:
            if source.format not in {"JPEG", "PNG"} or getattr(source, "n_frames", 1) != 1:
                raise Fault(400, "unsupported_image")
            width, height = source.size
            if width < 8 or height < 8 or width * height > MAX_IMAGE_PIXELS or max(width, height) > 4096:
                raise Fault(413, "image_dimensions")
            source.load()
            im = ImageOps.exif_transpose(source).convert("RGB")
            im.thumbnail((edge, edge), Image.Resampling.LANCZOS)
            encoded = io.BytesIO()
            im.save(encoded, format="JPEG", quality=85)
            return "data:image/jpeg;base64," + base64.b64encode(encoded.getvalue()).decode(), {
                "source_sha256": hashlib.sha256(raw).hexdigest(),
                "source_width": width, "source_height": height,
                "input_width": im.width, "input_height": im.height,
            }
    except Fault:
        raise
    except (OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise Fault(400, "invalid_image") from None


def count_tokens(body: dict) -> int:
    value = body.get("max_tokens", 192)
    if type(value) is not int or not 1 <= value <= 256:
        raise Fault(400, "max_tokens_out_of_range")
    return value


def response_format(body: dict):
    value = body.get("response_format")
    if value is None:
        return None
    if value != {"type": "json_object"}:
        raise Fault(400, "unsupported_response_format")
    return value


def backend_payload(messages: list, body: dict) -> dict:
    payload = {"model": MODEL, "messages": messages, "max_tokens": count_tokens(body),
               "stream": False, "temperature": 0.1,
               "chat_template_kwargs": {"enable_thinking": False},
               "cache_prompt": False}
    fmt = response_format(body)
    if fmt is not None:
        payload["response_format"] = fmt
    return payload


def prepare_chat(body: dict) -> tuple[dict, dict]:
    allowed = {"model", "messages", "max_tokens", "stream", "temperature", "response_format",
               "chat_template_kwargs"}
    if set(body) - allowed or body.get("stream", False) is not False or body.get("model", MODEL) != MODEL:
        raise Fault(400, "unsupported_chat_options")
    count_tokens(body)
    response_format(body)
    # Clients cannot re-enable thinking, increase generation or bypass image bounds.
    if "chat_template_kwargs" in body and body["chat_template_kwargs"] != {"enable_thinking": False}:
        raise Fault(400, "thinking_must_be_disabled")
    if "temperature" in body and (isinstance(body["temperature"], bool) or
                                  not isinstance(body["temperature"], (float, int)) or
                                  not 0 <= body["temperature"] <= 1):
        raise Fault(400, "invalid_temperature")
    messages = body.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= 4:
        raise Fault(400, "invalid_messages")
    image_count = sum(1 for message in messages if isinstance(message, dict)
                      and isinstance(message.get("content"), list)
                      for item in message["content"] if isinstance(item, dict) and item.get("type") == "image_url")
    edge = 1280 if image_count == 1 else 768
    sanitized, metadata, chars = [], [], 0
    for message in messages:
        if not isinstance(message, dict) or set(message) != {"role", "content"} or message["role"] not in {"system", "user"}:
            raise Fault(400, "unsupported_message")
        content = message["content"]
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        if not isinstance(content, list) or not 1 <= len(content) <= 12:
            raise Fault(400, "invalid_content")
        clean = []
        for item in content:
            if not isinstance(item, dict):
                raise Fault(400, "invalid_content_item")
            if item.get("type") == "text" and set(item) == {"type", "text"} and isinstance(item["text"], str):
                chars += len(item["text"])
                clean.append(item)
            elif item.get("type") == "image_url" and set(item) == {"type", "image_url"} and message["role"] == "user":
                image = item["image_url"]
                if not isinstance(image, dict) or set(image) != {"url"} or not isinstance(image["url"], str):
                    raise Fault(400, "invalid_image_url")
                matched = re.fullmatch(r"data:image/(?:jpeg|png);base64,([A-Za-z0-9+/=]+)", image["url"])
                if not matched:
                    raise Fault(400, "data_images_only")
                if len(metadata) >= MAX_FRAMES:
                    raise Fault(413, "too_many_frames")
                url, meta = image_url(bounded_b64(matched[1], MAX_IMAGE_BYTES), edge)
                metadata.append(meta)
                clean.append({"type": "image_url", "image_url": {"url": url}})
            else:
                raise Fault(400, "unsupported_content_item")
        sanitized.append({"role": message["role"], "content": clean})
    if chars > MAX_PROMPT_CHARS or not metadata:
        raise Fault(400, "prompt_limit_or_image_missing")
    return backend_payload(sanitized, body), {"kind": "image" if len(metadata) == 1 else "ordered_images",
                                              "frames": metadata, "frame_count": len(metadata)}


def remaining(deadline: float) -> float:
    duration = deadline - time.monotonic()
    if duration <= 0:
        raise Fault(504, "request_timeout")
    return duration


def run_media(command: list[str], deadline: float, max_output=256 * 1024):
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=min(8.0, remaining(deadline)), check=False)
    except FileNotFoundError:
        raise Fault(503, "video_decoder_unavailable") from None
    except subprocess.TimeoutExpired:
        raise Fault(504, "video_decode_timeout") from None
    if result.returncode != 0 or len(result.stdout) > max_output or len(result.stderr) > max_output:
        raise Fault(400, "video_decode_failed")
    return result


def decode_video(raw: bytes, count: int, deadline: float) -> tuple[list[tuple[float, bytes]], dict]:
    # Only local MP4 input. Remote URLs/playlists or external file references cannot be opened.
    if len(raw) < 16 or raw[4:8] != b"ftyp":
        raise Fault(400, "mp4_required")
    with tempfile.TemporaryDirectory(prefix="wow-vision-") as temporary:
        directory = Path(temporary)
        video = directory / "input.mp4"
        video.write_bytes(raw)
        probe = run_media(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
                           "-select_streams", "v:0", "-show_entries", "stream=width,height,duration:format=duration",
                           "-of", "json", str(video)], deadline)
        try:
            info = strict_json(probe.stdout)
            stream = info["streams"][0]
            seconds = float(stream.get("duration") or info["format"]["duration"])
            if not math.isfinite(seconds) or not 0 < seconds <= MAX_DURATION_MS / 1000:
                raise Fault(413, "video_duration")
            if not 8 <= int(stream["width"]) <= 4096 or not 8 <= int(stream["height"]) <= 4096:
                raise Fault(413, "video_dimensions")
        except (KeyError, TypeError, ValueError, IndexError):
            raise Fault(400, "invalid_video_metadata") from None
        frames, targets = [], [round((i + 0.5) * seconds * 1000 / count, 3) for i in range(count)]
        for index, target in enumerate(targets):
            output = directory / f"frame-{index}.jpg"
            run_media(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2",
                       "-protocol_whitelist", "file,pipe", "-ss", str(target / 1000), "-i", str(video),
                       "-map", "0:v:0", "-frames:v", "1", "-vf",
                       "scale=768:768:force_original_aspect_ratio=decrease", "-q:v", "3", "-y", str(output)], deadline)
            if not output.is_file() or output.stat().st_size > MAX_IMAGE_BYTES:
                raise Fault(400, "video_frame_unavailable")
            frames.append((target, output.read_bytes()))
        return frames, {"method": "uniform_seek", "duration_ms": round(seconds * 1000, 3),
                        "requested_timestamps_ms": targets, "frame_count": len(frames),
                        "video_source_width": int(stream["width"]), "video_source_height": int(stream["height"]),
                        "timestamp_kind": "requested_seek_position",
                        "native_video_encoder": False, "audio_processed": False,
                        "video_sha256": hashlib.sha256(raw).hexdigest()}


def prepare_analyze(body: dict, deadline: float) -> tuple[dict, dict]:
    allowed = {"prompt", "video_b64", "frames", "max_frames", "max_tokens", "response_format"}
    prompt = body.get("prompt")
    if set(body) - allowed or not isinstance(prompt, str) or not 1 <= len(prompt) <= MAX_PROMPT_CHARS:
        raise Fault(400, "invalid_analyze_options")
    count_tokens(body)
    response_format(body)
    if ("video_b64" in body) == ("frames" in body):
        raise Fault(400, "choose_video_or_frames")
    if "video_b64" in body:
        count = body.get("max_frames", MAX_FRAMES)
        if type(count) is not int or not 1 <= count <= MAX_FRAMES:
            raise Fault(400, "frame_count_out_of_range")
        decode_started = time.monotonic()
        frames, sampling = decode_video(bounded_b64(body["video_b64"], MAX_VIDEO_BYTES), count, deadline)
        sampling["decode_ms"] = round((time.monotonic() - decode_started) * 1000, 3)
        kind = "video_sampled"
    else:
        if "max_frames" in body:
            raise Fault(400, "max_frames_video_only")
        input_frames = body["frames"]
        if not isinstance(input_frames, list) or not 1 <= len(input_frames) <= MAX_FRAMES:
            raise Fault(400, "frame_count_out_of_range")
        frames, previous = [], -1.0
        for frame in input_frames:
            if not isinstance(frame, dict) or set(frame) != {"timestamp_ms", "image_b64"}:
                raise Fault(400, "invalid_frame")
            timestamp = frame["timestamp_ms"]
            if isinstance(timestamp, bool) or not isinstance(timestamp, (float, int)) or not math.isfinite(timestamp) or not 0 <= timestamp <= MAX_DURATION_MS or timestamp <= previous:
                raise Fault(400, "frame_timestamps")
            frames.append((timestamp, bounded_b64(frame["image_b64"], MAX_IMAGE_BYTES)))
            previous = timestamp
        sampling = {"method": "client_ordered_frames", "timestamps_ms": [f[0] for f in frames],
                    "frame_count": len(frames), "timestamp_kind": "client_supplied",
                    "native_video_encoder": False, "audio_processed": False}
        kind = "ordered_frames"
    content, metadata = [{"type": "text", "text": "以下是按时间顺序采样的画面。时间戳表示采样位置；仅判断所提供画面，未出现或看不清的状态返回未知。\n" + prompt}], []
    images_started = time.monotonic()
    for timestamp, raw in frames:
        url, meta = image_url(raw, 768)
        meta["timestamp_ms"] = timestamp
        metadata.append(meta)
        content += [{"type": "text", "text": f"画面时间 {timestamp:.3f} ms"},
                    {"type": "image_url", "image_url": {"url": url}}]
    return backend_payload([{"role": "user", "content": content}], body), {
        "kind": kind, "frames": metadata, "frame_count": len(frames), "sampling": sampling,
        "image_prepare_ms": round((time.monotonic() - images_started) * 1000, 3)}


class State:
    def __init__(self, token: str, backend: str):
        url = urlsplit(backend)
        if url.scheme != "http" or url.hostname != "127.0.0.1" or url.path not in {"", "/"} or url.username or url.query or url.fragment or not url.port:
            raise ValueError("backend must be an explicit loopback http port")
        self.token, self.port = token, url.port
        self.inference_lock = threading.Lock()
        self.poisoned = False

    def backend(self, method: str, path: str, payload, deadline: float):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=remaining(deadline))
        try:
            data = None if payload is None else json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
            connection.request(method, path, data, {"Content-Type": "application/json",
                               "Authorization": "Bearer " + self.token})
            connection.sock.settimeout(remaining(deadline))
            response = connection.getresponse()
            chunks, size = [], 0
            while True:
                available = remaining(deadline)
                if response.fp is None:
                    break
                response.fp.raw._sock.settimeout(available)
                chunk = response.read1(min(65536, MAX_RESPONSE + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_RESPONSE:
                    raise Fault(502, "backend_response_limit")
            if response.status != 200:
                raise Fault(502, "backend_rejected")
            result = strict_json(b"".join(chunks))
            if not isinstance(result, dict):
                raise Fault(502, "invalid_backend_response")
            return result
        except (TimeoutError, socket.timeout):
            if method == "POST":
                self.poisoned = True
            raise Fault(504, "backend_timeout_restart_required") from None
        except Fault as error:
            if method == "POST" and error.status == 504:
                self.poisoned = True
            raise
        except (OSError, http.client.HTTPException):
            if method == "POST":
                self.poisoned = True
            raise Fault(502, "backend_connection_failed") from None
        finally:
            connection.close()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8
    def __init__(self, address, state: State):
        super().__init__(address, Handler)
        self.state = state
        self.clients = threading.BoundedSemaphore(8)

    def process_request(self, request, client_address):
        if not self.clients.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.clients.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.clients.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "WowVision/1"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(5.0)

    def log_message(self, *args):
        pass

    def reply(self, status: int, body):
        encoded = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (OSError, socket.timeout):
            pass
        self.close_connection = True

    def do_GET(self):
        if self.path != "/health":
            self.reply(404, {"error": {"code": "not_found"}})
            return
        state = self.server.state
        try:
            result = state.backend("GET", "/health", None, time.monotonic() + 2)
            ready = result.get("status") == "ok" and not state.poisoned
            self.reply(200 if ready else 503, {"ready": ready, "model": MODEL,
                       "inference_busy": state.inference_lock.locked(),
                       "restart_required": state.poisoned, "video_mode": "ordered_sampled_images",
                       "max_frames": MAX_FRAMES, "max_duration_ms": MAX_DURATION_MS})
        except Fault as error:
            self.reply(503, {"ready": False, "model": MODEL, "error": {"code": error.code}})

    def do_POST(self):
        started = time.monotonic()
        deadline = started + REQUEST_TIMEOUT
        state = self.server.state
        status, meta, locked = 500, {}, False
        request_id = os.urandom(8).hex()
        try:
            authorization = self.headers.get_all("Authorization", [])
            if len(authorization) != 1 or not hmac.compare_digest(authorization[0], "Bearer " + state.token):
                raise Fault(401, "unauthorized")
            if self.path not in {"/v1/chat/completions", "/v1/analyze"}:
                raise Fault(404, "not_found")
            if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise Fault(400, "json_content_length_required")
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or not lengths[0].isdigit():
                raise Fault(400, "json_content_length_required")
            length = int(lengths[0])
            if not 1 <= length <= MAX_BODY:
                raise Fault(413, "request_too_large")
            if state.poisoned:
                raise Fault(503, "backend_restart_required")
            locked = state.inference_lock.acquire(blocking=False)
            if not locked:
                raise Fault(429, "inference_busy")
            chunks, left = [], length
            body_deadline = time.monotonic() + 5
            while left:
                self.connection.settimeout(remaining(body_deadline))
                chunk = self.rfile.read1(min(left, 65536))
                if not chunk:
                    raise Fault(400, "incomplete_body")
                chunks.append(chunk)
                left -= len(chunk)
            body = strict_json(b"".join(chunks))
            if not isinstance(body, dict):
                raise Fault(400, "json_object_required")
            prepared_at = time.monotonic()
            payload, meta = prepare_chat(body) if self.path == "/v1/chat/completions" else prepare_analyze(body, deadline)
            meta["prepare_ms"] = round((time.monotonic() - prepared_at) * 1000, 3)
            backend_at = time.monotonic()
            response = state.backend("POST", "/v1/chat/completions", payload, deadline)
            meta["backend_ms"] = round((time.monotonic() - backend_at) * 1000, 3)
            if not isinstance(response.get("choices"), list) or not response["choices"]:
                raise Fault(502, "invalid_backend_response")
            meta.update({"elapsed_ms": round((time.monotonic() - started) * 1000, 3),
                         "request_id": request_id, "thinking": False, "schema_version": 1})
            response["vision_service"] = meta
            status = 200
            self.reply(status, response)
        except Fault as error:
            status = error.status
            self.reply(status, {"error": {"code": error.code}, "request_id": request_id})
        except (TimeoutError, socket.timeout):
            status = 408
            self.reply(status, {"error": {"code": "body_timeout"}, "request_id": request_id})
        except Exception:
            status = 500
            self.reply(status, {"error": {"code": "internal_error"}, "request_id": request_id})
        finally:
            if locked:
                state.inference_lock.release()
            print(json.dumps({"request_id": request_id, "status": status, "kind": meta.get("kind"),
                              "frames": meta.get("frame_count"),
                              "elapsed_ms": round((time.monotonic() - started) * 1000, 3)}), flush=True)


def read_token(path: Path) -> str:
    permissions = path.stat()
    if not stat.S_ISREG(permissions.st_mode) or stat.S_IMODE(permissions.st_mode) & 0o077 or permissions.st_uid != os.getuid():
        raise ValueError("token file must be owned by current user and mode 0600")
    token = path.read_text().strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        raise ValueError("token must be 32 to 128 URL-safe characters")
    return token


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18790)
    parser.add_argument("--backend", default="http://127.0.0.1:18791")
    parser.add_argument("--token-file", type=Path, required=True)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be 1024..65535")
    state = State(read_token(args.token_file), args.backend)
    with Server(("127.0.0.1", args.port), state) as server:
        print(json.dumps({"event": "gateway_ready", "bind": "127.0.0.1", "port": args.port}), flush=True)
        server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
