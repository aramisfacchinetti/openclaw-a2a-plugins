---
"@aramisfa/openclaw-a2a-outbound": patch
---

Fix `remote_agent` never being offered as a callable tool outside a narrow "full" runtime registration pass.

`registerTools` only registered the `remote_agent` tool when `api.registrationMode === "full"`, unconditionally deferring on every other mode — including `"tool-discovery"`, which hosts use specifically to enumerate available tools for an agent's tool list without doing a full runtime activation (channel registration, gateway handlers, etc). Other plugin entries in the host (`defineChannelPluginEntry`) already treat `"tool-discovery"` as a registration-worthy pass; this plugin didn't, so `remote_agent` was permanently unreachable for any agent turn served through that path, with no error — the tool simply never appeared in the agent's tool list. Now registers on both `"full"` and `"tool-discovery"`.
