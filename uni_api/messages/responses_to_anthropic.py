"""Translate upstream Responses-protocol payloads back into Anthropic messages.

Pure, side-effect free conversions shared by the non-streaming and streaming
renderers:

* ``anthropic_message_from_responses`` - Responses response object -> Anthropic
  ``/v1/messages`` (non-streaming) message object.
* ``responses_usage_to_anthropic_usage`` - Responses ``usage`` -> Anthropic usage.
* ``responses_error_to_anthropic_error`` - Responses/OpenAI error body -> the
  Anthropic ``{type:"error", error:{...}}`` shape expected by Anthropic clients.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from core.utils import safe_get

# Responses output item types that become Anthropic content blocks.
_RESPONSES_MESSAGE_ITEM = "message"
_RESPONSES_FUNCTION_CALL_ITEM = "function_call"
_RESPONSES_REASONING_ITEM = "reasoning"

_TEXT_PART_TYPES = frozenset({"output_text", "text"})


def _unwrap_response(payload: dict) -> dict:
    """Stream terminal events nest the response under ``response``."""
    if isinstance(payload, dict) and isinstance(payload.get("response"), dict):
        return payload["response"]
    return payload


def _responses_model_name(payload: dict) -> str | None:
    for key in ("model", "model_name"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _safe_json_arguments(arguments: Any) -> dict:
    if isinstance(arguments, dict):
        return arguments
    raw = str(arguments or "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except Exception:
        return {}
    if isinstance(parsed, dict):
        return parsed
    return {}


def responses_usage_to_anthropic_usage(usage_obj: object) -> dict | None:
    """Map Responses usage onto the Anthropic usage shape.

    Responses counts output (including reasoning) under ``output_tokens`` and
    keeps reasoning separately in ``output_tokens_details.reasoning_tokens``;
    Anthropic exposes those as ``output_tokens_details.thinking_tokens``.
    """
    if not isinstance(usage_obj, dict):
        return None
    if all(
        usage_obj.get(key) is None
        for key in ("prompt_tokens", "input_tokens", "completion_tokens", "output_tokens", "total_tokens")
    ):
        return None

    input_tokens = usage_obj.get("input_tokens")
    if input_tokens is None:
        input_tokens = usage_obj.get("prompt_tokens")

    output_tokens = usage_obj.get("output_tokens")
    if output_tokens is None:
        output_tokens = usage_obj.get("completion_tokens")

    input_details = usage_obj.get("input_tokens_details")
    if not isinstance(input_details, dict):
        input_details = usage_obj.get("prompt_tokens_details")
    if not isinstance(input_details, dict):
        input_details = {}

    output_details = usage_obj.get("output_tokens_details")
    if not isinstance(output_details, dict):
        output_details = usage_obj.get("completion_tokens_details")
    if not isinstance(output_details, dict):
        output_details = {}

    try:
        input_tokens = int(input_tokens or 0)
    except Exception:
        input_tokens = 0
    try:
        output_tokens = int(output_tokens or 0)
    except Exception:
        output_tokens = 0

    usage: dict[str, Any] = {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    }

    try:
        cached_tokens = int(input_details.get("cached_tokens") or 0)
    except Exception:
        cached_tokens = 0
    if cached_tokens:
        usage["cache_read_input_tokens"] = cached_tokens

    try:
        reasoning_tokens = int(output_details.get("reasoning_tokens") or 0)
    except Exception:
        reasoning_tokens = 0
    if reasoning_tokens:
        usage.setdefault("output_tokens_details", {})["thinking_tokens"] = reasoning_tokens

    return usage


def _anthropic_stop_reason(response: dict, *, has_tool_use: bool) -> str:
    if has_tool_use:
        return "tool_use"
    status = str(response.get("status") or "").strip().lower()
    incomplete_reason = str(
        safe_get(response, "incomplete_details", "reason", default="") or ""
    ).strip().lower()
    if status == "incomplete" or incomplete_reason:
        if incomplete_reason in {"content_filter", "safety"}:
            return "refusal"
        return "max_tokens"
    return "end_turn"


def responses_stop_reason(response: dict, *, has_tool_use: bool) -> str:
    """Public wrapper of the Responses -> Anthropic stop-reason mapping."""
    return _anthropic_stop_reason(response, has_tool_use=has_tool_use)


def _content_blocks_from_output_items(
    output_items: object,
    *,
    thinking_enabled: bool,
) -> tuple[list[dict], bool]:
    """Responses ``output`` items -> Anthropic content blocks.

    Returns ``(content, has_tool_use)``.
    """
    content: list[dict] = []
    has_tool_use = False
    if not isinstance(output_items, list):
        return content, has_tool_use

    for item in output_items:
        if not isinstance(item, dict):
            continue
        item_type = str(item.get("type") or "").strip()

        if item_type == _RESPONSES_MESSAGE_ITEM:
            parts = item.get("content")
            if not isinstance(parts, list):
                continue
            for part in parts:
                if not isinstance(part, dict):
                    continue
                part_type = str(part.get("type") or "").strip()
                if part_type not in _TEXT_PART_TYPES:
                    continue
                text = part.get("text")
                if not isinstance(text, str) or not text:
                    continue
                content.append({"type": "text", "text": text})

        elif item_type == _RESPONSES_FUNCTION_CALL_ITEM:
            name = item.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            has_tool_use = True
            call_id = str(item.get("call_id") or "").strip()
            if not call_id:
                call_id = f"call_{uuid.uuid4().hex}"
            content.append(
                {
                    "type": "tool_use",
                    "id": call_id,
                    "name": name,
                    "input": _safe_json_arguments(item.get("arguments")),
                }
            )

        elif item_type == _RESPONSES_REASONING_ITEM and thinking_enabled:
            summary = item.get("summary")
            if isinstance(summary, list):
                texts = [
                    str(part.get("text"))
                    for part in summary
                    if isinstance(part, dict) and isinstance(part.get("text"), str)
                ]
                summary_text = "\n".join(texts)
            else:
                summary_text = str(summary or "")
            if summary_text.strip():
                content.append({"type": "thinking", "thinking": summary_text})

    return content, has_tool_use


def anthropic_message_from_responses(
    payload: dict,
    *,
    fallback_model: str,
    thinking_enabled: bool = False,
) -> dict:
    """Build an Anthropic non-streaming message object from a Responses response."""
    response = _unwrap_response(payload)
    output_items = safe_get(response, "output", default=None)
    if output_items is None and isinstance(payload, dict):
        output_items = payload.get("output")
    if not isinstance(output_items, list):
        output_items = []

    content, has_tool_use = _content_blocks_from_output_items(
        output_items,
        thinking_enabled=thinking_enabled,
    )
    usage = responses_usage_to_anthropic_usage(response.get("usage"))
    if usage is None:
        usage = responses_usage_to_anthropic_usage(
            safe_get(payload, "response", "usage", default=None)
        )
    if usage is None:
        usage = {"input_tokens": 0, "output_tokens": 0}

    model = _responses_model_name(response) or fallback_model
    message: dict[str, Any] = {
        "id": f"msg_{uuid.uuid4().hex}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": _anthropic_stop_reason(response, has_tool_use=has_tool_use),
        "stop_sequence": None,
        "usage": usage,
    }
    return message


_OPENAI_TO_ANTHROPIC_ERROR_TYPES = {
    "invalid_request_error": "invalid_request_error",
    "authentication_error": "authentication_error",
    "permission_error": "permission_error",
    "not_found_error": "not_found_error",
    "rate_limit_error": "rate_limit_error",
    "api_error": "api_error",
    "timeout_error": "api_error",
    "overloaded_error": "overloaded_error",
    "bad_request": "invalid_request_error",
    "server_error": "api_error",
}


def _anthropic_error_type_from_openai(error: dict, status: int | None) -> str:
    error_type = str(error.get("type") or "").strip().lower()
    if error_type in _OPENAI_TO_ANTHROPIC_ERROR_TYPES:
        return _OPENAI_TO_ANTHROPIC_ERROR_TYPES[error_type]

    code = str(error.get("code") or "").strip().lower()
    if code in _OPENAI_TO_ANTHROPIC_ERROR_TYPES:
        return _OPENAI_TO_ANTHROPIC_ERROR_TYPES[code]

    if status is not None:
        if status == 401 or status == 403:
            return "authentication_error"
        if status == 404:
            return "not_found_error"
        if status == 429:
            return "rate_limit_error"
        if status >= 500:
            return "api_error"
    return "invalid_request_error"


def anthropic_error_from_upstream(
    raw_body: bytes | str | dict | None,
    status: int | None,
) -> dict:
    """Translate an upstream Responses/OpenAI error body to the Anthropic error
    shape returned to ``/v1/messages`` clients."""
    error: dict[str, Any] = {}
    if isinstance(raw_body, dict):
        error = raw_body
    elif isinstance(raw_body, bytes):
        try:
            parsed = json.loads(raw_body.decode("utf-8", errors="replace"))
        except Exception:
            parsed = None
        if isinstance(parsed, dict):
            error = parsed
    elif isinstance(raw_body, str):
        try:
            parsed = json.loads(raw_body)
        except Exception:
            parsed = None
        if isinstance(parsed, dict):
            error = parsed

    error_object = error.get("error")
    if not isinstance(error_object, dict):
        error_object = {}

    message = error_object.get("message")
    if not isinstance(message, str) or not message.strip():
        if isinstance(error.get("message"), str) and error["message"].strip():
            message = error["message"]
        else:
            message = f"Upstream provider error (status {status or 'unknown'})"

    error_type = _anthropic_error_type_from_openai(error_object, status)
    params = error_object.get("param")
    if isinstance(params, str) and params.strip():
        message = f"{message} (parameter: {params})"

    return {
        "type": "error",
        "error": {"type": error_type, "message": message},
    }


def anthropic_error_body_bytes(
    raw_body: bytes | str | dict | None,
    status: int | None,
) -> bytes:
    payload = anthropic_error_from_upstream(raw_body, status)
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")
