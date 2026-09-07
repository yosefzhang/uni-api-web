from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from core.utils import safe_get

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
try:
    with (_PROJECT_ROOT / "webui" / "package.json").open("r", encoding="utf-8") as _f:
        _UNI_API_WEB_VERSION = json.load(_f)["version"]
except Exception:
    _UNI_API_WEB_VERSION = "0.0.0"

_OPENCODE_GO_USER_AGENT = f"uni-api-web/{_UNI_API_WEB_VERSION}"


def apply_provider_preference_headers(
    headers: dict[str, Any],
    provider: dict[str, Any],
    *,
    http_request: Any | None = None,
) -> None:
    headers.update(safe_get(provider, "preferences", "headers", default={}) or {})
    apply_passthrough_request_headers(headers, provider, http_request=http_request)
    ensure_opencode_go_session_header(headers, provider)


def ensure_opencode_go_session_header(
    headers: dict[str, Any],
    provider: dict[str, Any],
) -> None:
    if not _is_opencode_go_provider(provider):
        return

    if _get_header_case_insensitive(headers, "x-opencode-session") is None:
        headers["x-opencode-session"] = str(uuid.uuid4())

    if _get_header_case_insensitive(headers, "User-Agent") is None:
        headers["User-Agent"] = _OPENCODE_GO_USER_AGENT


def _is_opencode_go_provider(provider: dict[str, Any]) -> bool:
    base_url = str(provider.get("base_url") or "").strip()
    return "opencode.ai" in base_url and "/zen/go" in base_url


def apply_passthrough_request_headers(
    headers: dict[str, Any],
    provider: dict[str, Any],
    *,
    http_request: Any | None = None,
) -> None:
    passthrough_names = _passthrough_header_names(provider)
    if not passthrough_names:
        return

    request_headers = getattr(http_request, "headers", None) if http_request is not None else None
    for header_name in passthrough_names:
        _remove_header_case_insensitive(headers, header_name)
        value = _get_header_case_insensitive(request_headers, header_name)
        if value is not None and str(value) != "":
            headers[header_name] = str(value)


def _passthrough_header_names(provider: dict[str, Any]) -> list[str]:
    configured = safe_get(provider, "preferences", "passthrough_request_headers", default=[]) or []
    if isinstance(configured, str):
        configured = [configured]
    if not isinstance(configured, list):
        return []

    names: list[str] = []
    seen: set[str] = set()
    for raw_name in configured:
        name = str(raw_name or "").strip()
        if not name:
            continue
        normalized = name.lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        names.append(name)
    return names


def _remove_header_case_insensitive(headers: dict[str, Any], header_name: str) -> None:
    normalized = header_name.lower()
    for existing_name in list(headers.keys()):
        if str(existing_name).lower() == normalized:
            headers.pop(existing_name, None)


def _get_header_case_insensitive(headers: Any, header_name: str) -> Any | None:
    if headers is None:
        return None

    getter = getattr(headers, "get", None)
    if callable(getter):
        value = getter(header_name)
        if value is not None:
            return value

    if isinstance(headers, dict):
        normalized = header_name.lower()
        for existing_name, value in headers.items():
            if str(existing_name).lower() == normalized:
                return value
    return None
