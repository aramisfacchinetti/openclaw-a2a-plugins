# @aramisfa/openclaw-a2a-outbound

Native OpenClaw outbound A2A delegation plugin.

This package registers exactly one optional OpenClaw tool, `remote_agent`. The tool exposes five actions: `list_targets`, `send`, `watch`, `status`, and `cancel`.

## Installation

```bash
openclaw plugins install @aramisfa/openclaw-a2a-outbound
```

Pin the exact published version if you want reproducible installs:

```bash
openclaw plugins install @aramisfa/openclaw-a2a-outbound --pin
```

Optional guided setup helper:

```bash
clawhub install a2a-delegation-setup
```

The ClawHub skill is an optional guided setup helper for installing, enabling, configuring, verifying, updating, and troubleshooting `@aramisfa/openclaw-a2a-outbound`. The plugin itself still installs through `openclaw plugins install @aramisfa/openclaw-a2a-outbound`.

## Requirements

- Node.js `>=22.12.0`
- OpenClaw `2026.3.2`

## OpenClaw Plugin Config

The plugin installs through the OpenClaw CLI, but the tool stays disabled until you set `"enabled": true` for plugin id `openclaw-a2a-outbound` in your OpenClaw plugin config:

```json
{
  "enabled": true,
  "defaults": {
    "timeoutMs": 120000,
    "cardPath": "/.well-known/agent-card.json",
    "preferredTransports": ["JSONRPC", "HTTP+JSON"],
    "serviceParameters": {}
  },
  "targets": [
    {
      "alias": "support",
      "baseUrl": "https://support.example",
      "description": "Primary support lane",
      "tags": ["support"],
      "examples": ["Summarize this incident and propose next steps."],
      "default": true
    }
  ],
  "taskHandles": {
    "ttlMs": 86400000,
    "maxEntries": 1000
  },
  "policy": {
    "acceptedOutputModes": [],
    "normalizeBaseUrl": true,
    "enforceSupportedTransports": true,
    "allowTargetUrlOverride": false
  }
}
```

Call `list_targets` first to discover configured aliases and refreshed target-card metadata. Prefer `target_alias` over `target_url`; use `target_url` only when policy allows direct URL routing.

## Unified Tool Contract

`remote_agent` accepts a flattened request object with top-level fields:

- `action`: required for every request.
- `target_alias`: preferred routing key for `send`, `watch`, `status`, and `cancel`.
- `target_url`: explicit remote base URL when policy allows it or when it matches a configured target.
- `parts`: required non-empty array for `send`; each part is `text`, `file`, or `data`.
- `message_id`: optional client-supplied message id for `send`.
- `task_handle`: opaque follow-up handle returned after delegated tasks are created.
- `task_id`: for `send`, continue an existing remote task; for `watch`/`status`/`cancel`, fallback follow-up key when no live `task_handle` is available.
- `context_id`: optional remote context id for `send`.
- `follow_updates`: stream live updates during `send`.
- `accepted_output_modes`: optional per-call output mode override for `send`.
- `blocking`: optional non-stream `send` knob. Rejected when `follow_updates=true`.
- `history_length`: optional history window for `send` and `status`.
- `push_notification_config`: optional push callback config for `send`.
- `timeout_ms`: per-request timeout override.
- `service_parameters`: optional outbound service parameters.
- `metadata`: optional metadata payload for `send`.

Snake_case tool fields are translated internally to the A2A SDK camelCase request payload. Action-specific validation rejects unsupported fields for each action, so keep requests flat and action-focused.

## Actions

- `list_targets`: discover configured targets, aliases, examples, and hydrated card metadata.
- `send`: send one or more message parts to a remote agent selected by `target_alias`, `target_url`, or a configured default target.
- `watch`: resubscribe to a running delegated task and stream updates.
- `status`: fetch the latest task snapshot.
- `cancel`: request cancellation for a delegated task.

For follow-up actions, prefer `task_handle` first. If the handle is expired or unavailable, fall back to `target_alias` + `task_id`. `send.task_id` is a continuation id for the remote peer, not a replacement for `task_handle` in later tool calls.

## Examples

### Discover Available Targets

```json
{ "action": "list_targets" }
```

```json
{
  "ok": true,
  "operation": "remote_agent",
  "action": "list_targets",
  "summary": {
    "targets": [
      {
        "target_alias": "support",
        "target_url": "https://support.example/",
        "default": true,
        "tags": ["support"],
        "examples": ["Summarize this incident and propose next steps."],
        "target_name": "Support Agent",
        "description": "Primary support lane",
        "streaming_supported": true,
        "skills": [
          {
            "id": "triage",
            "name": "Incident Triage",
            "description": "Summarize incidents and propose next actions.",
            "tags": ["support"],
            "examples": ["Summarize this incident and propose next steps."]
          }
        ]
      }
    ]
  },
  "raw": [
    {
      "default": true,
      "tags": ["support"],
      "examples": ["Summarize this incident and propose next steps."]
    }
  ]
}
```

### Send To An Explicit `target_alias`

```json
{
  "action": "send",
  "target_alias": "support",
  "parts": [
    {
      "kind": "text",
      "text": "Summarize this bug report for triage."
    }
  ],
  "metadata": {
    "ticket_id": "INC-42"
  }
}
```

```json
{
  "ok": true,
  "operation": "remote_agent",
  "action": "send",
  "summary": {
    "target_alias": "support",
    "target_url": "https://support.example/",
    "message_text": "Triage summary: reproduce, collect logs, and notify the on-call engineer."
  },
  "raw": {
    "kind": "message"
  }
}
```

### Send Using The Configured Default Target

If one target is marked `"default": true`, `send` can omit `target_alias`:

```json
{
  "action": "send",
  "parts": [
    {
      "kind": "text",
      "text": "Draft a reply to the customer update."
    }
  ],
  "follow_updates": true
}
```

```json
{
  "ok": true,
  "operation": "remote_agent",
  "action": "send",
  "summary": {
    "target_alias": "support",
    "target_url": "https://support.example/",
    "task_handle": "rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0",
    "task_id": "task-456",
    "status": "completed",
    "can_watch": true
  },
  "raw": {
    "events": [
      {
        "kind": "task",
        "id": "task-456",
        "status": {
          "state": "submitted"
        }
      },
      {
        "kind": "status-update",
        "taskId": "task-456",
        "status": {
          "state": "completed"
        },
        "final": true
      }
    ],
    "finalEvent": {
      "kind": "status-update",
      "taskId": "task-456",
      "status": {
        "state": "completed"
      },
      "final": true
    }
  }
}
```

### Continue An Existing Remote Task

Use `send.task_id` and `send.context_id` when the peer expects a continuation instead of a brand-new task:

```json
{
  "action": "send",
  "target_alias": "support",
  "task_id": "task-456",
  "context_id": "ctx-456",
  "parts": [
    {
      "kind": "text",
      "text": "Continue the prior conversation and draft the final reply."
    }
  ]
}
```

### Check Task Status With `task_handle`

```json
{
  "action": "status",
  "task_handle": "rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0",
  "history_length": 2
}
```

```json
{
  "ok": true,
  "operation": "remote_agent",
  "action": "status",
  "summary": {
    "target_alias": "support",
    "target_url": "https://support.example/",
    "task_handle": "rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0",
    "task_id": "task-456",
    "status": "completed",
    "can_watch": true
  },
  "raw": {
    "kind": "task",
    "id": "task-456",
    "status": {
      "state": "completed"
    }
  }
}
```

When a handle is expired or unavailable, retry with `target_alias` + `task_id`:

```json
{
  "action": "status",
  "target_alias": "support",
  "task_id": "task-456"
}
```

`watch` and `cancel` use the same follow-up targeting rules:

```json
{ "action": "watch", "task_handle": "rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0" }
```

```json
{ "action": "cancel", "task_handle": "rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0" }
```

## Validation And Actionable Errors

Tool input validation uses Ajv in strict mode. Validation failures use `operation: "remote_agent"` and include native-style Ajv error objects:

```json
{
  "ok": false,
  "operation": "remote_agent",
  "action": "send",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "remote_agent input validation failed",
    "details": {
      "source": "ajv",
      "tool": "remote_agent",
      "errors": [
        {
          "keyword": "anyOf",
          "instancePath": "",
          "message": "send requires target_alias, target_url, or a configured default target"
        }
      ]
    }
  }
}
```

Expired handles return an actionable recovery envelope:

```json
{
  "ok": false,
  "operation": "remote_agent",
  "action": "status",
  "error": {
    "code": "EXPIRED_TASK_HANDLE",
    "message": "task handle \"rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0\" has expired",
    "details": {
      "taskHandle": "rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0",
      "retryHint": "Retry with explicit target plus taskId, or resend the original request after a restart to obtain a new handle.",
      "restartInvalidatesHandles": true,
      "suggested_actions": ["status", "send"],
      "hint": "Retry with target_alias + task_id, or send a new request."
    }
  }
}
```

## Development

```bash
pnpm build
pnpm test
```

## License

MIT
