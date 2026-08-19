---
"@aramisfa/openclaw-a2a-inbound": patch
---

Fix two inbound bugs found while integrating with a real A2A v1.0 client:

- Accept A2A v1.0 message parts that omit the `kind` field (member-presence discrimination: `{ text, mediaType }` / `{ data }`), instead of silently dropping every part and rejecting the request as having no usable content.
- Close a fail-open bug in session-key matching: an internal agent event arriving without a `sessionKey` was previously treated as a match for any expected session, letting a concurrently running unrelated session's tool calls and assistant output leak into this task's A2A response. Untagged events are now rejected whenever a session key is expected.
