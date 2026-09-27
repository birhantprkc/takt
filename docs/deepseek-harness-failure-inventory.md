# DeepSeek Harness failure inventory (pinned SDK 0.1.5rc1)

This inventory tracks the **SDK wheel pinned in `src/infra/deepseek-harness/uv.lock`**, not every error that the bundled native runtime or a remote provider can produce. The SDK source in the wheel (`deepseek_harness/client.py`, `api.py`, `errors.py`) and TAKT's `src/infra/deepseek-harness/bridge.py` are the evidence. Examples and regression tests use dummy values only. No real credential or user error log is needed.

| Source / failure shape | Bridge code and evidence | TAKT diagnostic | Boundary |
| --- | --- | --- | --- |
| JSON-RPC response error (`client.py` `_handle_message`, `JsonRpcError`) | `jsonrpc-error`; message and optional data come from the runtime. `initialize()` can append subprocess diagnostics to the message. | Fixed JSON-RPC cause. Existing classified credential errors remain classified. | Never display arbitrary message/data or embedded stderr. Numeric JSON-RPC codes are **not** yet a trusted cause taxonomy. |
| Runtime closes or cannot accept writes (`client.py` `_runtime_closed_error`, `_write_message`) | `transport-closed`; message can include exit code and multiline stderr tail. | Fixed runtime-connection-closed cause. | Do not copy exit status or stderr from the SDK exception body without a separately validated structured field. |
| SDK request/initialize timeout (`client.py` `_request_raw`, `initialize`) | `timeout`; text can include profile name and multiline subprocess diagnostics. | Fixed `part_timeout` cause. | Do not copy the exception text or nested stderr. TAKT's own request timer also uses a fixed timeout cause. |
| SDK protocol error (`api.py` `finish_reason`, `errors.py`) | `malformed-response` | Fixed `provider_stream_parse_error` cause. | No raw protocol body. |
| Missing bundled runtime (`client.py` `_default_launch_args`) | `runtime-unavailable` | Fixed managed-environment install/repair advice. | No raw exception text or path from SDK. |
| Managed SDK probe/validation (`runtime.ts`, Python constructor/close) | local startup failure, before bridge start | Fixed cause for locally checked version/Requires-Python mismatch or empty-stderr nonzero probe exit; generic install/repair advice for untrusted probe failure. | Probe traceback and stderr may be arbitrary; neither is copied to failure surfaces. The original error is retained only as an internal cause. |
| Other SDK/runtime exceptions, including arbitrary provider HTTP text | `runtime-error` or `turn/end` error fields | Project only complete, reviewed grammars; otherwise `Upstream error details are withheld.` | Store-only secrets may appear in otherwise ordinary free text. TAKT does not know those values. |
| stderr written by the bridge's SDK worker / runtime | request-attributed bridge stderr frames | Project only complete, reviewed single-line shapes when the request owner and drain are proven. | Unknown, stale, unowned, oversized or late stderr forces fail-closed. SDK-internal stderr inside an exception remains untrusted text. |

## Verified versus unverified

- The table covers the **Python SDK exception paths inspected in 0.1.5rc1** and TAKT's local bridge handling. The bundled native runtime is an executable, not a finite source-level error schema: provider HTTP bodies, notification payloads, binary/runtime-specific exit text and future versions are **not exhaustively verified**.
- Store-only dummy values in JSON-RPC text/data, exception/cause text, timeout profile, probe traceback and stderr are tested against response, onStream, provider event log and trace report. A test does **not** prove that all possible unknown secret encodings or free text are safe to print.
- Until the upstream contract below exists, the fixed diagnostic is the correct outcome for any unrecognized shape. Do not weaken non-exposure tests merely to increase display coverage.

## Contract needed from the upstream SDK/runtime

1. Emit a versioned, finite cause code, independent of an error message or exception name. Define safe enum variants (for example model reference, connectivity, provider rejection, internal error, timeout). Unknown codes must be rejected.
2. Build displayable fields **where the credential store is accessible**, omitting or replacing the complete secret and sensitive HTTP/header/body values before crossing the SDK boundary. Never mark arbitrary text `safe` without a verifiable field contract. No opaque model, hostname, path, profile, HTTP body, cause chain or stderr fragment is displayable by default.
3. Supply request ownership and bounded completion for stderr, or keep stderr out of the displayable contract. A process-wide stderr buffer is not proof of ownership.
4. Version-pin and validate the schema in TAKT. Tests must inject distinct dummy store-only values into JSON-RPC message/data, cause, headers, timeout profile, stderr and malformed payloads, then assert non-exposure across all four sinks. Unknown/new variants must remain fail-closed.

This contract requires upstream support; the official SDK/runtime is explicitly out of scope for #1605 and PR #1619. Track that dependency in [#1621](https://github.com/nrslib/takt/issues/1621). The upstream repository currently has GitHub Issues disabled; do not silently treat a TAKT-side regex as an upstream safety guarantee.
