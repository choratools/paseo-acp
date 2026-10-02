# Antigravity ACP adapter

Portable ACP bridge for running the local Google Antigravity CLI (`agy`) from Paseo.

## Requirements

- `agy` installed and authenticated outside Paseo.
- A workspace directory that Paseo can pass as `cwd`.

The bridge does not implement OAuth. It reports `authMethods: []`; use the normal Antigravity CLI login flow before starting Paseo.

## Usage

Register `bridge.mjs` as a stdio ACP adapter. By default it runs:

```bash
agy --print --input-format stream-json --output-format stream-json --disable-slash-commands --mode plan
```

The default ACP model is `inherit`, which lets Antigravity use its configured default model. On startup the bridge tries `agy models` and exposes that catalog when the command succeeds. If model discovery fails or emits more than 1 MiB, only `inherit` is advertised.

## Environment

| Variable | Purpose |
| --- | --- |
| `AGY_ACP_COMMAND` | Plain executable path used to launch Antigravity. Defaults to `agy`. Arguments are not parsed here; use a wrapper executable if needed. |
| `AGY_ACP_ALLOW_UNSAFE=1` | Adds `--dangerously-skip-permissions`. Off by default. |
| `AGY_ACP_DEBUG=1` | Writes bridge diagnostics to stderr. |
| `AGY_ACP_MODEL_PROBE_TIMEOUT_MS` | Timeout for `agy models`. Defaults to 5000 ms. |
| `AGY_ACP_RPC_TIMEOUT_MS` | Reserved prompt timeout budget. Defaults to 10 minutes. |
| `AGY_ACP_KILL_GRACE_MS` | Grace period before hard-killing a stopped CLI process. Defaults to 1500 ms. |

## Modes

- `plan` is the default and asks Antigravity to avoid direct changes.
- `standard` omits `--mode` and uses the CLI default.
- `accept-edits` passes `--mode accept-edits`.

Interactive terminal permission prompts are not representable through ACP. For fully unattended operation, explicitly opt in with `AGY_ACP_ALLOW_UNSAFE=1` after deciding that is acceptable for the workspace.

## Limits

- Sessions are in-memory only; `session/load`, `session/resume`, and `session/list` are not advertised.
- MCP injection is not translated into Antigravity CLI flags.
- The bridge streams assistant text and basic tool status from Antigravity stream-json events. Event shapes outside the observed CLI contract are ignored safely.
