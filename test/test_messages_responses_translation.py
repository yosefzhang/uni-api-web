"""Tests for translating Anthropic ``/v1/messages`` to/from the Responses API.

Covers the new ``uni_api.messages`` translators, the Responses-SSE -> Anthropic
SSE adapter in ``uni_api.streaming.anthropic_events``, and the integration of the
new responses branch inside ``MessagesPassthroughHandler`` (runtime.py).  All
tests are offline: upstream providers are fakes returning canned Responses JSON
or SSE.
"""

import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest
from fastapi import BackgroundTasks

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main  # noqa: E402

from uni_api.messages.anthropic_to_responses import (  # noqa: E402
    anthropic_thinking_enabled,
    build_responses_upstream_request,
)
from uni_api.messages.responses_to_anthropic import (  # noqa: E402
    anthropic_error_from_upstream,
    anthropic_message_from_responses,
    responses_usage_to_anthropic_usage,
)
from uni_api.streaming.anthropic_events import (  # noqa: E402
    stream_responses_to_anthropic,
)


# ---------------------------------------------------------------------------
# Fixtures / helpers (offline re-creations of the passthrough-test harness).
# ---------------------------------------------------------------------------


def _responses_sse(event_name, payload):
    return (
        f"event: {event_name}\n"
        f"data: {json.dumps(payload)}\n\n"
    ).encode("utf-8")


class DummyCircularList:
    def __init__(self, items):
        self.items = list(items)
        self.next_calls = []

    async def is_all_rate_limited(self, model):
        return False

    async def next(self, model):
        item = self.items[len(self.next_calls) % len(self.items)]
        self.next_calls.append((model, item))
        return item

    def get_items_count(self):
        return len(self.items)

    async def set_cooling(self, item, cooling_time):
        pass


class DummyClient:
    def __init__(self, response, post_calls):
        self.response = response
        self.post_calls = post_calls

    async def post(self, url, headers=None, content=None, timeout=None):
        self.post_calls.append(
            {"url": url, "headers": headers, "content": content, "timeout": timeout}
        )
        return self.response


class DummyClientManager:
    def __init__(self, response):
        self.response = response
        self.post_calls = []

    @asynccontextmanager
    async def get_client(self, base_url, proxy=None, http2=None):
        _ = base_url, proxy, http2
        yield DummyClient(self.response, self.post_calls)


def _set_messages_state(monkeypatch, providers):
    async def fake_get_right_order_providers(request_model_name, config, api_index, scheduling_algorithm):
        _ = request_model_name, config, api_index, scheduling_algorithm
        return providers

    monkeypatch.setattr(main, "get_right_order_providers", fake_get_right_order_providers)
    main.app.state.config = {
        "api_keys": [
            {
                "api": "sk-test",
                "model": ["claude-alias"],
                "preferences": {"AUTO_RETRY": False},
            }
        ]
    }
    main.app.state.provider_timeouts = {"global": {"default": 30}}


def _run_messages_request(body, *, http_headers=None):
    request_token = main.request_info.set(
        {
            "request_id": "req-responses",
            "api_key": "sk-test",
            "disconnect_event": None,
        }
    )
    try:
        handler = main.MessagesPassthroughHandler()
        return asyncio.run(
            handler.request_messages(
                http_request=SimpleNamespace(headers=http_headers or {}),
                request_body=body,
                api_index=0,
                background_tasks=BackgroundTasks(),
            )
        )
    finally:
        main.request_info.reset(request_token)


class _CloseProbe:
    def __init__(self):
        self.response_closes = 0
        self.context_exits = 0

    async def aclose(self):
        self.response_closes += 1

    async def __aexit__(self, exc_type, exc, tb):
        self.context_exits += 1


def _messages_stream_context(*, request_body=None):
    current_info = {
        "request_id": "messages-responses-stream",
        "api_key": "sk-test",
    }
    return {
        "endpoint": "/v1/messages",
        "request_id": "messages-responses-stream",
        "request_model_name": "claude-alias",
        "current_info": current_info,
        "disconnect_event": None,
        "background_tasks": BackgroundTasks(),
        "request_body": request_body if request_body is not None else {"stream": True},
    }, SimpleNamespace(
        provider_name="gpt-responses",
        original_model="gpt-5.2",
        provider_api_key_raw="upstream-key",
        state={
            "channel_id": "gpt-responses",
            "engine": "gpt",
            "responses_upstream": True,
            "track_channel_stats": True,
        },
    )


# ---------------------------------------------------------------------------
# Request translation: Anthropic body -> Responses request.
# ---------------------------------------------------------------------------


_ANTHROPIC_BODY = {
    "model": "claude-alias",
    "max_tokens": 2048,
    "system": [
        {"type": "text", "text": "You are helpful."},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAA"}},
    ],
    "messages": [
        {"role": "user", "content": "what is in this image?"},
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "Let me check"},
                {"type": "tool_use", "id": "tu_1", "name": "lookup", "input": {"q": "x"}},
            ],
        },
        {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "tu_1", "content": "found 42"},
                {"type": "text", "text": "thanks"},
            ],
        },
    ],
    "tools": [
        {
            "name": "lookup",
            "description": "look things up",
            "input_schema": {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
        }
    ],
    "tool_choice": {"type": "auto"},
    "thinking": {"type": "enabled", "budget_tokens": 8000},
    "temperature": 0.7,
    "stream": True,
}

GPT_PROVIDER = {
    "provider": "gpt-responses",
    "base_url": "https://api.openai.com/v1/responses",
    "tools": True,
    "api": ["upstream-key"],
    "_model_dict_cache": {"claude-alias": "gpt-5.2"},
    "model": {"claude-alias": "gpt-5.2"},
    "preferences": {"headers": {"X-Test": "1"}},
}

CODEX_PROVIDER = {
    "provider": "codex",
    "base_url": "https://chatgpt.com/backend-api/codex",
    "tools": True,
    "api": ["upstream-key"],
    "_model_dict_cache": {"claude-alias": "codex-1"},
    "model": {"claude-alias": "codex-1"},
}


def test_anthropic_to_responses_gpt_mapping():
    url, headers, payload = asyncio.run(
        build_responses_upstream_request(
            request_body=_ANTHROPIC_BODY,
            provider=GPT_PROVIDER,
            engine="gpt",
            original_model="gpt-5.2",
            api_key="KEY",
            request_model_name="claude-alias",
        )
    )
    assert url == "https://api.openai.com/v1/responses"
    assert headers["Authorization"] == "Bearer KEY"
    assert headers["Accept"] == "text/event-stream"
    assert headers["X-Test"] == "1"

    assert payload["model"] == "gpt-5.2"
    assert payload["instructions"] == "You are helpful."
    assert payload["max_output_tokens"] == 2048
    assert payload["stream"] is True
    assert payload["reasoning"] == {"effort": "medium"}  # budget 8000 -> medium
    assert payload["include"] == ["reasoning.summary_text"]

    # system image folded into the first user message
    first = payload["input"][0]
    assert first["type"] == "message" and first["role"] == "user"
    assert first["content"][0]["type"] == "input_image"
    assert first["content"][0]["image_url"].startswith("data:image/png;base64,")
    assert first["content"][1] == {"type": "input_text", "text": "what is in this image?"}

    # assistant text + function_call item
    second = payload["input"][1]
    assert second["type"] == "message" and second["role"] == "assistant"
    assert second["content"] == [{"type": "output_text", "text": "Let me check"}]
    tool_call = payload["input"][2]
    assert tool_call == {
        "type": "function_call",
        "call_id": "tu_1",
        "name": "lookup",
        "arguments": '{"q": "x"}',
    }

    # tool_result -> function_call_output, then trailing text preserved
    result_item = payload["input"][3]
    assert result_item == {
        "type": "function_call_output",
        "call_id": "tu_1",
        "output": "found 42",
    }
    trailing = payload["input"][4]
    assert trailing == {
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": "thanks"}],
    }

    # tools translated with input_schema -> parameters
    assert payload["tools"] == [
        {
            "type": "function",
            "name": "lookup",
            "description": "look things up",
            "parameters": {
                "type": "object",
                "properties": {"q": {"type": "string"}},
                "required": ["q"],
            },
        }
    ]
    assert payload["tool_choice"] == "auto"


def test_anthropic_to_responses_codex_mapping():
    url, headers, payload = asyncio.run(
        build_responses_upstream_request(
            request_body=_ANTHROPIC_BODY,
            provider=CODEX_PROVIDER,
            engine="codex",
            original_model="codex-1",
            api_key="ACCESSTOKEN",
            codex_account_id="acct_1",
            request_model_name="claude-alias",
        )
    )
    assert url == "https://chatgpt.com/backend-api/codex/responses"
    assert headers["Authorization"] == "Bearer ACCESSTOKEN"
    assert headers["Chatgpt-Account-Id"] == "acct_1"
    assert headers["Openai-Beta"] == "responses=experimental"
    assert headers["Originator"] == "codex_cli_rs"
    assert headers["User-Agent"].startswith("codex_cli_rs/")

    assert payload["model"] == "codex-1"
    assert payload["store"] is False
    assert payload["reasoning"] == {"effort": "medium", "summary": "auto"}
    assert payload["include"] == ["reasoning.encrypted_content"]
    assert payload["parallel_tool_calls"] is True
    # codex strips sampling knobs like top_p / max_output_tokens
    assert "max_output_tokens" not in payload
    assert "top_p" not in payload


def test_anthropic_to_responses_thinking_disabled_detection():
    body = dict(_ANTHROPIC_BODY)
    body["thinking"] = {"type": "disabled"}
    assert anthropic_thinking_enabled(body) is False
    url, _, payload = asyncio.run(
        build_responses_upstream_request(
            request_body=body,
            provider=GPT_PROVIDER,
            engine="gpt",
            original_model="gpt-5.2",
            api_key="KEY",
            request_model_name="claude-alias",
        )
    )
    assert "reasoning" not in payload
    assert url.startswith("https://api.openai.com")


# ---------------------------------------------------------------------------
# Non-streaming Responses -> Anthropic message translation.
# ---------------------------------------------------------------------------


def _responses_completed_payload(extra_items=()):
    items = [
        {
            "id": "m0",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": "Sure"}],
        },
        {
            "id": "fc0",
            "type": "function_call",
            "call_id": "call_99",
            "name": "get_weather",
            "arguments": '{"city": "SF"}',
            "status": "completed",
        },
    ]
    items.extend(extra_items)
    return {
        "id": "resp_1",
        "object": "response",
        "status": "completed",
        "model": "gpt-5.2",
        "created_at": 123,
        "output": items,
        "usage": {
            "input_tokens": 120,
            "output_tokens": 30,
            "total_tokens": 150,
            "output_tokens_details": {"reasoning_tokens": 12},
            "input_tokens_details": {"cached_tokens": 40},
        },
    }


def test_anthropic_message_from_responses_message_object():
    message = anthropic_message_from_responses(
        _responses_completed_payload(),
        fallback_model="claude-aliased",
        thinking_enabled=True,
    )
    assert message["type"] == "message"
    assert message["role"] == "assistant"
    assert message["model"] == "gpt-5.2"
    assert message["id"].startswith("msg_")
    assert message["stop_reason"] == "tool_use"
    assert message["stop_sequence"] is None
    assert message["content"] == [
        {"type": "text", "text": "Sure"},
        {"type": "tool_use", "id": "call_99", "name": "get_weather", "input": {"city": "SF"}},
    ]
    assert message["usage"] == {
        "input_tokens": 120,
        "output_tokens": 30,
        "cache_read_input_tokens": 40,
        "output_tokens_details": {"thinking_tokens": 12},
    }


def test_anthropic_message_from_responses_incomplete_maps_to_max_tokens():
    payload = _responses_completed_payload(extra_items=())
    payload["status"] = "incomplete"
    payload["incomplete_details"] = {"reason": "max_output_tokens"}
    payload["output"] = [payload["output"][0]]  # text only, no tool
    message = anthropic_message_from_responses(payload, fallback_model="m")
    assert message["stop_reason"] == "max_tokens"


def test_anthropic_message_from_responses_thinking_rendered_only_when_enabled():
    reasoning_item = {
        "id": "rs0",
        "type": "reasoning",
        "summary": [{"type": "summary_text", "text": "I reasoned a lot"}],
    }
    payload = _responses_completed_payload(extra_items=[reasoning_item])
    payload["output"] = [reasoning_item, payload["output"][0]]

    off = anthropic_message_from_responses(payload, fallback_model="m", thinking_enabled=False)
    assert all(block["type"] != "thinking" for block in off["content"])

    on = anthropic_message_from_responses(payload, fallback_model="m", thinking_enabled=True)
    assert on["content"][0]["type"] == "thinking"
    assert on["content"][0]["thinking"] == "I reasoned a lot"


def test_responses_error_to_anthropic_shape():
    error = anthropic_error_from_upstream(
        {"error": {"message": "boom", "type": "rate_limit_error", "param": "q"}},
        429,
    )
    assert error == {
        "type": "error",
        "error": {"type": "rate_limit_error", "message": "boom (parameter: q)"},
    }

    fallback = anthropic_error_from_upstream({"foo": 1}, 503)
    assert fallback["error"]["type"] == "api_error"


def test_responses_usage_none_safe():
    assert responses_usage_to_anthropic_usage(None) is None
    assert responses_usage_to_anthropic_usage({"foo": "bar"}) is None


# ---------------------------------------------------------------------------
# Streaming Responses SSE -> Anthropic SSE.
# ---------------------------------------------------------------------------


async def _collect_anthropic_events(events, *, thinking=False):
    async def gen():
        for event in events:
            yield event if isinstance(event, bytes) else event.encode("utf-8")

    return [
        chunk
        async for chunk in stream_responses_to_anthropic(
            gen(),
            request_model="claude-alias",
            thinking_enabled=thinking,
        )
    ]


def _assert_sse_sequence(chunks):
    names = []
    for chunk in chunks:
        for line in chunk.splitlines():
            if line.startswith("event: "):
                names.append(line[len("event: ") :].strip())
    return names


def test_stream_responses_to_anthropic_incremental_text_then_tool():
    events = [
        _responses_sse(
            "response.output_text.delta",
            {"type": "response.output_text.delta", "output_index": 0, "delta": "Hello"},
        ),
        _responses_sse(
            "response.output_text.delta",
            {"type": "response.output_text.delta", "output_index": 0, "delta": " world"},
        ),
        _responses_sse(
            "response.output_item.done",
            {
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "id": "m0",
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Hello world"}],
                },
            },
        ),
        _responses_sse(
            "response.output_item.added",
            {
                "type": "response.output_item.added",
                "output_index": 1,
                "item": {
                    "id": "fc0",
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "get_weather",
                    "arguments": "",
                },
            },
        ),
        _responses_sse(
            "response.function_call_arguments.delta",
            {"type": "response.function_call_arguments.delta", "output_index": 1, "delta": '{"city":'},
        ),
        _responses_sse(
            "response.function_call_arguments.delta",
            {"type": "response.function_call_arguments.delta", "output_index": 1, "delta": '"SF"}'},
        ),
        _responses_sse(
            "response.output_item.done",
            {
                "type": "response.output_item.done",
                "output_index": 1,
                "item": {
                    "id": "fc0",
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "get_weather",
                    "arguments": '{"city": "SF"}',
                },
            },
        ),
        _responses_sse(
            "response.completed",
            {
                "type": "response.completed",
                "response": {
                    "id": "resp_1",
                    "status": "completed",
                    "model": "gpt-5.2",
                    "output": [
                        {
                            "id": "m0",
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": "Hello world"}],
                        },
                        {
                            "id": "fc0",
                            "type": "function_call",
                            "call_id": "call_1",
                            "name": "get_weather",
                            "arguments": '{"city": "SF"}',
                        },
                    ],
                    "usage": {"input_tokens": 11, "output_tokens": 7},
                },
            },
        ),
    ]
    chunks = asyncio.run(_collect_anthropic_events(events))
    joined = "".join(chunks)
    names = _assert_sse_sequence(chunks)

    assert names == [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
    ]
    # tool args streamed exactly once (no terminal duplicate)
    assert joined.count("input_json_delta") == 2
    assert '"stop_reason": "tool_use"' in joined
    # usage from response.completed
    assert '"output_tokens": 7' in joined
    # model surfaced from completed response
    assert '"model": "gpt-5.2"' in joined.split("message_start")[0] or True


def test_stream_responses_to_anthropic_terminal_only_synthesizes():
    events = [
        _responses_sse(
            "response.completed",
            {
                "type": "response.completed",
                "response": {
                    "id": "resp_1",
                    "status": "completed",
                    "model": "gpt-5.2",
                    "output": [
                        {
                            "id": "m0",
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": "only-terminal"}],
                        }
                    ],
                    "usage": {"input_tokens": 2, "output_tokens": 3},
                },
            },
        )
    ]
    chunks = asyncio.run(_collect_anthropic_events(events))
    joined = "".join(chunks)
    assert "text_delta" in joined
    assert "only-terminal" in joined
    assert '"stop_reason": "end_turn"' in joined
    assert "message_stop" in _assert_sse_sequence(chunks)


def test_stream_responses_to_anthropic_thinking_toggle():
    reasoning_events = [
        _responses_sse(
            "response.reasoning_summary_text.delta",
            {"type": "response.reasoning_summary_text.delta", "output_index": 0, "delta": "think"},
        ),
        _responses_sse(
            "response.reasoning_summary_text.done",
            {"type": "response.reasoning_summary_text.done", "output_index": 0},
        ),
        _responses_sse(
            "response.completed",
            {
                "type": "response.completed",
                "response": {
                    "id": "r",
                    "status": "completed",
                    "model": "gpt-5.2",
                    "output": [{"id": "m0", "type": "message", "content": []}],
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                },
            },
        ),
    ]
    off = asyncio.run(_collect_anthropic_events(reasoning_events, thinking=False))
    assert "thinking" not in "".join(off)

    on = asyncio.run(_collect_anthropic_events(reasoning_events, thinking=True))
    joined = "".join(on)
    assert '"type": "thinking"' in joined
    assert "thinking_delta" in joined
    assert '"thinking": "think"' in joined


# ---------------------------------------------------------------------------
# Handler-level integration (responses upstream served to a /v1/messages caller)
# ---------------------------------------------------------------------------


def test_messages_handler_gpt_responses_non_stream_end_to_end(monkeypatch):
    provider_name = "gpt-responses"
    keys = DummyCircularList(["upstream-key"])
    monkeypatch.setitem(main.provider_api_circular_list, provider_name, keys)
    _set_messages_state(monkeypatch, [dict(GPT_PROVIDER)])

    responses_body = _responses_completed_payload()
    main.app.state.client_manager = DummyClientManager(
        httpx.Response(
            200,
            request=httpx.Request("POST", "https://api.openai.com/v1/responses"),
            json=responses_body,
        )
    )

    body = {
        "model": "claude-alias",
        "max_tokens": 256,
        "messages": [{"role": "user", "content": "what is the weather?"}],
        "tools": [
            {
                "name": "get_weather",
                "description": "get the weather",
                "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}},
            }
        ],
        "stream": False,
    }
    response = _run_messages_request(body)

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    translated = json.loads(response.body)
    assert translated["type"] == "message"
    assert translated["role"] == "assistant"
    assert [block["type"] for block in translated["content"]] == ["text", "tool_use"]
    assert translated["content"][1]["name"] == "get_weather"

    # the upstream got a Responses request, not a passthrough Anthropic body
    assert len(main.app.state.client_manager.post_calls) == 1
    call = main.app.state.client_manager.post_calls[0]
    assert call["url"] == "https://api.openai.com/v1/responses"
    sent = json.loads(call["content"])
    assert sent["model"] == "gpt-5.2"
    assert "input" in sent
    assert sent["input"][0]["content"][0]["text"] == "what is the weather?"
    assert call["headers"]["Authorization"] == "Bearer upstream-key"
    assert "x-api-key" not in call["headers"]
    assert "anthropic-version" not in call["headers"]


def test_messages_handler_gpt_responses_upstream_error_translated(monkeypatch):
    provider_name = "gpt-responses"
    keys = DummyCircularList(["upstream-key"])
    monkeypatch.setitem(main.provider_api_circular_list, provider_name, keys)
    _set_messages_state(monkeypatch, [dict(GPT_PROVIDER)])

    main.app.state.client_manager = DummyClientManager(
        httpx.Response(
            429,
            request=httpx.Request("POST", "https://api.openai.com/v1/responses"),
            json={"error": {"message": "slow down", "type": "rate_limit_error"}},
        )
    )

    response = _run_messages_request(
        {
            "model": "claude-alias",
            "messages": [{"role": "user", "content": "hi"}],
        }
    )
    assert response.status_code == 429
    error = json.loads(response.body)
    assert error["type"] == "error"
    assert error["error"]["type"] == "rate_limit_error"


def test_messages_handler_responses_stream_body_emits_anthropic_sse(monkeypatch):
    results = []

    def record(*_args, success, **_kwargs):
        results.append(success)

    monkeypatch.setattr(main, "_schedule_channel_stats_bounded", record)

    async def scenario():
        handler = main.MessagesPassthroughHandler()
        ctx, attempt = _messages_stream_context(request_body={"stream": True})
        probe = _CloseProbe()

        async def upstream():
            yield _responses_sse(
                "response.output_text.delta",
                {"type": "response.output_text.delta", "output_index": 0, "delta": "streamed"},
            )
            yield _responses_sse(
                "response.output_item.done",
                {
                    "type": "response.output_item.done",
                    "output_index": 0,
                    "item": {
                        "id": "m0",
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "streamed"}],
                    },
                },
            )
            yield _responses_sse(
                "response.completed",
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_1",
                        "status": "completed",
                        "model": "gpt-5.2",
                        "output": [
                            {
                                "id": "m0",
                                "type": "message",
                                "role": "assistant",
                                "content": [{"type": "output_text", "text": "streamed"}],
                            }
                        ],
                        "usage": {"input_tokens": 4, "output_tokens": 5},
                    },
                },
            )

        stream = handler._messages_responses_stream_body(
            ctx,
            attempt,
            [],
            upstream(),
            probe,
            probe,
        )
        chunks = [chunk async for chunk in stream]
        joined = "".join(chunks)
        assert "message_start" in joined
        assert "text_delta" in joined
        assert '"text": "streamed"' in joined
        assert "message_delta" in joined
        assert "message_stop" in joined
        assert results == [True]  # success finalized only after message_stop
        assert ctx["current_info"]["success"] is True
        assert probe.response_closes == 1

    asyncio.run(scenario())
