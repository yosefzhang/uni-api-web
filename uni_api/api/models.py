from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any, Callable

from core.utils import get_model_dict


MODEL_INFO_CREATED = 1720524448858
CODEX_PRO_MODELS_SNAPSHOT_CLIENT_VERSION = "0.153.2"
CODEX_PRO_MODELS_SNAPSHOT_UPSTREAM_ETAG = 'W/"568f1e5faa711c9a79e1426428e2ea34"'
GPT6_ASTRA_CONTEXT_WINDOW = 600000
GPT6_ASTRA_MAX_CONTEXT_WINDOW = 872000

_CODEX_PRO_MODELS_SNAPSHOT = json.loads(
    Path(__file__).with_name("codex_models_pro_0_153_2.json").read_text(encoding="utf-8")
)
_CODEX_PRO_MODELS_BY_SLUG = {
    str(model["slug"]).strip(): model
    for model in _CODEX_PRO_MODELS_SNAPSHOT["models"]
    if isinstance(model, dict) and str(model.get("slug", "")).strip()
}
_CODEX_PRO_MODEL_FAMILIES = sorted(_CODEX_PRO_MODELS_BY_SLUG, key=len, reverse=True)
_CODEX_FALLBACK_BASE_INSTRUCTIONS = (
    "You are Codex, a coding agent. You and the user share one workspace, and your job is to collaborate "
    "with them until their goal is genuinely handled.\n\n"
    "Read the codebase before making changes, prefer existing project patterns, and keep edits focused on "
    "the requested behavior. Use fast search tools such as rg when available. Preserve unrelated user "
    "changes and never run destructive git commands unless the user explicitly asks for them.\n\n"
    "When editing files, use patch-oriented changes, keep comments sparse and useful, and avoid broad "
    "refactors unless they are required for the fix. Validate your work with the narrowest relevant tests "
    "first, then broader tests when risk warrants it. If a command fails, inspect the failure and continue "
    "from the concrete cause.\n\n"
    "Communicate concise progress while working and finish with the important outcome, changed files, "
    "verification performed, and any remaining risk."
)
_CODEX_FALLBACK_REASONING_LEVELS = [
    {"effort": "low", "description": "Fast responses with lighter reasoning"},
    {
        "effort": "medium",
        "description": "Balances speed and reasoning depth for everyday tasks",
    },
    {"effort": "high", "description": "Greater reasoning depth for complex problems"},
    {
        "effort": "xhigh",
        "description": "Extra high reasoning depth for complex problems",
    },
]
_CODEX_BLOCKED_MODEL_TOKENS = (
    "audio",
    "dall-e",
    "embedding",
    "image",
    "moderation",
    "rerank",
    "seedance",
    "sora",
    "speech",
    "tts",
    "video",
    "whisper",
)

def _load_model_extern_config() -> dict[str, dict[str, Any]]:
    runtime_path = Path(
        os.environ.get("UNI_API_MODEL_CONTEXT_PATH", "data/model_extern_config.json")
    )
    try:
        return json.loads(runtime_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        runtime_path.parent.mkdir(parents=True, exist_ok=True)
        runtime_path.write_text("{}\n", encoding="utf-8")
        return {}


_MODEL_CAPS: dict[str, dict[str, Any]] = _load_model_extern_config()
_MODEL_CAPS_PREFIXES = sorted(_MODEL_CAPS, key=len, reverse=True)


def model_caps_for(model_id: str) -> dict[str, Any] | None:
    if model_id in _MODEL_CAPS:
        return _MODEL_CAPS[model_id]
    for prefix in _MODEL_CAPS_PREFIXES:
        if model_id.startswith(prefix) and model_id[len(prefix):len(prefix) + 1] == "-":
            return _MODEL_CAPS[prefix]
    return None


def _attach_model_caps(models: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for model in models:
        caps = model_caps_for(str(model.get("id", ""))) or {}
        model["context_window"] = caps.get("context_window")
        model["max_output_tokens"] = caps.get("max_output_tokens")
        model["supports_vision"] = caps.get("supports_vision")
    return models


def get_all_models(config: dict[str, Any]) -> list[dict[str, Any]]:
    all_models: list[dict[str, Any]] = []
    unique_models: set[str] = set()

    for provider in config.get("providers", []) or []:
        model_dict = provider.get("_model_dict_cache") or get_model_dict(provider)
        for model in model_dict.keys():
            if model not in unique_models:
                unique_models.add(model)
                all_models.append(
                    {
                        "id": model,
                        "object": "model",
                        "created": MODEL_INFO_CREATED,
                        "owned_by": "uni-api",
                    }
                )

    return _attach_model_caps(all_models)


def post_all_models(api_index: int, config: dict[str, Any], api_list: list[str], models_list: dict[str, list[str]]) -> list[dict[str, Any]]:
    all_models: list[dict[str, Any]] = []
    unique_models: set[str] = set()

    if config["api_keys"][api_index]["model"]:
        for model in config["api_keys"][api_index]["model"]:
            if model == "all":
                return get_all_models(config)
            if "/" in model:
                provider = model.split("/")[0]
                model = model.split("/")[1]
                if model == "*":
                    if provider.startswith("sk-") and provider in api_list:
                        for model_item in models_list[provider]:
                            if model_item not in unique_models:
                                unique_models.add(model_item)
                                all_models.append(
                                    {
                                        "id": model_item,
                                        "object": "model",
                                        "created": MODEL_INFO_CREATED,
                                        "owned_by": "uni-api",
                                    }
                                )
                    else:
                        for provider_item in config["providers"]:
                            if provider_item["provider"] != provider:
                                continue
                            model_dict = provider_item.get("_model_dict_cache") or get_model_dict(provider_item)
                            for model_item in model_dict.keys():
                                if model_item not in unique_models:
                                    unique_models.add(model_item)
                                    all_models.append(
                                        {
                                            "id": model_item,
                                            "object": "model",
                                            "created": MODEL_INFO_CREATED,
                                            "owned_by": "uni-api",
                                        }
                                    )
                else:
                    if provider.startswith("sk-") and provider in api_list:
                        if model in models_list[provider] and model not in unique_models:
                            unique_models.add(model)
                            all_models.append(
                                {
                                    "id": model,
                                    "object": "model",
                                    "created": MODEL_INFO_CREATED,
                                    "owned_by": "uni-api",
                                }
                            )
                    else:
                        for provider_item in config["providers"]:
                            if provider_item["provider"] != provider:
                                continue
                            model_dict = provider_item.get("_model_dict_cache") or get_model_dict(provider_item)
                            for model_item in model_dict.keys():
                                if model_item not in unique_models and model_item == model:
                                    unique_models.add(model_item)
                                    all_models.append(
                                        {
                                            "id": model_item,
                                            "object": "model",
                                            "created": MODEL_INFO_CREATED,
                                            "owned_by": "uni-api",
                                        }
                                    )
                continue

            if model.startswith("sk-") and model in api_list:
                continue

            if model not in unique_models:
                unique_models.add(model)
                all_models.append(
                    {
                        "id": model,
                        "object": "model",
                        "created": MODEL_INFO_CREATED,
                        "owned_by": "uni-api",
                    }
                )

    return _attach_model_caps(all_models)


def list_models_payload(
    *,
    api_index: int,
    api_list: list[str],
    model_response_cache: dict[str, list[dict]],
    config: dict[str, Any],
    models_list: dict[str, list[str]],
    build_models: Callable[[int, dict, list[str], dict[str, list[str]]], list[dict]],
) -> dict[str, Any]:
    api_key = api_list[api_index] if 0 <= api_index < len(api_list) else None
    models = model_response_cache.get(api_key)
    if models is None:
        models = build_models(api_index, config, api_list, models_list)
    # Keep the regular OpenAI-compatible response useful for Codex callers too.
    # Codex normally requests the richer snapshot with client_version, but the
    # model metadata must remain consistent when that query parameter is absent.
    models = copy.deepcopy(models)
    for model in models:
        if model.get("id") == "gpt-6-astra":
            model["context_window"] = GPT6_ASTRA_CONTEXT_WINDOW
            model["max_context_window"] = GPT6_ASTRA_MAX_CONTEXT_WINDOW
    return {"object": "list", "data": models}


def codex_models_payload(
    *,
    api_index: int,
    api_list: list[str],
    model_response_cache: dict[str, list[dict]],
    config: dict[str, Any],
    models_list: dict[str, list[str]],
    build_models: Callable[[int, dict, list[str], dict[str, list[str]]], list[dict]],
) -> dict[str, Any]:
    return copy.deepcopy(_CODEX_PRO_MODELS_SNAPSHOT)


def _is_codex_catalog_model_id(model_id: str) -> bool:
    lower = model_id.lower()
    return bool(lower) and not any(token in lower for token in _CODEX_BLOCKED_MODEL_TOKENS)


def _codex_compatible_model(model_id: str, priority: int) -> dict[str, Any]:
    lower = model_id.lower()
    for family in _CODEX_PRO_MODEL_FAMILIES:
        if lower != family.lower() and not lower.startswith(f"{family.lower()}-"):
            continue
        model = copy.deepcopy(_CODEX_PRO_MODELS_BY_SLUG[family])
        model["slug"] = model_id
        model["display_name"] = model_id
        model["description"] = "Available through uni-api."
        model["priority"] = priority
        return model
    return _codex_fallback_model(model_id, priority)


def _codex_fallback_model(model_id: str, priority: int) -> dict[str, Any]:
    lower = model_id.lower()
    supports_reasoning = (
        "codex" in lower
        or lower.startswith("gpt-5")
        or lower.startswith("gpt-6")
        or lower.startswith("o1")
        or lower.startswith("o3")
        or lower.startswith("o4")
    )
    supports_images = "deepseek" not in lower
    model: dict[str, Any] = {
        "slug": model_id,
        "display_name": model_id,
        "description": "Available through uni-api.",
        "supported_reasoning_levels": (
            _CODEX_FALLBACK_REASONING_LEVELS if supports_reasoning else []
        ),
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": True,
        "priority": priority,
        "additional_speed_tiers": ["fast"],
        "service_tiers": [
            {
                "id": "priority",
                "name": "Fast",
                "description": "1.5x speed, increased usage",
            }
        ],
        "availability_nux": None,
        "upgrade": None,
        "base_instructions": _CODEX_FALLBACK_BASE_INSTRUCTIONS,
        "supports_reasoning_summaries": supports_reasoning,
        "default_reasoning_summary": "auto",
        "support_verbosity": False,
        "default_verbosity": None,
        "apply_patch_tool_type": "freeform",
        "web_search_tool_type": "text",
        "truncation_policy": {"mode": "tokens", "limit": 10000},
        "supports_parallel_tool_calls": True,
        "supports_image_detail_original": supports_images,
        "context_window": 272000,
        "max_context_window": 272000,
        "auto_compact_token_limit": None,
        "effective_context_window_percent": 95,
        "experimental_supported_tools": [],
        "input_modalities": ["text", "image"] if supports_images else ["text"],
        "supports_search_tool": False,
        "use_responses_lite": False,
    }
    if supports_reasoning:
        model["default_reasoning_level"] = "medium"
    return model
