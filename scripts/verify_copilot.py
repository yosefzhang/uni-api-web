"""Verify the copilot engine wire behavior using only isolated local upstreams.

Fixtures simulate the three GitHub Copilot roles:
  - GET  /copilot_internal/v2/token  (PAT -> short-lived Copilot token)
  - POST /chat/completions           (OpenAI-compatible data plane)
  - POST /v1/messages                (Anthropic-native shim for claude models)
"""

import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from verify_dispatch_timing import free_port

COPILOT_TOKEN = "short-lived-fixture"
COPILOT_PAT = "ghp_fixture"


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, payload, content_type="application/json"):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def reply_sse(self, events):
        raw = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
                      for event in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.server.hits.append((self.path, dict(self.headers)))
        assert self.path == "/copilot_internal/v2/token", self.path
        assert self.headers["Authorization"] == f"token {COPILOT_PAT}", self.headers
        assert self.headers["editor-version"] == "vscode/1.110.0"
        assert self.headers["x-github-api-version"] == "2025-04-01"
        self.reply(200, {"token": COPILOT_TOKEN,
                         "expires_at": int(time.time()) + 1800})

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.hits.append((self.path, dict(self.headers), payload))
        assert self.headers["Authorization"] == f"Bearer {COPILOT_TOKEN}", self.headers
        assert self.headers["copilot-integration-id"] == "vscode-chat"
        assert self.headers["editor-version"] == "vscode/1.110.0"
        assert self.headers["openai-intent"] == "conversation-panel"
        if self.path == "/v1/messages":
            assert self.headers["anthropic-version"] == "2023-06-01"
            response = {
                "id": "msg_fixture", "type": "message", "role": "assistant",
                "model": payload.get("model", "claude-fixture"),
                "content": [{"type": "text", "text": "OK"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 3, "output_tokens": 2},
            }
            if payload.get("stream"):
                events = [
                    {"type": "message_start", "message": {**response, "content": []}},
                    {"type": "content_block_start", "index": 0,
                     "content_block": {"type": "text", "text": ""}},
                    {"type": "content_block_delta", "index": 0,
                     "delta": {"type": "text_delta", "text": "OK"}},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": "end_turn"},
                     "usage": {"output_tokens": 2}},
                    {"type": "message_stop"},
                ]
                self.reply_sse(events)
            else:
                self.reply(200, response)
            return
        assert self.path == "/chat/completions", self.path
        response = {
            "id": "chatcmpl-fixture", "object": "chat.completion",
            "model": payload.get("model", "gpt-5.2-fixture"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
        }
        if payload.get("stream"):
            chunk = {"id": "chatcmpl-fixture", "object": "chat.completion.chunk",
                     "model": payload.get("model", "gpt-5.2-fixture"),
                     "choices": [{"index": 0, "delta": {"content": "OK"}}]}
            events = [chunk,
                      {**chunk, "choices": [], "usage": response["usage"]},
                      {"object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}]
            self.reply_sse([{"type": "chat.completion.chunk", **event} for event in events])
        else:
            self.reply(200, response)


def verify(binary):
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    upstream.hits = []
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="uni-copilot-") as directory:
        root = Path(directory)
        port = free_port()
        host = f"http://127.0.0.1:{upstream.server_port}"
        config = {
            "providers": [
                {"provider": "copilot", "engine": "copilot",
                 "base_url": f"{host}/chat/completions",
                 "api": COPILOT_PAT,
                 "model": [{"gpt-5.2-fixture": "gpt-public"}, {"claude-fixture": "claude-public"}],
                 "preferences": {"AUTO_RETRY": False}},
            ],
            "api_keys": [{"api": "admin-fixture", "model": ["all"]}],
        }
        config_path = root / "api.json"
        original = json.dumps(config).encode()
        config_path.write_bytes(original)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("FACTS_S3_", "OTEL_", "FUGUE_OTEL_")) and key != "CONFIG_URL"}
        env.update(PORT=str(port), DISABLE_DATABASE="true", UNI_API_CONFIG_PATH=str(config_path),
                   COPILOT_TOKEN_URL=f"{host}/copilot_internal/v2/token",
                   RUST_RESPONSES_CONFIG_SNAPSHOT_PATH=str(root / "snapshot.json"),
                   UNI_API_SHARED_MEMORY_RESERVATION_PATH=str(root / "ledger"),
                   RUST_REQUEST_SPOOL_DIRECTORY=str(root / "spool"),
                   RUST_REQUEST_SPOOL_DISK_RESERVE_BPS="0", RUST_REQUEST_SPOOL_INODE_RESERVE_BPS="0",
                   NO_PROXY="127.0.0.1,localhost")

        def request(path, payload):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            try:
                connection.request("POST", path, json.dumps(payload),
                                   {"Authorization": "Bearer admin-fixture",
                                    "Content-Type": "application/json"})
                response = connection.getresponse()
                return response.status, response.read()
            finally:
                connection.close()

        with (root / "log").open("w+") as log:
            process = subprocess.Popen([str(binary)], cwd=root, env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                        connection.request("GET", "/healthz")
                        if connection.getresponse().status == 200:
                            connection.close()
                            break
                        connection.close()
                    except OSError:
                        pass
                    time.sleep(0.05)
                else:
                    raise AssertionError("fixture did not become healthy")

                token_exchanges = 0
                checked = 0

                def count_token_exchanges():
                    return sum(1 for hit in upstream.hits
                               if hit[0] == "/copilot_internal/v2/token")

                def upstream_paths():
                    return [hit[0] for hit in upstream.hits]

                # 1. chat/completions + gpt model -> /chat/completions, sanitized payload
                token_exchanges += count_token_exchanges()
                upstream.hits.clear()
                status, raw = request("/v1/chat/completions", {
                    "model": "gpt-public", "max_tokens": 42, "reasoning_effort": "none",
                    "messages": [{"role": "user", "content": [
                        {"type": "text", "text": "hi"},
                        {"type": "tool_result", "content": "tool output"}]}]})
                assert status == 200, (status, raw)
                path, _, body = upstream.hits[-1]
                assert path == "/chat/completions", upstream_paths()
                assert body["model"] == "gpt-5.2-fixture", body
                assert body["max_completion_tokens"] == 42, body
                assert "max_tokens" not in body and "reasoning_effort" not in body, body
                assert body["messages"][0]["content"][1] == {"type": "text", "text": "tool output"}, body
                assert b"OK" in raw, raw
                checked += 1

                # 2. chat/completions + claude model -> Anthropic-native /v1/messages
                token_exchanges += count_token_exchanges()
                upstream.hits.clear()
                status, raw = request("/v1/chat/completions", {
                    "model": "claude-public", "max_tokens": 64,
                    "messages": [{"role": "user", "content": "hi"}]})
                assert status == 200, (status, raw)
                path, _, body = upstream.hits[-1]
                assert path == "/v1/messages", upstream_paths()
                assert body["model"] == "claude-fixture", body
                assert b"OK" in raw, raw
                checked += 1

                # 3. /v1/messages + claude model -> passthrough to /v1/messages
                token_exchanges += count_token_exchanges()
                upstream.hits.clear()
                status, raw = request("/v1/messages", {
                    "model": "claude-public", "max_tokens": 64,
                    "messages": [{"role": "user", "content": "hi"}]})
                assert status == 200, (status, raw)
                path, _, body = upstream.hits[-1]
                assert path == "/v1/messages", upstream_paths()
                assert body["model"] == "claude-fixture", body
                assert b"OK" in raw, raw
                checked += 1

                # 4. /v1/messages + gpt model -> converted to chat/completions
                token_exchanges += count_token_exchanges()
                upstream.hits.clear()
                status, raw = request("/v1/messages", {
                    "model": "gpt-public", "max_tokens": 32,
                    "messages": [{"role": "user", "content": "hi"}]})
                assert status == 200, (status, raw)
                path, _, body = upstream.hits[-1]
                assert path == "/chat/completions", upstream_paths()
                assert body["model"] == "gpt-5.2-fixture", body
                assert b"OK" in raw, raw
                checked += 1

                # 5. streaming chat/completions passes SSE through
                token_exchanges += count_token_exchanges()
                upstream.hits.clear()
                status, raw = request("/v1/chat/completions", {
                    "model": "gpt-public", "stream": True,
                    "messages": [{"role": "user", "content": "hi"}]})
                assert status == 200, (status, raw)
                assert b"data:" in raw and b"OK" in raw, raw
                checked += 1

                # 6. token exchange happened exactly once across all requests
                token_exchanges += count_token_exchanges()
                assert token_exchanges == 1, (token_exchanges, upstream_paths())
                checked += 1

                assert config_path.read_bytes() == original
                print(f"PASS Copilot engine: {checked} HTTP cases; token exchange cached, "
                      "claude/gpt routing, payload sanitization, streaming, config unchanged")
            except Exception:
                print((root / "log").read_text()[-8000:])
                raise
            finally:
                process.terminate()
                try:
                    process.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                upstream.shutdown()
                upstream.server_close()


if __name__ == "__main__":
    verify(Path(sys.argv[1]).resolve())
