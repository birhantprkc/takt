#!/usr/bin/env python3
"""Private stdio bridge for the official DeepSeek Harness Python SDK."""

from __future__ import annotations

import json
import os
import re
import sys
import threading
from typing import Any


_SECRET_ENV_NAMES = ("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL")
_PROTOCOL_STRING_FIELDS = frozenset({
    "id",
    "requestId",
    "sessionId",
    "callId",
    "toolCallId",
    "kind",
    "method",
    "type",
    "code",
    "finishReason",
})
_BRIDGE_PROTOCOL_VERSION = 1

_MAIN_THREAD = threading.current_thread()
_current_stderr_request_id: str | None = None
_current_request_tracks_delayed_threads = False
_request_start_threads: set[threading.Thread] = set()
_current_stderr_threads: set[threading.Thread] = set()
_thread_stderr_request_ids: dict[threading.Thread, str] = {}
_previous_thread_stderr_request_ids: dict[threading.Thread, str] = {}


def _create_protocol_stdout() -> Any:
    stdout_fd = sys.stdout.fileno()
    protocol_fd = os.dup(stdout_fd)
    sys.stdout.flush()
    os.dup2(sys.stderr.fileno(), stdout_fd)
    return os.fdopen(protocol_fd, "w", encoding="utf-8", buffering=1)


_PROTOCOL_STDOUT = _create_protocol_stdout()
_PROTOCOL_WRITE_LOCK = threading.Lock()


def _redact_text(text: str) -> str:
    for name in _SECRET_ENV_NAMES:
        secret = os.environ.get(name)
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return re.sub(
        r"(?i)(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL)\s*[:=]\s*[^\s,;]+",
        lambda match: f"{match.group(1)}=[REDACTED]",
        text,
    )


def _redact_json(value: Any, field_name: str | None = None) -> Any:
    if isinstance(value, str):
        if field_name in _PROTOCOL_STRING_FIELDS:
            return value
        return _redact_text(value)
    if isinstance(value, list):
        return [_redact_json(item) for item in value]
    if isinstance(value, dict):
        return {
            _redact_text(key) if isinstance(key, str) else key: _redact_json(
                item,
                key if isinstance(key, str) else None,
            )
            for key, item in value.items()
        }
    return value


def _safe_text(value: object) -> str:
    return _redact_text(str(value))[:8192]


def _write(message: dict[str, Any]) -> None:
    safe_message = _redact_json(message)
    serialized = json.dumps(safe_message, ensure_ascii=False, separators=(",", ":"))
    with _PROTOCOL_WRITE_LOCK:
        _PROTOCOL_STDOUT.write(serialized + "\n")
        _PROTOCOL_STDOUT.flush()


def _live_non_main_threads() -> set[threading.Thread]:
    return {
        thread
        for thread in threading.enumerate()
        if thread is not _MAIN_THREAD
    }


def _begin_stderr_request(request_id: str, track_delayed_threads: bool) -> None:
    global _current_stderr_request_id, _current_request_tracks_delayed_threads
    global _request_start_threads, _current_stderr_threads, _previous_thread_stderr_request_ids
    live_threads = _live_non_main_threads()
    _previous_thread_stderr_request_ids = {
        thread: owner_request_id
        for thread, owner_request_id in _thread_stderr_request_ids.items()
        if thread in live_threads
    }
    _current_stderr_request_id = request_id
    _current_request_tracks_delayed_threads = track_delayed_threads
    _request_start_threads = live_threads
    _current_stderr_threads = set()


def _end_stderr_request(request_id: str) -> bool:
    global _current_stderr_request_id, _current_request_tracks_delayed_threads
    global _request_start_threads, _current_stderr_threads, _previous_thread_stderr_request_ids
    live_threads = _live_non_main_threads()
    has_live_request_threads = bool(live_threads - _request_start_threads)
    if _current_request_tracks_delayed_threads:
        owned_threads = (live_threads - _request_start_threads) | _current_stderr_threads
        for thread in owned_threads:
            _thread_stderr_request_ids.setdefault(thread, request_id)
    for thread in tuple(_thread_stderr_request_ids):
        if not thread.is_alive():
            del _thread_stderr_request_ids[thread]
    _current_stderr_request_id = None
    _current_request_tracks_delayed_threads = False
    _request_start_threads = set()
    _current_stderr_threads = set()
    _previous_thread_stderr_request_ids = {}
    return not has_live_request_threads


def _stderr_request_id() -> str | None:
    thread = threading.current_thread()
    if thread is _MAIN_THREAD:
        return _current_stderr_request_id
    if _current_stderr_request_id is not None:
        _current_stderr_threads.add(thread)
        return _current_stderr_request_id
    previous_request_id = _previous_thread_stderr_request_ids.get(thread)
    if previous_request_id is not None:
        return previous_request_id
    existing_request_id = _thread_stderr_request_ids.get(thread)
    if existing_request_id is not None:
        return existing_request_id
    return None


def _write_stderr(text: str) -> int:
    if text:
        _write({
            "kind": "stderr",
            "requestId": _stderr_request_id(),
            "stderr": text,
        })
    return len(text)


class _TurnAwareBinaryOutputStream:
    def __init__(self, underlying: Any) -> None:
        self._underlying = underlying

    def write(self, value: Any) -> int:
        data = bytes(value)
        if data:
            _write_stderr(data.decode("utf-8", errors="replace"))
        return len(data)

    def flush(self) -> None:
        return None

    def writelines(self, lines: Any) -> None:
        for line in lines:
            self.write(line)

    def fileno(self) -> int:
        return self._underlying.fileno()

    def isatty(self) -> bool:
        return self._underlying.isatty()

    @property
    def raw(self) -> Any:
        return self

    def __getattr__(self, name: str) -> Any:
        return getattr(self._underlying, name)


class _TurnAwareOutputStream:
    def __init__(self, underlying: Any) -> None:
        self._underlying = underlying
        self._buffer = _TurnAwareBinaryOutputStream(underlying.buffer)

    def write(self, text: str) -> int:
        return _write_stderr(text)

    def flush(self) -> None:
        return None

    def writelines(self, lines: Any) -> None:
        for line in lines:
            self.write(line)

    def fileno(self) -> int:
        return self._underlying.fileno()

    def isatty(self) -> bool:
        return self._underlying.isatty()

    @property
    def encoding(self) -> str | None:
        return self._underlying.encoding

    @property
    def errors(self) -> str | None:
        return self._underlying.errors

    @property
    def buffer(self) -> Any:
        return self._buffer

    def __getattr__(self, name: str) -> Any:
        return getattr(self._underlying, name)


def _install_turn_aware_streams() -> None:
    if not isinstance(sys.stdout, _TurnAwareOutputStream):
        sys.stdout = _TurnAwareOutputStream(sys.stdout)
    if not isinstance(sys.stderr, _TurnAwareOutputStream):
        sys.stderr = _TurnAwareOutputStream(sys.stderr)


def _error_code(error: BaseException) -> str:
    name = type(error).__name__
    if name == "SdkProtocolError":
        return "malformed-response"
    if name == "JsonRpcError":
        return "jsonrpc-error"
    if name == "TransportClosedError":
        return "transport-closed"
    if isinstance(error, FileNotFoundError):
        return "runtime-unavailable"
    if isinstance(error, TimeoutError):
        return "timeout"
    return "runtime-error"


def _error_message(error: BaseException) -> str:
    text = _safe_text(error)
    if text:
        return text
    return "DeepSeek Harness SDK operation failed"


def _start_harness(config: dict[str, Any]) -> Any:
    """Translate supported wire fields and start the managed SDK."""
    python_version = (sys.version_info.major, sys.version_info.minor)
    if sys.implementation.name != "cpython" or python_version != (3, 12):
        raise RuntimeError("DeepSeek Harness requires managed CPython 3.12")

    try:
        from deepseek_harness import DeepSeekHarness
    except Exception as error:
        raise RuntimeError(
            "DeepSeek Harness Python SDK is unavailable. Install deepseek-harness-sdk "
            "with its matching deepseek-harness-runtime-bin wheel."
        ) from error

    kwargs: dict[str, Any] = {
        "provider": config["provider"],
        "model": config["model"],
        "cwd": config["cwd"],
        "runtime_cwd": config["cwd"],
    }
    optional_fields = {
        "maxTokens": "max_tokens",
    }
    for wire_name, sdk_name in optional_fields.items():
        value = config.get(wire_name)
        if value is not None:
            kwargs[sdk_name] = value
    timeout_ms = config.get("requestTimeoutMs")
    if timeout_ms is not None:
        kwargs["request_timeout_seconds"] = timeout_ms / 1000
    shutdown_timeout_ms = config.get("shutdownTimeoutMs")
    if shutdown_timeout_ms is not None:
        kwargs["shutdown_timeout_seconds"] = shutdown_timeout_ms / 1000
    reasoning_effort = config.get("reasoningEffort")
    if reasoning_effort is not None:
        kwargs["reasoning_effort"] = reasoning_effort
    patches = config.get("patches")
    if patches is not None:
        kwargs["patches"] = tuple(str(patch) for patch in patches)

    harness = DeepSeekHarness(**kwargs)
    harness.start()
    return harness


def _run_request(harness: Any, request: dict[str, Any], request_id: str) -> dict[str, Any]:
    def on_notification(notification: Any) -> None:
        _write(
            {
                "kind": "notification",
                "requestId": request_id,
                "notification": {
                    "method": notification.method,
                    "payload": notification.payload,
                },
            }
        )

    session = harness.start_session(request.get("sessionId"))
    _write(
        {
            "kind": "notification",
            "requestId": request_id,
            "notification": {
                "method": "session.started",
                "payload": {"sessionId": session.id},
            },
        }
    )
    result = session.run(request["prompt"], on_notification=on_notification)
    return {
        "sessionId": result.session_id,
        "finalResponse": result.final_response,
        "finishReason": result.finish_reason,
    }


def _handle_request(harness: Any, request: dict[str, Any]) -> Any:
    request_id = request.get("id")
    if not isinstance(request_id, str) or not request_id:
        _write(
            {
                "kind": "error",
                "requestId": request_id,
                "error": {"code": "malformed-request", "message": "bridge request id is required"},
            }
        )
        return harness

    request_type = request.get("type")
    if request_type == "run":
        prompt = request.get("prompt")
        if not isinstance(prompt, str):
            _write(
                {
                    "kind": "error",
                    "requestId": request_id,
                    "error": {"code": "malformed-request", "message": "bridge run prompt is required"},
                }
            )
            return harness
        try:
            _begin_stderr_request(request_id, track_delayed_threads=True)
            result = _run_request(harness, request, request_id)
            session_reusable = _end_stderr_request(request_id)
            _write(
                {
                    "kind": "result",
                    "requestId": request_id,
                    "result": {**result, "sessionReusable": session_reusable},
                }
            )
            return harness
        except BaseException as error:
            code = _error_code(error)
            _write(
                {
                    "kind": "error",
                    "requestId": request_id,
                    "error": {"code": code, "message": _error_message(error)},
                }
            )
            if code in {"transport-closed", "malformed-response"}:
                _close_harness(harness)
                return None
        finally:
            if _current_stderr_request_id == request_id:
                _end_stderr_request(request_id)
        return harness

    if request_type == "close":
        try:
            harness.close()
            _write({"kind": "closed", "requestId": request_id})
        except BaseException as error:
            _write(
                {
                    "kind": "error",
                    "requestId": request_id,
                    "error": {"code": "close-error", "message": _error_message(error)},
                }
            )
        return None

    _write(
        {
            "kind": "error",
            "requestId": request_id,
            "error": {"code": "malformed-request", "message": "unknown bridge request type"},
        }
    )
    return harness


def _close_harness(harness: Any) -> None:
    if harness is None:
        return
    try:
        harness.close()
    except BaseException:
        # Cleanup must not mask the original protocol or broken-pipe failure.
        pass


def main() -> int:
    harness: Any = None
    _install_turn_aware_streams()
    try:
        for raw_line in sys.stdin:
            if not raw_line.strip():
                continue
            try:
                request = json.loads(raw_line)
            except json.JSONDecodeError:
                _write(
                    {
                        "kind": "fatal",
                        "error": {"code": "malformed-request", "message": "bridge received malformed JSON"},
                    }
                )
                return 2
            if not isinstance(request, dict):
                _write(
                    {
                        "kind": "fatal",
                        "error": {"code": "malformed-request", "message": "bridge request must be an object"},
                    }
                )
                return 2

            if request.get("protocolVersion") != _BRIDGE_PROTOCOL_VERSION:
                _write(
                    {
                        "kind": "fatal",
                        "error": {
                            "code": "protocol-error",
                            "message": "unsupported DeepSeek Harness bridge protocol version",
                        },
                    }
                )
                return 2

            request_type = request.get("type")
            if request_type == "start":
                request_id = request.get("id")
                config = request.get("config")
                if not isinstance(request_id, str) or not isinstance(config, dict):
                    _write(
                        {
                            "kind": "fatal",
                            "error": {"code": "malformed-request", "message": "bridge start request is invalid"},
                        }
                    )
                    return 2
                _begin_stderr_request(request_id, track_delayed_threads=False)
                try:
                    if harness is not None:
                        _close_harness(harness)
                        harness = None
                    harness = _start_harness(config)
                    _write({"kind": "ready", "requestId": request_id})
                except BaseException as error:
                    _write(
                        {
                            "kind": "fatal",
                            "requestId": request_id,
                            "error": {"code": _error_code(error), "message": _error_message(error)},
                        }
                    )
                    return 2
                finally:
                    _end_stderr_request(request_id)
                continue

            if harness is None:
                _write(
                    {
                        "kind": "fatal",
                        "error": {"code": "not-started", "message": "bridge must be started before use"},
                    }
                )
                return 2

            harness = _handle_request(harness, request)
            if harness is None:
                return 0
        return 0
    finally:
        _close_harness(harness)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        raise SystemExit(0)
