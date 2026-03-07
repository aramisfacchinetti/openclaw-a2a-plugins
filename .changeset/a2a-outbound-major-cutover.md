---
'@aramisfa/openclaw-a2a-outbound': major
---

Migrate `@aramisfa/openclaw-a2a-outbound` to the official OpenClaw Plugin SDK with a latest-SDK-only breaking contract:

- Collapse the outbound tool family into a single `remote_agent` tool with `list_targets`, `send`, `watch`, `status`, and `cancel` actions.
- Replace nested protocol-shaped requests with flat `remote_agent` inputs.
- Normalize tool outputs to `{ ok, operation, action, summary, raw }` on success and `{ ok, operation, action, error }` on failure.
- Redesign plugin config to nested `defaults` + `policy` keys.
- Remove runtime compatibility shims and require official `OpenClawPluginApi` shape.
- Raise Node engine baseline to `>=22.12.0`.
- Pin `openclaw` runtime dependency to `2026.3.2` and add matching peer dependency.
