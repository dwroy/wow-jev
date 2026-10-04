import hashlib
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread

import pytest

from tools.vision_service_probe import fixture_bytes, load_token, model_content, request


def test_private_token_file_and_fixture_provenance(tmp_path):
    token = tmp_path / "token"
    token.write_text("test-only-fake-token-0000000000000000\n")
    token.chmod(0o644)
    with pytest.raises(ValueError, match="private_regular"):
        load_token(token)
    token.chmod(0o600)
    assert load_token(token).startswith("test-only-")
    symlink = tmp_path / "link"
    symlink.symlink_to(token)
    with pytest.raises(ValueError, match="private_regular"):
        load_token(symlink)
    image = tmp_path / "fixture.jpg"
    image.write_bytes(b"test-fixture")
    item = {"path": str(image), "sha256": hashlib.sha256(image.read_bytes()).hexdigest()}
    assert fixture_bytes(item, 100) == b"test-fixture"
    image.write_bytes(b"modified")
    with pytest.raises(ValueError, match="hash_mismatch"):
        fixture_bytes(item, 100)


def test_only_loopback_tunnel_and_complete_response():
    for base in ("http://example.com", "http://127.0.0.1/path", "http://user:secret@127.0.0.1", "https://localhost"):
        with pytest.raises(ValueError, match="loopback"):
            request(base, "/health", None)
    for response in ([], {"choices": []}, {"choices": [None]}, {"choices": [{"message": {}, "finish_reason": "length"}]}):
        with pytest.raises(ValueError):
            model_content(response)
    assert model_content({"choices": [{"finish_reason": "stop", "message": {"content": "{}"}}]}) == "{}"


def test_credentials_echo_is_rejected_and_error_body_not_returned():
    token = "test-only-fake-token-0000000000000000"

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            status = 401 if self.path == "/unauthorized" else 200
            body = json.dumps({"echo": self.headers.get("Authorization", "")}).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = "http://127.0.0.1:" + str(server.server_port)
        with pytest.raises(ValueError, match="credential_echo_rejected"):
            request(base, "/echo", token, timeout=2)
        with pytest.raises(ValueError, match="http_status_401") as error:
            request(base, "/unauthorized", token, timeout=2)
        assert token not in str(error.value)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)
