"""Translation of Anthropic ``/v1/messages`` requests into the OpenAI Responses API.

This module converts an inbound Anthropic request body (``system``, ``messages``
with text/image/tool_use/tool_result content blocks, ``tools``/``tool_choice``,
``thinking``, sampling knobs) into an upstream Responses-protocol request body.
It intentionally works directly on the Anthropic wire shape instead of
round-tripping through the OpenAI-shaped ``RequestModel``: Anthropic interleaves
``tool_result`` blocks inside user messages and separates ``system`` from the
conversation, neither of which survives an OpenAI ``role:"tool"`` detour without
loss.

Supported upstream dialects (selected by the caller after ``get_engine``):

* ``engine == "gpt"``  - a generic Responses endpoint whose ``base_url`` points
  at ``.../v1/responses`` (Bearer auth).
* ``engine == "codex"`` - a Codex/ChatGPT Responses endpoint (``/responses``,
  Codex-specific headers, ``store: false``).
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from uni_api.providers.header_passthrough import apply_provider_preference_headers
from uni_api.providers.overrides import apply_post_body_parameter_overrides
from uni_api.providers.payloads import (
    force_codex_client_headers,
    strip_unsupported_codex_payload_fields,
)
from uni_api.upstream.urls import normalize_responses_upstream_url

# Reasoning-effort heuristic for Anthropic thinking budgets (Responses has no
# budget_tokens knob, only an effort string).
_THINKING_BUDGET_HIGH = 16000
_THINKING_BUDGET_MEDIUM = 4000

_TEXT_BLOCK_TYPES = frozenset({"text", "output_text", "input_text"})
_IMAGE_BLOCK_TYPES = frozenset({"image", "input_image"})
_THINKING_BLOCK_TYPES = frozenset({"thinking", "redacted_thinking", "signature"})


def budget_to_reasoning_effort(budget: Any) -> str:
    """Map an Anthropic thinking ``budget_tokens`` value to a Responses effort."""
    try:
        parsed = int(budget)
    except Exception:
        return "medium"
    if parsed >= _THINKING_BUDGET_HIGH:
        return "high"
    if parsed >= _THINKING_BUDGET_MEDIUM:
        return "medium"
    return "low"


def anthropic_thinking_enabled(request_body: dict) -> bool:
    thinking = request_body.get("thinking")
    return isinstance(thinking, dict) and thinking.get("type") == "enabled"


def anthropic_thinking_effort(request_body: dict) -> str:
    thinking = request_body.get("thinking")
    if isinstance(thinking, dict) and thinking.get("type") == "enabled":
        return budget_to_reasoning_effort(thinking.get("budget_tokens"))
    return "medium"


def _coerce_block_text(value: Any) -> str | None:
    """Return plain text from a block, or ``None`` when it carries no text."""
    if isinstance(value, str):
        return value if value.strip() else None
    if not isinstance(value, dict):
        return None
    block_type = value.get("type")
    text = value.get("text")
    if block_type in _TEXT_BLOCK_TYPES and isinstance(text, str) and text:
        return text
    return None


def _coerce_output_text(content: Any) -> str:
    """Flatten message/block content (string, list of text blocks, or tool_result
    content) into a single text string for Responses ``output`` fields."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        text = _coerce_block_text(item)
        if text is not None:
            parts.append(text)
    return "\n".join(parts)


def _content_block_is_image(block: Any) -> bool:
    return isinstance(block, dict) and block.get("type") in _IMAGE_BLOCK_TYPES


def _content_block_is_tool_use(block: Any) -> bool:
    return isinstance(block, dict) and block.get("type") == "tool_use"


def _content_block_is_tool_result(block: Any) -> bool:
    return isinstance(block, dict) and block.get("type") == "tool_result"


def _content_block_is_thinking(block: Any) -> bool:
    return isinstance(block, dict) and block.get("type") in _THINKING_BLOCK_TYPES


def _input_image_part(block: dict) -> dict | None:
    """Map an Anthropic image block to a Responses ``input_image`` content part."""
    source = block.get("source")
    if not isinstance(source, dict):
        return None
    source_type = source.get("type")
    if source_type == "base64":
        media_type = str(source.get("media_type") or "image/png")
        data = str(source.get("data") or "")
        return {
            "type": "input_image",
            "image_url": f"data:{media_type};base64,{data}",
        }
    if source_type in ("url", "http", "https"):
        url = source.get("url")
        if isinstance(url, str) and url:
            return {"type": "input_image", "image_url": url}
    return None


def _system_instructions_and_images(system: Any) -> tuple[str | None, list[dict]]:
    """Split Anthropic ``system`` into a Responses ``instructions`` string and any
    image parts that must be folded into the input (Responses instructions is
    text-only)."""
    text_parts: list[str] = []
    images: list[dict] = []
    if isinstance(system, str):
        if system.strip():
            text_parts.append(system)
        return ("\n\n".join(text_parts) if text_parts else None), images
    if not isinstance(system, list):
        return None, images
    for block in system:
        if not isinstance(block, dict):
            continue
        text = _coerce_block_text(block)
        if text is not None:
            text_parts.append(text)
            continue
        if _content_block_is_image(block):
            part = _input_image_part(block)
            if part is not None:
                images.append(part)
    instructions = "\n\n".join(text_parts) if text_parts else None
    return instructions, images


def _responses_tools(request_body: dict) -> list[dict]:
    tools: list[dict] = []
    for tool in request_body.get("tools") or []:
        if not isinstance(tool, dict):
            continue
        name = str(tool.get("name") or "").strip()
        if not name:
            continue
        item: dict[str, Any] = {"type": "function", "name": name}
        description = tool.get("description")
        if isinstance(description, str) and description.strip():
            item["description"] = description
        input_schema = tool.get("input_schema")
        if isinstance(input_schema, dict):
            item["parameters"] = input_schema
        elif isinstance(input_schema, str):
            try:
                parsed = json.loads(input_schema)
                if isinstance(parsed, dict):
                    item["parameters"] = parsed
            except Exception:
                pass
        tools.append(item)
    return tools


def _responses_tool_choice(request_body: dict) -> Any:
    choice = request_body.get("tool_choice")
    if choice is None:
        return None
    if isinstance(choice, str):
        return choice
    if not isinstance(choice, dict):
        return None
    choice_type = str(choice.get("type") or "").strip()
    if choice_type == "auto":
        return "auto"
    if choice_type == "any":
        return "required"
    if choice_type == "disabled" or choice_type == "none":
        return "none"
    if choice_type == "tool":
        name = str(choice.get("name") or "").strip()
        if name:
            return {"type": "function", "name": name}
        return "required"
    return None


def _assistant_input_item(content_value: Any, tools_enabled: bool) -> list[dict]:
    """Flatten an Anthropic assistant message into Responses input items."""
    blocks: list = []
    if isinstance(content_value, str):
        if content_value.strip():
            blocks = [{"type": "text", "text": content_value}]
    elif isinstance(content_value, list):
        blocks = content_value

    items: list[dict] = []
    text_parts: list[dict] = []
    pending_text = False

    def flush_text() -> None:
        nonlocal pending_text
        if pending_text and text_parts:
            items.append(
                {"type": "message", "role": "assistant", "content": list(text_parts)}
            )
        text_parts.clear()
        pending_text = False

    for block in blocks:
        if not isinstance(block, dict):
            continue
        text = _coerce_block_text(block)
        if text is not None:
            text_parts.append({"type": "output_text", "text": text})
            pending_text = True
            continue
        if _content_block_is_tool_use(block):
            if not tools_enabled:
                continue
            flush_text()
            call_id = str(block.get("id") or f"call_{id(block):x}")
            name = str(block.get("name") or "").strip()
            arguments = block.get("input")
            if not isinstance(arguments, dict):
                arguments = {}
            items.append(
                {
                    "type": "function_call",
                    "call_id": call_id,
                    "name": name,
                    "arguments": json.dumps(arguments, ensure_ascii=False),
                }
            )
            continue
        # Thinking/signature/redacted_thinking and other assistant-only metadata
        # blocks are never replayed into upstream history.
        if _content_block_is_thinking(block):
            continue
    flush_text()
    return items


def _user_input_items(content_value: Any, tools_enabled: bool) -> list[dict]:
    """Flatten an Anthropic user message into Responses input items, preserving
    the interleaving of text, image and tool_result blocks."""
    blocks: list = []
    if isinstance(content_value, str):
        if content_value.strip():
            blocks = [{"type": "text", "text": content_value}]
    elif isinstance(content_value, list):
        blocks = content_value

    items: list[dict] = []
    content_parts: list[dict] = []
    pending_parts = False

    def flush_user() -> None:
        nonlocal pending_parts
        if pending_parts and content_parts:
            items.append({"type": "message", "role": "user", "content": list(content_parts)})
        content_parts.clear()
        pending_parts = False

    for block in blocks:
        if not isinstance(block, dict):
            continue
        text = _coerce_block_text(block)
        if text is not None:
            content_parts.append({"type": "input_text", "text": text})
            pending_parts = True
            continue
        if _content_block_is_image(block):
            part = _input_image_part(block)
            if part is not None:
                content_parts.append(part)
                pending_parts = True
            continue
        if _content_block_is_tool_result(block):
            if not tools_enabled:
                continue
            flush_user()
            call_id = str(block.get("tool_use_id") or "").strip()
            output = _coerce_output_text(block.get("content"))
            if block.get("is_error"):
                if output:
                    output = f"Error: {output}"
                else:
                    output = "Error: tool invocation failed"
            item: dict[str, Any] = {
                "type": "function_call_output",
                "call_id": call_id,
                "output": output,
            }
            items.append(item)
            continue
        # Unknown user-only blocks (e.g. document fallbacks) are skipped.
    flush_user()
    return items


def _fold_system_images_into_user_items(input_items: list[dict], image_parts: list[dict]) -> None:
    if not image_parts:
        return
    for item in input_items:
        if (
            isinstance(item, dict)
            and item.get("type") == "message"
            and item.get("role") == "user"
            and isinstance(item.get("content"), list)
        ):
            item["content"] = list(image_parts) + item["content"]
            return
    input_items.insert(
        0,
        {"type": "message", "role": "user", "content": list(image_parts)},
    )


def _responses_input_items(request_body: dict, tools_enabled: bool) -> list[dict]:
    input_items: list[dict] = []
    for message in request_body.get("messages") or []:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").strip()
        content_value = message.get("content")
        if role == "assistant":
            input_items.extend(_assistant_input_item(content_value, tools_enabled))
        elif role == "user":
            input_items.extend(_user_input_items(content_value, tools_enabled))
        else:
            # Anthropic only permits user/assistant conversation roles; ignore
            # stray system-ish messages (they should have been the top-level
            # ``system`` parameter).
            continue
    return input_items


def _assemble_gpt_payload(
    request_body: dict,
    original_model: str,
    tools_enabled: bool,
) -> tuple[dict, bool]:
    stream = bool(request_body.get("stream"))
    thinking_enabled = anthropic_thinking_enabled(request_body)

    payload: dict[str, Any] = {
        "model": original_model,
        "input": _responses_input_items(request_body, tools_enabled),
    }

    instructions, image_parts = _system_instructions_and_images(request_body.get("system"))
    if instructions is not None:
        payload["instructions"] = instructions
    if image_parts:
        _fold_system_images_into_user_items(payload["input"], image_parts)

    if tools_enabled:
        tools = _responses_tools(request_body)
        if tools:
            payload["tools"] = tools
        tool_choice = _responses_tool_choice(request_body)
        if tool_choice is not None:
            payload["tool_choice"] = tool_choice

    # Sampling knobs (Anthropic names -> Responses names).  top_k and
    # stop_sequences have no Responses equivalent and are intentionally dropped
    # so providers do not reject unknown fields.
    if request_body.get("stream") is not None:
        payload["stream"] = stream
    if request_body.get("max_tokens") is not None:
        try:
            payload["max_output_tokens"] = int(request_body["max_tokens"])
        except Exception:
            pass
    if request_body.get("temperature") is not None:
        payload["temperature"] = request_body["temperature"]
    if request_body.get("top_p") is not None:
        payload["top_p"] = request_body["top_p"]

    metadata = request_body.get("metadata")
    if isinstance(metadata, dict):
        payload["metadata"] = metadata

    if thinking_enabled:
        effort = anthropic_thinking_effort(request_body)
        payload["reasoning"] = {"effort": effort}
        payload["include"] = ["reasoning.summary_text"]

    return payload, thinking_enabled


def _assemble_codex_payload(
    request_body: dict,
    original_model: str,
    tools_enabled: bool,
) -> tuple[dict, bool]:
    stream = bool(request_body.get("stream"))
    thinking_enabled = anthropic_thinking_enabled(request_body)
    effort = (
        anthropic_thinking_effort(request_body)
        if thinking_enabled
        else "medium"
    )

    payload: dict[str, Any] = {
        "model": original_model,
        "input": _responses_input_items(request_body, tools_enabled),
        "parallel_tool_calls": True,
        "reasoning": {"effort": effort, "summary": "auto"},
        "include": ["reasoning.encrypted_content"],
        "store": False,
    }

    instructions, image_parts = _system_instructions_and_images(request_body.get("system"))
    if instructions is not None:
        payload["instructions"] = instructions
    if image_parts:
        _fold_system_images_into_user_items(payload["input"], image_parts)

    if tools_enabled:
        tools = _responses_tools(request_body)
        if tools:
            payload["tools"] = tools
        tool_choice = _responses_tool_choice(request_body)
        if tool_choice is not None:
            payload["tool_choice"] = tool_choice

    if request_body.get("stream") is not None:
        payload["stream"] = stream
    if request_body.get("temperature") is not None:
        payload["temperature"] = request_body["temperature"]

    metadata = request_body.get("metadata")
    if isinstance(metadata, dict):
        payload["metadata"] = metadata

    # Codex rejects Response bodies carrying Chat-style extras; match the
    # existing chat-completion Codex hardening exactly.
    strip_unsupported_codex_payload_fields(payload)
    return payload, thinking_enabled


async def build_responses_upstream_request(
    *,
    request_body: dict,
    provider: dict,
    engine: str,
    original_model: str,
    api_key: str | None,
    codex_account_id: str | None = None,
    http_request: Any | None = None,
    request_model_name: str | None = None,
) -> tuple[str, dict, dict]:
    """Build the upstream Responses (url, headers, payload) for an Anthropic
    ``/v1/messages`` body.

    ``api_key`` must already be resolved for the upstream: a Bearer token for
    ``gpt``-style Responses endpoints, or a Codex access token plus an optional
    ``codex_account_id`` for ``codex``-style endpoints.
    """
    base_url = str(provider.get("base_url") or "").strip()
    if not base_url:
        raise ValueError("messages Responses upstream requires provider base_url")

    stream = bool(request_body.get("stream"))
    tools_enabled = provider.get("tools") is not False
    engine_key = str(engine or "").strip().lower()
    is_codex = engine_key == "codex"

    url = normalize_responses_upstream_url(base_url, "codex" if is_codex else "gpt")

    if is_codex:
        payload, thinking_enabled = _assemble_codex_payload(
            request_body,
            original_model,
            tools_enabled,
        )
    else:
        payload, thinking_enabled = _assemble_gpt_payload(
            request_body,
            original_model,
            tools_enabled,
        )

    apply_post_body_parameter_overrides(
        payload,
        provider,
        str(request_model_name or request_body.get("model") or "").strip(),
        skip_keys={"service_tier"},
    )

    headers: dict[str, Any] = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if stream else "application/json",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    if is_codex:
        if codex_account_id:
            headers["Chatgpt-Account-Id"] = str(codex_account_id)
        headers.setdefault("Openai-Beta", "responses=experimental")
        headers.setdefault("Originator", "codex_cli_rs")
        session_id = str(uuid.uuid4())
        headers.setdefault("Session_id", session_id)
        headers.setdefault("Conversation_id", session_id)
        headers.setdefault("Connection", "Keep-Alive")
        force_codex_client_headers(headers)

    apply_provider_preference_headers(headers, provider, http_request=http_request)
    if is_codex:
        force_codex_client_headers(headers)

    return url, headers, payload
