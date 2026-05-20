# Quickstart

The first-success path is outbound-only. You do not need a public URL, inbound networking, a second OpenClaw instance, or secrets.

## Track 1: Self-Contained 5-Minute Demo

```bash
openclaw plugins install @aramisfa/openclaw-a2a-outbound
openclaw a2a demo run
```

Expected shape:

- starts a deterministic local demo peer
- uses the temporary alias `local-demo`
- runs `list_targets`
- sends a task-bearing request
- runs `watch` and `status`
- prints `summary.continuation`
- replays a follow-up with that exact continuation

Machine-readable output:

```bash
openclaw a2a demo run --json
```

Write the continuation for issue reports or local experimentation:

```bash
openclaw a2a demo run --write-continuation ./continuation.json
```

## Track 2: Raw `remote_agent` Flow

Start the packaged local peer and keep it running:

```bash
openclaw a2a demo serve --port 41234
```

Configure outbound against the demo peer:

```bash
openclaw plugins enable openclaw-a2a-outbound
openclaw config set plugins.entries.openclaw-a2a-outbound.config '{"enabled":true,"defaults":{"timeoutMs":30000,"cardPath":"/.well-known/agent-card.json","preferredTransports":["JSONRPC","HTTP+JSON"],"serviceParameters":{}},"targets":[{"alias":"local-demo","baseUrl":"http://127.0.0.1:41234","description":"Deterministic local A2A demo peer.","tags":["demo","local"],"cardPath":"/.well-known/agent-card.json","preferredTransports":["JSONRPC","HTTP+JSON"],"examples":["Create a durable demo task.","Continue from the persisted continuation."],"default":true}],"taskHandles":{"ttlMs":86400000,"maxEntries":100},"policy":{"acceptedOutputModes":["text/plain","application/json"],"normalizeBaseUrl":true,"enforceSupportedTransports":true,"allowTargetUrlOverride":false}}' --strict-json
```

Discover the target:

```json
{ "action": "list_targets" }
```

Send a task-bearing request:

```json
{
  "action": "send",
  "target_alias": "local-demo",
  "task_requirement": "required",
  "parts": [
    {
      "kind": "text",
      "text": "Create a durable demo task."
    }
  ]
}
```

Persist the returned `summary.continuation` exactly. Use that subtree for follow-ups.

Watch:

```json
{
  "action": "watch",
  "continuation": {
    "target": {
      "target_url": "http://127.0.0.1:41234/",
      "card_path": "/.well-known/agent-card.json",
      "preferred_transports": ["JSONRPC", "HTTP+JSON"],
      "target_alias": "local-demo"
    },
    "task": {
      "task_id": "<summary.continuation.task.task_id>",
      "task_handle": "<summary.continuation.task.task_handle>"
    },
    "conversation": {
      "context_id": "<summary.continuation.conversation.context_id>",
      "can_send": true
    }
  }
}
```

Status:

```json
{
  "action": "status",
  "continuation": {
    "target": {
      "target_url": "http://127.0.0.1:41234/",
      "card_path": "/.well-known/agent-card.json",
      "preferred_transports": ["JSONRPC", "HTTP+JSON"],
      "target_alias": "local-demo"
    },
    "task": {
      "task_id": "<summary.continuation.task.task_id>",
      "task_handle": "<summary.continuation.task.task_handle>"
    },
    "conversation": {
      "context_id": "<summary.continuation.conversation.context_id>",
      "can_send": true
    }
  }
}
```

Continuation replay:

```json
{
  "action": "send",
  "continuation": {
    "target": {
      "target_url": "http://127.0.0.1:41234/",
      "card_path": "/.well-known/agent-card.json",
      "preferred_transports": ["JSONRPC", "HTTP+JSON"],
      "target_alias": "local-demo"
    },
    "task": {
      "task_id": "<summary.continuation.task.task_id>",
      "task_handle": "<summary.continuation.task.task_handle>"
    },
    "conversation": {
      "context_id": "<summary.continuation.conversation.context_id>",
      "can_send": true
    }
  },
  "parts": [
    {
      "kind": "text",
      "text": "Continue from the persisted continuation."
    }
  ]
}
```

## Diagnostics

For real installs, run:

```bash
openclaw a2a doctor --alias local-demo
openclaw a2a doctor --alias local-demo --json
```

The doctor is read-only. It checks whether the plugin command is loaded, plugin loading is enabled, the plugin config has `enabled: true`, the requested target exists, and the target agent card is reachable.
