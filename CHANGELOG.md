# Update Log

Notable changes to Paseo ACP are recorded here in reverse chronological order.

## Unreleased

- Forward ACP image, audio, and embedded blob content blocks to the ZCode
  runtime as native attachments, enabling multimodal prompts. Media-only
  prompts no longer fail with "Unsupported prompt content".
- Advertise `image` and `audio` prompt capabilities in the ACP `initialize`
  response so spec-compliant clients enable their media input UI.
- Cancel a ZCode prompt that is still waiting on the admission queue, so an
  immediate cancellation can no longer race the prompt and leave it running.
- Recognize desktop logins for Individual Coding Plan entitlement by falling
  back to the OAuth account's user id when the CLI identity record is absent.
- Queue a ZCode follow-up prompt while cancellation of the previous turn is
  completing, avoiding overlapping native prompts (`-32010`). Prompts sent
  without cancelling the active turn continue to return a busy error.

## 0.1.0 — 2026-10-03

- Initial source distribution of the Antigravity and ZCode ACP adapters.
- Add setup, login, doctor, and uninstall commands for Paseo configuration.
- Stream Antigravity CLI responses and ZCode native app-server responses over
  ACP stdio.
- Support ZCode persistent sessions, model and mode selection, permission
  forwarding, and stdio/HTTP/SSE MCP configuration forwarding.
