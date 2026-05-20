# One-Shot Delegation

Use one-shot delegation when the peer can answer in a single turn and no durable task lifecycle is needed.

## Start With The Demo

```bash
openclaw a2a demo run
```

For raw payload testing, keep a local peer running:

```bash
openclaw a2a demo serve --port 41234
```

Then call `remote_agent`:

```json
{
  "action": "send",
  "target_alias": "local-demo",
  "parts": [
    {
      "kind": "text",
      "text": "direct hello"
    }
  ]
}
```

The local demo peer treats prompts containing `direct` as direct message replies. The result should have:

- `ok: true`
- `action: "send"`
- `summary.response_kind: "message"`
- `summary.continuation.conversation`

Conversation continuation authorizes only later `send` calls with `context_id`. It is not task continuity and must not be used for `watch`, `status`, or `cancel`.
