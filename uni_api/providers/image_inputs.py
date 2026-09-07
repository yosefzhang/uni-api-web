from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException

from uni_api.admission import get_request_admission_lease
from uni_api.providers.base64_chunks import (
    ChunkedBase64Error,
    encode_bytes_base64_chunks,
    inspect_base64_chunks,
)
from uni_api.providers.normalization import (
    cache_get_gemini_image_thought_signature_by_key,
)
from uni_api.upstream.response_limits import read_limited_response_body


IMAGE_FETCH_TIMEOUT_SECONDS = 30.0
_MAX_DATA_URL_HEADER_BYTES = 128
_FETCH_MEMORY_MULTIPLIER = 8
_SUPPORTED_IMAGE_MEDIA_TYPES = {
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
}


class _InvalidGifError(ValueError):
    pass


class _AnimatedGifError(ValueError):
    pass


class _GifFrameInspector:
    """Incrementally validate a GIF container and count rendered frames."""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._offset = 0
        self._state = "header"
        self._skip_bytes = 0
        self._frames = 0
        self._finished = False

    def feed(self, chunk: bytes) -> None:
        if self._finished or self._frames > 1:
            return
        self._buffer.extend(chunk)
        self._parse_available()
        if self._offset:
            del self._buffer[: self._offset]
            self._offset = 0

    def finish(self) -> None:
        self._parse_available()
        if self._frames > 1:
            raise _AnimatedGifError("animated GIF image input is not supported")
        if not self._finished or self._frames != 1:
            raise _InvalidGifError("invalid GIF image input")

    def _parse_available(self) -> None:
        while not self._finished and self._frames <= 1:
            available = len(self._buffer) - self._offset
            if self._state == "header":
                if available < 13:
                    return
                header = bytes(self._buffer[self._offset : self._offset + 6])
                if header not in {b"GIF87a", b"GIF89a"}:
                    raise _InvalidGifError("invalid GIF image input")
                packed = self._buffer[self._offset + 10]
                self._offset += 13
                if packed & 0x80:
                    self._skip_bytes = 3 * (1 << ((packed & 0x07) + 1))
                    self._state = "fixed"
                else:
                    self._state = "block"
                continue

            if self._state == "fixed":
                if available < self._skip_bytes:
                    return
                self._offset += self._skip_bytes
                self._skip_bytes = 0
                self._state = "block"
                continue

            if self._state == "block":
                if available < 1:
                    return
                introducer = self._buffer[self._offset]
                if introducer == 0x3B:
                    self._offset += 1
                    self._finished = True
                    continue
                if introducer == 0x21:
                    if available < 2:
                        return
                    self._offset += 2
                    self._state = "extension_subblocks"
                    continue
                if introducer != 0x2C:
                    raise _InvalidGifError("invalid GIF image input")
                if available < 10:
                    return
                packed = self._buffer[self._offset + 9]
                self._offset += 10
                if packed & 0x80:
                    self._skip_bytes = 3 * (1 << ((packed & 0x07) + 1))
                    self._state = "image_color_table"
                else:
                    self._state = "image_lzw_code_size"
                continue

            if self._state == "image_color_table":
                if available < self._skip_bytes:
                    return
                self._offset += self._skip_bytes
                self._skip_bytes = 0
                self._state = "image_lzw_code_size"
                continue

            if self._state == "image_lzw_code_size":
                if available < 1:
                    return
                code_size = self._buffer[self._offset]
                if code_size < 2 or code_size > 12:
                    raise _InvalidGifError("invalid GIF image input")
                self._offset += 1
                self._state = "image_subblocks"
                continue

            if self._state in {"extension_subblocks", "image_subblocks"}:
                if available < 1:
                    return
                block_size = self._buffer[self._offset]
                if block_size == 0:
                    self._offset += 1
                    if self._state == "image_subblocks":
                        self._frames += 1
                    self._state = "block"
                    continue
                if available < block_size + 1:
                    return
                self._offset += block_size + 1
                continue

            raise _InvalidGifError("invalid GIF image input")


def _detect_image_media_type(prefix: bytes) -> str | None:
    if prefix.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if prefix.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if (
        len(prefix) >= 12
        and prefix.startswith(b"RIFF")
        and prefix[8:12] == b"WEBP"
    ):
        return "image/webp"
    if prefix.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    return None


def _validate_single_frame_gif(content: bytes) -> None:
    inspector = _GifFrameInspector()
    inspector.feed(content)
    inspector.finish()


def _raise_gif_http_error(exc: ValueError) -> None:
    if isinstance(exc, _AnimatedGifError):
        raise HTTPException(
            status_code=415,
            detail="Animated GIF image input is not supported",
        ) from exc
    raise HTTPException(status_code=400, detail="Invalid GIF image input") from exc


def _data_url_metadata(value: str) -> tuple[str, int, int]:
    comma = value.find(",", 0, _MAX_DATA_URL_HEADER_BYTES + 1)
    if comma < 0:
        raise HTTPException(status_code=400, detail="Invalid image data URL")
    header = value[:comma].lower()
    if not header.startswith("data:") or not header.endswith(";base64"):
        raise HTTPException(
            status_code=400,
            detail="Image input must be a base64 data URL",
        )
    media_type = header[5:-7]
    if media_type == "image/jpg":
        media_type = "image/jpeg"
    if media_type not in _SUPPORTED_IMAGE_MEDIA_TYPES:
        raise HTTPException(
            status_code=415,
            detail="Unsupported image media type",
        )
    encoded_bytes = len(value) - comma - 1
    if encoded_bytes <= 0:
        raise HTTPException(status_code=400, detail="Invalid image base64")
    if encoded_bytes % 4 == 1:
        raise HTTPException(status_code=400, detail="Invalid image base64")
    return media_type, comma + 1, encoded_bytes


async def _extract_and_validate_image_base64_payload(
    data_url: str,
    *,
    encoded_start: int,
    media_type: str,
    collect_encoded_payload: bool,
) -> tuple[str, str]:
    """Incrementally validate/hash a data URL with bounded GIL hold times."""

    gif_inspector = _GifFrameInspector() if media_type == "image/gif" else None
    try:
        inspection = await inspect_base64_chunks(
            data_url,
            start_index=encoded_start,
            max_encoded_chars=None,
            max_decoded_bytes=None,
            prefix_bytes=16,
            collect_encoded_payload=collect_encoded_payload,
            decoded_chunk_observer=(
                gif_inspector.feed if gif_inspector is not None else None
            ),
        )
    except ChunkedBase64Error as exc:
        raise HTTPException(status_code=400, detail="Invalid image base64") from exc
    except (_InvalidGifError, _AnimatedGifError) as exc:
        _raise_gif_http_error(exc)
        raise AssertionError("unreachable")
    if gif_inspector is not None:
        try:
            gif_inspector.finish()
        except (_InvalidGifError, _AnimatedGifError) as exc:
            _raise_gif_http_error(exc)
            raise AssertionError("unreachable")
    detected = _detect_image_media_type(inspection.prefix)
    if detected is None or detected != media_type:
        raise HTTPException(
            status_code=400,
            detail="Image bytes do not match the declared media type",
        )
    return inspection.encoded_payload or "", inspection.digest_hex


async def _fetch_image_data_url(
    image_url: str,
    reservation: Any | None,
) -> str:
    parsed = urlparse(image_url)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Invalid image URL")

    limits = httpx.Limits(max_connections=1, max_keepalive_connections=0)
    try:
        async with asyncio.timeout(IMAGE_FETCH_TIMEOUT_SECONDS):
            async with httpx.AsyncClient(
                follow_redirects=True,
                limits=limits,
                headers={"Accept-Encoding": "identity"},
                timeout=httpx.Timeout(IMAGE_FETCH_TIMEOUT_SECONDS),
            ) as client:
                async with client.stream("GET", image_url) as response:
                    if response.status_code < 200 or response.status_code >= 300:
                        raise HTTPException(
                            status_code=400,
                            detail="Unable to fetch image URL",
                        )
                    limited = await read_limited_response_body(
                        response,
                        reserve_bytes=(
                            reservation.reserve
                            if reservation is not None
                            else None
                        ),
                        reservation_multiplier=_FETCH_MEMORY_MULTIPLIER,
                        resource_governed=True,
                    )
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=408, detail="Image fetch timed out") from exc
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=400,
            detail="Unable to fetch image URL",
        ) from exc

    if not limited.body:
        raise HTTPException(status_code=400, detail="Unable to fetch image URL")
    body = limited.body
    media_type = _detect_image_media_type(body[:16])
    if media_type is None:
        raise HTTPException(status_code=415, detail="Unsupported image media type")
    if media_type == "image/gif":
        try:
            _validate_single_frame_gif(body)
        except (_InvalidGifError, _AnimatedGifError) as exc:
            _raise_gif_http_error(exc)
            raise AssertionError("unreachable")
    data_url = await encode_bytes_base64_chunks(
        body,
        prefix=f"data:{media_type};base64,",
    )
    body = None
    limited = None
    return data_url


async def _build_engine_image_message(
    data_url: str,
    *,
    engine: str | None,
    media_type: str,
    encoded_payload: str,
    image_cache_key: str,
) -> dict[str, Any]:
    if engine in {"gpt", "openrouter", "azure", "azure-databricks"}:
        return {
            "type": "image_url",
            "image_url": {"url": data_url},
        }

    if engine in {"claude", "vertex-claude", "aws"}:
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": encoded_payload,
            },
        }
    if engine in {"gemini", "vertex-gemini"}:
        thought_signature = cache_get_gemini_image_thought_signature_by_key(
            image_cache_key
        )
        part: dict[str, Any] = {
            "inlineData": {
                "mimeType": media_type,
                "data": encoded_payload,
            }
        }
        if thought_signature:
            part["thoughtSignature"] = thought_signature
        return part
    raise HTTPException(status_code=400, detail="Unsupported image provider")


async def build_image_message(
    image_url: str,
    engine: str | None = None,
) -> dict[str, Any]:
    """Build a provider image part under request resource admission."""

    if not isinstance(image_url, str) or not image_url:
        raise HTTPException(status_code=400, detail="Image URL is required")

    request_lease = get_request_admission_lease()
    reservation = (
        await request_lease.reserve_temporary_response_bytes(0)
        if request_lease is not None
        else None
    )
    data_url = image_url
    encoded_payload = None
    image_cache_key = None
    try:
        if image_url.startswith(("http://", "https://")):
            data_url = await _fetch_image_data_url(image_url, reservation)

        media_type, encoded_start, encoded_bytes = _data_url_metadata(data_url)
        if reservation is not None and data_url is image_url:
            # Reserve before the full payload slice and strict decode.
            await reservation.reserve(encoded_bytes * 4 + 4096)
        encoded_payload, image_cache_key = (
            await _extract_and_validate_image_base64_payload(
            data_url,
            encoded_start=encoded_start,
            media_type=media_type,
            collect_encoded_payload=engine
            not in {"gpt", "openrouter", "azure", "azure-databricks"},
            )
        )
        message = await _build_engine_image_message(
            data_url,
            engine=engine,
            media_type=media_type,
            encoded_payload=encoded_payload,
            image_cache_key=image_cache_key,
        )
        encoded_payload = None
        image_cache_key = None
        if reservation is not None:
            await reservation.commit()
        return message
    except BaseException:
        encoded_payload = None
        image_cache_key = None
        if reservation is not None:
            await reservation.release()
        raise
