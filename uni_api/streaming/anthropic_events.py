"""Anthropic SSE emitters and a Responses-SSE -> Anthropic-SSE stream adapter.

The Messages passthrough path previously proxied Anthropic upstream bytes as-is;
nothing in the codebase rendered Anthropic SSE to a client.  These builders and
the ``stream_responses_to_anthropic`` generator fill that gap so a ``/v1/messages``
caller can be served by an upstream that speaks the OpenAI Responses API.

The generator mirrors the architecture of
``responses_events.stream_responses_to_chat_completions``: the same SSE reader
pipeline and output-item collector, but emitting Anthropic events:

``message_start`` -> ``content_block_start`` / ``content_block_delta`` /
``content_block_stop`` (``text_delta`` / ``input_json_delta`` /
``thinking_delta``) -> ``message_delta`` -> ``message_stop``.

Providers that only deliver content in the terminal ``response.completed`` body
are handled by synthesizing blocks from the collected output items.
"""

from __future__ import annotations

import json
import uuid
from contextlib import aclosing
from datetime import datetime
from typing import Any, AsyncIterator

from core.utils import end_of_line, safe_get
from uni_api.messages.responses_to_anthropic import (
    anthropic_error_from_upstream,
    responses_stop_reason,
    responses_usage_to_anthropic_usage,
)
from uni_api.streaming.cleanup import close_async_iterator_safely
from uni_api.streaming.responses_events import (
    ResponsesOutputItemCollector,
    build_missing_responses_completed_payload,
    chat_completion_created_at_from_payload,
    chat_completion_response_id_from_payload,
    coerce_positive_int,
    extract_response_model_name,
    normalize_optional_text,
    patch_responses_completed_output,
)
from uni_api.streaming.sse import (
    SSEProtocolError,
    iter_sse_events,
    parse_owned_sse_event,
    validate_sse_event_type_consistency,
)


DEFAULT_MAX_COLLECTED_OUTPUT_ITEMS = 128
DEFAULT_MAX_COLLECTED_OUTPUT_BYTES = 8 * 1024 * 1024


def anthropic_sse_event(event_name: str, payload: object) -> str:
    """Serialize one Anthropic SSE frame (``event:`` + ``data:`` + blank line)."""
    return (
        f"event: {event_name}\n"
        f"data: {json.dumps(payload, ensure_ascii=False)}"
        f"{end_of_line}"
    )


def anthropic_message_start_sse(message: dict) -> str:
    return anthropic_sse_event("message_start", {"type": "message_start", "message": message})


def anthropic_content_block_start_sse(index: int, content_block: dict) -> str:
    return anthropic_sse_event(
        "content_block_start",
        {"type": "content_block_start", "index": index, "content_block": content_block},
    )


def anthropic_content_block_delta_sse(index: int, delta: dict) -> str:
    return anthropic_sse_event(
        "content_block_delta",
        {"type": "content_block_delta", "index": index, "delta": delta},
    )


def anthropic_content_block_stop_sse(index: int) -> str:
    return anthropic_sse_event("content_block_stop", {"type": "content_block_stop", "index": index})


def anthropic_message_delta_sse(delta: dict, usage: dict) -> str:
    return anthropic_sse_event(
        "message_delta",
        {"type": "message_delta", "delta": delta, "usage": usage},
    )


def anthropic_message_stop_sse() -> str:
    return anthropic_sse_event("message_stop", {"type": "message_stop"})


def anthropic_error_event_sse(error: dict) -> str:
    return anthropic_sse_event("error", {"type": "error", "error": error.get("error") or error})


def anthropic_protocol_error_sse(status_code: int = 502) -> str:
    """Protocol-valid terminal error used after an upstream SSE failure."""
    return anthropic_sse_event(
        "error",
        {
            "type": "error",
            "error": {
                "message": "Upstream SSE protocol error",
                "type": "stream_error",
                "code": "upstream_sse_protocol_error",
                "status_code": status_code,
            },
        },
    )


def anthropic_error_event_from_upstream(raw: Any, status_code: int | None) -> str:
    error = anthropic_error_from_upstream(raw, status_code)
    return anthropic_error_event_sse(error)


def _new_message_id() -> str:
    return f"msg_{uuid.uuid4().hex}"


class _AnthropicStreamBuilder:
    """Incremental Anthropic SSE state.

    ``output_index`` keys identify upstream output items; each content block is
    emitted with a strictly increasing Anthropic ``content`` index.  Every block
    is opened lazily on its first attributable event, streamed via deltas, and
    closed on ``response.output_item.done`` or at the terminal event.
    """

    def __init__(self, *, model_name: str, message_id: str, thinking_enabled: bool) -> None:
        self.model_name = model_name or "unknown"
        self.message_id = message_id
        self.thinking_enabled = thinking_enabled
        self.next_index = 0
        # output_index -> {"kind": "text"|"thinking"|"tool", "index": anthropic_index}
        self.open_blocks: dict[int, dict[str, Any]] = {}
        # output_index -> accumulated partial_json when a tool call arrives
        # through an args delta before its output_item.added (defensive).
        self.buffered_args: dict[int, str] = {}
        # output_index whose content was already fully emitted.
        self.rendered_output_indexes: set[int] = set()
        # upstream item id already fully rendered (authoritative dedupe).
        self.rendered_item_ids: set[str] = set()
        self.has_tool_use = False

    def mark_rendered_item(self, item: Any) -> None:
        if not isinstance(item, dict):
            return
        item_id = item.get("id")
        if isinstance(item_id, str) and item_id:
            self.rendered_item_ids.add(item_id)

    def _alloc_index(self) -> int:
        index = self.next_index
        self.next_index += 1
        return index

    def _start_block(self, output_index: int, kind: str, block: dict) -> str | None:
        if output_index in self.open_blocks or output_index in self.rendered_output_indexes:
            return None
        anthropic_index = self._alloc_index()
        self.open_blocks[output_index] = {"kind": kind, "index": anthropic_index}
        return anthropic_content_block_start_sse(anthropic_index, block)

    def _append_delta(self, output_index: int, delta: dict) -> str | None:
        record = self.open_blocks.get(output_index)
        if record is None:
            return None
        return anthropic_content_block_delta_sse(record["index"], delta)

    def _close_block(self, output_index: int, *, kind: str | None = None) -> str | None:
        record = self.open_blocks.get(output_index)
        if record is None:
            return None
        if kind is not None and record["kind"] != kind:
            return None
        self.open_blocks.pop(output_index, None)
        self.rendered_output_indexes.add(output_index)
        return anthropic_content_block_stop_sse(record["index"])

    def close_any_open_blocks(self) -> list[str]:
        events: list[str] = []
        for output_index in list(self.open_blocks):
            close = self._close_block(output_index)
            if close is not None:
                events.append(close)
        return events

    def text_delta(self, output_index: int, text: str) -> list[str]:
        if not text:
            return []
        events: list[str] = []
        if output_index not in self.open_blocks:
            start = self._start_block(output_index, "text", {"type": "text", "text": ""})
            if start is not None:
                events.append(start)
        delta = self._append_delta(output_index, {"type": "text_delta", "text": text})
        if delta is not None:
            events.append(delta)
        return events

    def thinking_delta(self, output_index: int, text: str) -> list[str]:
        if not self.thinking_enabled or not text:
            return []
        events: list[str] = []
        if output_index not in self.open_blocks:
            start = self._start_block(output_index, "thinking", {"type": "thinking", "thinking": ""})
            if start is not None:
                events.append(start)
        delta = self._append_delta(output_index, {"type": "thinking_delta", "thinking": text})
        if delta is not None:
            events.append(delta)
        return events

    def tool_start(self, output_index: int, item: dict) -> list[str]:
        """Open a ``tool_use`` content block from a function_call item."""
        if not isinstance(item, dict):
            return []
        name = str(item.get("name") or "").strip()
        if not name:
            return []
        call_id = str(item.get("call_id") or "").strip()
        if not call_id:
            call_id = f"call_{uuid.uuid4().hex}"
        self.has_tool_use = True
        if output_index in self.open_blocks or output_index in self.rendered_output_indexes:
            return []
        block = {"type": "tool_use", "id": call_id, "name": name, "input": {}}
        start = self._start_block(output_index, "tool", block)
        if start is None:
            return []
        events = [start]
        buffered = self.buffered_args.pop(output_index, "")
        if buffered:
            record = self.open_blocks[output_index]
            events.append(
                anthropic_content_block_delta_sse(
                    record["index"],
                    {"type": "input_json_delta", "partial_json": buffered},
                )
            )
        return events

    def tool_args_delta(self, output_index: int, partial_json: str) -> list[str]:
        if not partial_json:
            return []
        record = self.open_blocks.get(output_index)
        if record is None or record["kind"] != "tool":
            prior = self.buffered_args.get(output_index, "")
            self.buffered_args[output_index] = prior + partial_json
            return []
        record["args_streamed"] = True
        return [
            anthropic_content_block_delta_sse(
                record["index"],
                {"type": "input_json_delta", "partial_json": partial_json},
            )
        ]

    def tool_done(self, output_index: int, item: dict) -> list[str]:
        """Close a tool_use block on ``response.output_item.done``, appending the
        full arguments only when no ``function_call_arguments.delta`` ever
        streamed them (avoids duplicating already-emitted partials)."""
        if not isinstance(item, dict):
            return []
        events: list[str] = []
        if output_index not in self.open_blocks:
            events.extend(self.tool_start(output_index, item))
        record = self.open_blocks.get(output_index)
        if record is not None and record["kind"] == "tool":
            if not record.get("args_streamed"):
                arguments = str(item.get("arguments") or "")
                if arguments:
                    delta = self._append_delta(
                        output_index,
                        {"type": "input_json_delta", "partial_json": arguments},
                    )
                    if delta is not None:
                        events.append(delta)
            close = self._close_block(output_index, kind="tool")
            if close is not None:
                events.append(close)
        return events

    def synthesize_item(self, output_index: int, item: dict) -> list[str]:
        """Emit a complete content block for an item that never streamed deltas
        (terminal-only providers), skipping items already rendered."""
        if not isinstance(item, dict):
            return []
        item_id = item.get("id")
        if (
            output_index in self.open_blocks
            or output_index in self.rendered_output_indexes
            or (isinstance(item_id, str) and item_id in self.rendered_item_ids)
        ):
            return []
        self.mark_rendered_item(item)
        item_type = str(item.get("type") or "").strip()

        if item_type == "function_call":
            name = str(item.get("name") or "").strip()
            if not name:
                return []
            call_id = str(item.get("call_id") or "").strip()
            if not call_id:
                call_id = f"call_{uuid.uuid4().hex}"
            self.has_tool_use = True
            anthropic_index = self._alloc_index()
            self.rendered_output_indexes.add(output_index)
            return [
                anthropic_content_block_start_sse(
                    anthropic_index,
                    {"type": "tool_use", "id": call_id, "name": name, "input": {}},
                ),
                anthropic_content_block_delta_sse(
                    anthropic_index,
                    {"type": "input_json_delta", "partial_json": str(item.get("arguments") or "")},
                ),
                anthropic_content_block_stop_sse(anthropic_index),
            ]

        if item_type == "message":
            text = _message_item_text(item)
            if not text:
                return []
            anthropic_index = self._alloc_index()
            self.rendered_output_indexes.add(output_index)
            return [
                anthropic_content_block_start_sse(
                    anthropic_index,
                    {"type": "text", "text": ""},
                ),
                anthropic_content_block_delta_sse(
                    anthropic_index,
                    {"type": "text_delta", "text": text},
                ),
                anthropic_content_block_stop_sse(anthropic_index),
            ]

        if item_type == "reasoning" and self.thinking_enabled:
            summary = _reasoning_item_text(item)
            if not summary:
                return []
            anthropic_index = self._alloc_index()
            self.rendered_output_indexes.add(output_index)
            return [
                anthropic_content_block_start_sse(
                    anthropic_index,
                    {"type": "thinking", "thinking": ""},
                ),
                anthropic_content_block_delta_sse(
                    anthropic_index,
                    {"type": "thinking_delta", "thinking": summary},
                ),
                anthropic_content_block_stop_sse(anthropic_index),
            ]
        return []


def _message_item_text(item: dict) -> str:
    content = item.get("content")
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") in {"output_text", "text"}:
            text = part.get("text")
            if isinstance(text, str) and text:
                parts.append(text)
    return "".join(parts)


def _reasoning_item_text(item: dict) -> str:
    summary = item.get("summary")
    if isinstance(summary, list):
        parts = [
            str(part.get("text"))
            for part in summary
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        ]
        return "\n".join(parts)
    if isinstance(summary, str):
        return summary
    return ""


def _output_index_from_item(item: dict, output_items: list[dict]) -> int:
    """Best-effort index assignment for terminal output items."""
    if not isinstance(item, dict):
        return 0
    item_id = item.get("id")
    for position, candidate in enumerate(output_items or []):
        if not isinstance(candidate, dict):
            continue
        candidate_id = candidate.get("id")
        if item_id is not None and candidate_id is not None and str(item_id) == str(candidate_id):
            return position
    return 0


def _synthesize_terminal_missing_items(
    builder: _AnthropicStreamBuilder,
    output_items: list,
) -> list[str]:
    events: list[str] = []
    for position, item in enumerate(output_items or []):
        if not isinstance(item, dict):
            continue
        output_index = _output_index_from_item(item, output_items)
        events.extend(builder.synthesize_item(output_index or position, item))
    return events


def _new_response_id() -> str:
    return f"resp_{uuid.uuid4().hex}"


def _initial_message_start(builder: _AnthropicStreamBuilder) -> str:
    message = {
        "id": builder.message_id,
        "type": "message",
        "role": "assistant",
        "model": builder.model_name,
        "content": [],
        "stop_reason": None,
        "stop_sequence": None,
        "usage": {"input_tokens": 0, "output_tokens": 0},
    }
    return anthropic_message_start_sse(message)


def _has_function_call_output(output_items: list) -> bool:
    for item in output_items or []:
        if isinstance(item, dict) and item.get("type") == "function_call":
            return True
    return False


async def _emit_anthropic_terminal(
    builder: _AnthropicStreamBuilder,
    event_payload: dict,
    *,
    output_item_collector: ResponsesOutputItemCollector,
    output_items_by_index: dict[int, dict],
    output_items_fallback: list[dict],
) -> AsyncIterator[str]:
    terminal_output = safe_get(event_payload, "response", "output", default=None)
    if isinstance(terminal_output, list) and terminal_output:
        await output_item_collector.discard_collected()
    await output_item_collector.validate_completed_output(event_payload)
    patched_payload = patch_responses_completed_output(
        event_payload,
        output_items_by_index=output_items_by_index,
        output_items_fallback=output_items_fallback,
    )

    response_object = patched_payload.get("response")
    if not isinstance(response_object, dict):
        response_object = patched_payload
    model_name = extract_response_model_name(patched_payload) or builder.model_name
    builder.model_name = model_name

    output_items = safe_get(response_object, "output", default=None)
    if not isinstance(output_items, list):
        output_items = []

    # Close blocks that were streamed but never finished by output_item.done,
    # then synthesize content that only arrived inside the terminal body.
    events = builder.close_any_open_blocks()
    events.extend(_synthesize_terminal_missing_items(builder, output_items))
    for event in events:
        yield event

    has_tool_use = builder.has_tool_use or _has_function_call_output(output_items)
    usage = responses_usage_to_anthropic_usage(response_object.get("usage"))
    if usage is None:
        usage = {"input_tokens": 0, "output_tokens": 0}
    stop_reason = responses_stop_reason(response_object, has_tool_use=has_tool_use)
    yield anthropic_message_delta_sse({"stop_reason": stop_reason}, usage)
    yield anthropic_message_stop_sse()


async def _stream_responses_to_anthropic_impl(
    text_iterator,
    *,
    request_model: str,
    upstream_status_code: int | None = None,
    thinking_enabled: bool = False,
    max_collected_output_items: int = DEFAULT_MAX_COLLECTED_OUTPUT_ITEMS,
    max_collected_output_bytes: int = DEFAULT_MAX_COLLECTED_OUTPUT_BYTES,
    _collector_holder: list[ResponsesOutputItemCollector],
) -> AsyncIterator[str]:
    model_name = normalize_optional_text(request_model) or "unknown"
    builder = _AnthropicStreamBuilder(
        model_name=model_name,
        message_id=_new_message_id(),
        thinking_enabled=thinking_enabled,
    )
    response_id = _new_response_id()
    created_at = int(datetime.timestamp(datetime.now()))
    completed_seen = False
    error_seen = False
    output_items_by_index: dict[int, dict] = {}
    output_items_fallback: list[dict] = []
    output_item_collector = ResponsesOutputItemCollector(
        output_items_by_index=output_items_by_index,
        output_items_fallback=output_items_fallback,
        max_items=max_collected_output_items,
        max_bytes=max_collected_output_bytes,
    )
    _collector_holder.append(output_item_collector)

    async def terminal(event_payload: dict) -> AsyncIterator[str]:
        nonlocal completed_seen
        completed_seen = True
        async for event in _emit_anthropic_terminal(
            builder,
            event_payload,
            output_item_collector=output_item_collector,
            output_items_by_index=output_items_by_index,
            output_items_fallback=output_items_fallback,
        ):
            yield event

    raw_event_source = iter_sse_events(text_iterator)
    async with aclosing(raw_event_source):
        yield _initial_message_start(builder)
        async for raw_event in raw_event_source:
            event_owner = await parse_owned_sse_event(raw_event)
            event_payload = None
            event_type = None
            try:
                if event_owner.is_comment:
                    continue
                if not event_owner.has_data_field:
                    continue
                event_type = event_owner.event_name
                event_payload = event_owner.payload

                if event_type == "[DONE]":
                    synthetic = build_missing_responses_completed_payload(
                        completed_response_seen=completed_seen,
                        error_seen=error_seen,
                        response_id=response_id,
                        model_name=builder.model_name,
                        created_at=created_at,
                        output_items_by_index=output_items_by_index,
                        output_items_fallback=output_items_fallback,
                    )
                    if synthetic is not None:
                        async for event in terminal(synthetic):
                            yield event
                        return
                    if error_seen:
                        return
                    yield anthropic_message_delta_sse(
                        {"stop_reason": "end_turn"},
                        {"input_tokens": 0, "output_tokens": 0},
                    )
                    yield anthropic_message_stop_sse()
                    return

                validate_sse_event_type_consistency(
                    event_owner.declared_event_name,
                    event_payload,
                    protocol_name="Responses",
                    has_event_field=event_owner.has_event_field,
                    require_event_name=True,
                )

                if event_type in ("error", "response.failed"):
                    error_seen = True
                    raise SSEProtocolError(
                        f"Responses upstream terminal event '{event_type}'"
                    )

                if event_type == "keepalive":
                    continue

                if isinstance(event_payload, dict):
                    builder.model_name = (
                        extract_response_model_name(event_payload) or builder.model_name
                    )
                    response_id = chat_completion_response_id_from_payload(event_payload, response_id)
                    created_at = chat_completion_created_at_from_payload(event_payload, created_at)

                if event_type == "response.output_item.added" and isinstance(event_payload, dict):
                    item = event_payload.get("item")
                    output_index = coerce_positive_int(event_payload.get("output_index"))
                    if output_index is None:
                        output_index = 0
                    if isinstance(item, dict) and item.get("type") == "function_call":
                        for event in builder.tool_start(output_index, item):
                            yield event
                    continue

                if event_type == "response.output_text.delta" and isinstance(event_payload, dict):
                    delta_text = str(event_payload.get("delta") or "")
                    output_index = coerce_positive_int(event_payload.get("output_index"))
                    if output_index is None:
                        output_index = 0
                    for event in builder.text_delta(output_index, delta_text):
                        yield event
                    continue

                if event_type == "response.reasoning_summary_text.delta" and isinstance(event_payload, dict):
                    delta_text = str(event_payload.get("delta") or "")
                    output_index = coerce_positive_int(event_payload.get("output_index"))
                    if output_index is None:
                        output_index = 0
                    for event in builder.thinking_delta(output_index, delta_text):
                        yield event
                    continue

                if event_type == "response.reasoning_summary_text.done":
                    output_index = coerce_positive_int(
                        event_payload.get("output_index") if isinstance(event_payload, dict) else None
                    )
                    if output_index is None:
                        output_index = 0
                    close = builder._close_block(output_index, kind="thinking")
                    if close is not None:
                        yield close
                    continue

                if event_type == "response.function_call_arguments.delta" and isinstance(event_payload, dict):
                    partial = str(event_payload.get("delta") or "")
                    output_index = coerce_positive_int(event_payload.get("output_index"))
                    if output_index is None:
                        output_index = 0
                    for event in builder.tool_args_delta(output_index, partial):
                        yield event
                    continue

                if event_type == "response.output_item.done" and isinstance(event_payload, dict):
                    await output_item_collector.collect(event_payload, event_owner=event_owner)
                    item = event_payload.get("item")
                    output_index = coerce_positive_int(event_payload.get("output_index"))
                    if output_index is None:
                        output_index = 0
                    if isinstance(item, dict) and item.get("type") == "function_call":
                        for event in builder.tool_done(output_index, item):
                            yield event
                        builder.mark_rendered_item(item)
                    elif isinstance(item, dict) and item.get("type") == "reasoning":
                        close = builder._close_block(output_index, kind="thinking")
                        if close is not None:
                            yield close
                        builder.mark_rendered_item(item)
                    else:
                        record = builder.open_blocks.get(output_index)
                        if record is not None:
                            # Previously streamed deltas: just close the block.
                            close = builder._close_block(output_index)
                            if close is not None:
                                yield close
                            builder.mark_rendered_item(item)
                        else:
                            # Terminal-only item that was never streamed: emit it
                            # now from the finished item so [DONE]/terminal paths
                            # do not have to re-derive content.
                            for event in builder.synthesize_item(output_index, item):
                                yield event
                    continue

                if event_type == "response.incomplete" and isinstance(event_payload, dict):
                    async for event in terminal(event_payload):
                        yield event
                    return

                if event_type == "response.completed" and isinstance(event_payload, dict):
                    async for event in terminal(event_payload):
                        yield event
                    return
            finally:
                event_payload = None
                event_type = None
                await event_owner.aclose()
                event_owner = None

    synthetic = build_missing_responses_completed_payload(
        completed_response_seen=completed_seen,
        error_seen=error_seen,
        response_id=response_id,
        model_name=builder.model_name,
        created_at=created_at,
        output_items_by_index=output_items_by_index,
        output_items_fallback=output_items_fallback,
    )
    if synthetic is not None:
        async for event in terminal(synthetic):
            yield event
        return
    if error_seen:
        return
    raise SSEProtocolError(
        "Responses stream ended without response.completed, error, or [DONE]"
    )


async def stream_responses_to_anthropic(
    text_iterator,
    *,
    request_model: str,
    upstream_status_code: int | None = None,
    thinking_enabled: bool = False,
    max_collected_output_items: int = DEFAULT_MAX_COLLECTED_OUTPUT_ITEMS,
    max_collected_output_bytes: int = DEFAULT_MAX_COLLECTED_OUTPUT_BYTES,
) -> AsyncIterator[str]:
    """Convert Responses SSE into Anthropic SSE while closing every transferred
    memory owner (mirrors ``stream_responses_to_chat_completions``)."""
    collector_holder: list[ResponsesOutputItemCollector] = []
    implementation = _stream_responses_to_anthropic_impl(
        text_iterator,
        request_model=request_model,
        upstream_status_code=upstream_status_code,
        thinking_enabled=thinking_enabled,
        max_collected_output_items=max_collected_output_items,
        max_collected_output_bytes=max_collected_output_bytes,
        _collector_holder=collector_holder,
    )
    try:
        async for chunk in implementation:
            yield chunk
    finally:
        try:
            await implementation.aclose()
        finally:
            try:
                if collector_holder:
                    await collector_holder[0].aclose()
            finally:
                await close_async_iterator_safely(
                    text_iterator,
                    label="Responses-to-Anthropic source iterator",
                )
