"""Contract/security tests use a fake backend; no model or game accuracy claim."""
import base64
import http.client
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

spec = importlib.util.spec_from_file_location("vision_gateway", Path(__file__).with_name("gateway.py"))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)

TOKEN = "test-token-not-a-real-credential-123456789"


def picture(width=64, height=48):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (80, 90, 30)).save(buffer, format="JPEG")
    return base64.b64encode(buffer.getvalue()).decode()


def chat():
    return {"model": gateway.MODEL, "messages": [{"role": "user", "content": [
        {"type": "text", "text": "返回JSON"},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + picture()}}]}],
        "max_tokens": 128, "response_format": {"type": "json_object"}}


class BackendHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.reply({"status": "ok"})

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.calls.append(payload)
        self.server.seen.set()
        time.sleep(self.server.delay)
        self.reply({"choices": [{"message": {"content": '{"fixture":true}'}}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 8},
                    "timings": {"prompt_ms": 1, "predicted_ms": 1}})

    def reply(self, payload):
        encoded = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass


class GatewayContract(unittest.TestCase):
    def setUp(self):
        self.backend = ThreadingHTTPServer(("127.0.0.1", 0), BackendHandler)
        self.backend.calls, self.backend.delay = [], 0
        self.backend.seen = threading.Event()
        self.state = gateway.State(TOKEN, f"http://127.0.0.1:{self.backend.server_port}")
        self.front = gateway.Server(("127.0.0.1", 0), self.state)
        for server in (self.backend, self.front):
            threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def tearDown(self):
        self.front.shutdown()
        self.backend.shutdown()
        self.front.server_close()
        self.backend.server_close()

    def request(self, body=None, path="/v1/chat/completions", token=TOKEN, raw=None):
        client = http.client.HTTPConnection("127.0.0.1", self.front.server_port, timeout=2)
        encoded = raw if raw is not None else json.dumps(body).encode()
        client.request("POST", path, encoded, {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        response = client.getresponse()
        result = response.status, json.loads(response.read())
        client.close()
        return result

    def test_authenticated_image_reaches_backend_with_thinking_disabled(self):
        status, result = self.request(chat())
        self.assertEqual(status, 200)
        self.assertEqual(result["vision_service"]["frame_count"], 1)
        self.assertFalse(self.backend.calls[0]["chat_template_kwargs"]["enable_thinking"])
        self.assertEqual(result["usage"]["completion_tokens"], 8)
        self.assertIn("backend_ms", result["vision_service"])

    def test_authentication_failure_never_calls_backend(self):
        self.assertEqual(self.request(chat(), token="wrong")[0], 401)
        self.assertFalse(self.backend.calls)

    def test_remote_image_url_is_rejected_before_backend(self):
        body = chat()
        body["messages"][0]["content"][1]["image_url"]["url"] = "http://127.0.0.1/private"
        self.assertEqual(self.request(body)[0], 400)
        self.assertFalse(self.backend.calls)

    def test_duplicate_and_nonfinite_json_are_rejected(self):
        for raw in (b'{"messages":[],"messages":[]}', b'{"max_tokens":NaN}'):
            self.assertEqual(self.request(raw=raw)[0], 400)
        self.assertFalse(self.backend.calls)

    def test_unbounded_generation_and_thinking_are_rejected(self):
        for change in ({"max_tokens": 257}, {"max_tokens": True}, {"stream": True},
                       {"chat_template_kwargs": {"enable_thinking": True}}):
            body = chat()
            body.update(change)
            self.assertEqual(self.request(body)[0], 400)
        self.assertFalse(self.backend.calls)

    def test_ordered_frames_have_explicit_timestamps(self):
        body = {"prompt": "比较两帧", "frames": [{"timestamp_ms": 500, "image_b64": picture()},
                                                   {"timestamp_ms": 1500, "image_b64": picture()}]}
        status, response = self.request(body, path="/v1/analyze")
        self.assertEqual(status, 200)
        self.assertEqual(response["vision_service"]["sampling"]["timestamps_ms"], [500, 1500])
        self.assertFalse(response["vision_service"]["sampling"]["native_video_encoder"])
        self.assertIn("500.000 ms", self.backend.calls[0]["messages"][0]["content"][1]["text"])

    def test_bad_timestamps_and_frame_counts_do_not_reach_backend(self):
        for timestamps in ([10, 10], [20, 10], [-1], [12001], [True], [0, 1, 2, 3, 4]):
            body = {"prompt": "比较", "frames": [{"timestamp_ms": t, "image_b64": picture()} for t in timestamps]}
            self.assertEqual(self.request(body, path="/v1/analyze")[0], 400)
        self.assertFalse(self.backend.calls)

    def test_video_must_be_mp4_not_a_url_or_playlist(self):
        body = {"prompt": "视频", "video_b64": base64.b64encode(b"http://example.test/video").decode()}
        self.assertEqual(self.request(body, path="/v1/analyze")[0], 400)
        self.assertFalse(self.backend.calls)

    def test_only_one_inference_and_no_hidden_queue(self):
        self.backend.delay = 0.25
        result = []
        running = threading.Thread(target=lambda: result.append(self.request(chat())))
        running.start()
        self.assertTrue(self.backend.seen.wait(timeout=1))
        self.assertEqual(self.request(chat())[0], 429)
        running.join(timeout=2)
        self.assertEqual(result[0][0], 200)
        self.assertEqual(len(self.backend.calls), 1)

    def test_backend_timeout_fails_closed_and_requires_restart(self):
        self.backend.delay = 0.5
        previous = gateway.REQUEST_TIMEOUT
        gateway.REQUEST_TIMEOUT = 0.1
        try:
            self.assertEqual(self.request(chat())[0], 504)
            self.assertTrue(self.state.poisoned)
            self.assertEqual(self.request(chat())[0], 503)
            self.assertEqual(len(self.backend.calls), 1)
        finally:
            gateway.REQUEST_TIMEOUT = previous

    def test_single_image_is_resized_and_hash_records_original(self):
        body = chat()
        original = picture(2048, 1536)
        body["messages"][0]["content"][1]["image_url"]["url"] = "data:image/jpeg;base64," + original
        status, response = self.request(body)
        self.assertEqual(status, 200)
        metadata = response["vision_service"]["frames"][0]
        self.assertEqual((metadata["input_width"], metadata["input_height"]), (1280, 960))
        self.assertEqual(metadata["source_width"], 2048)

    def test_token_file_must_be_private(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "token"
            path.write_text(TOKEN)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                gateway.read_token(path)
            path.chmod(0o600)
            self.assertEqual(gateway.read_token(path), TOKEN)


class AcceptanceExitStatus(unittest.TestCase):
    def test_model_semantic_failure_returns_nonzero(self):
        module_spec = importlib.util.spec_from_file_location("remote_acceptance", Path(__file__).with_name("acceptance_remote.py"))
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        class FakeResponse(io.BytesIO):
            status = 200
        def fake_open(request, timeout):
            body = json.loads(request.data)
            if body.get("max_tokens") == 257 or "https://example.invalid" in request.data.decode():
                raise urllib.error.HTTPError(request.full_url, 400, "fixture", {}, io.BytesIO(b'{"error":{"code":"fixture"}}'))
            # Transport succeeds, but visible word and color order are wrong.
            content = '{"text":"WRONG","colors":[]}'
            return FakeResponse(json.dumps({"choices": [{"message": {"content": content}}]}).encode())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "runtime").mkdir()
            (root / "runtime/token").write_text(TOKEN)
            with patch("sys.argv", ["acceptance_remote", "--root", str(root), "--out", str(root / "evidence")]), \
                 patch.object(module.urllib.request, "urlopen", fake_open), \
                 patch.object(module.subprocess, "check_output", return_value="0,0,0,0"):
                self.assertEqual(module.main(), 1)
            result = json.loads((root / "evidence/summary.json").read_text())
            self.assertFalse(result["passed"])
            self.assertEqual(len(result["errors"]), 4)


if __name__ == "__main__":
    unittest.main()
