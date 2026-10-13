# Update Log

Notable changes to Paseo ACP are recorded here in reverse chronological order.

## Unreleased

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
