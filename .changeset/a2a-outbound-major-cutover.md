---
'@aramisfa/openclaw-a2a-outbound': major
---

Migrate `@aramisfa/openclaw-a2a-outbound` to the official OpenClaw Plugin SDK with a latest-SDK-only breaking contract:

- Rename tools to `a2a_delegate`, `a2a_task_status`, and `a2a_task_cancel`.
- Replace legacy tool input aliases with strict SDK-native `{ target, request }` contracts.
- Normalize tool outputs to `{ ok, operation, target, summary, raw }` on success and `{ ok, operation, target?, error }` on failure.
- Redesign plugin config to nested `defaults` + `policy` keys.
- Remove runtime compatibility shims and require official `OpenClawPluginApi` shape.
- Raise Node engine baseline to `>=22.12.0`.
- Pin `openclaw` runtime dependency to `2026.3.2` and add matching peer dependency.
