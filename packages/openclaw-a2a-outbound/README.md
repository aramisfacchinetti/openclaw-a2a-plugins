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

`openclaw plugins install` enables the plugin at the OpenClaw system level automatically — no separate `openclaw plugins enable` step is required. However, the `remote_agent` tool is gated by the plugin's own `"enabled"` flag inside its configuration object. Set `"enabled": true` under plugin id `openclaw-a2a-outbound` in your OpenClaw plugin config to activate the tool:

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
      "examples": ["Summarize this incident and propose immediate actions."],
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

Call `list_targets` first to discover configured aliases and refreshed peer-card metadata. Prefer `target_alias` over `target_url`; use `target_url` only when policy allows direct URL routing.

## Unified Tool Contract

`remote_agent` accepts a flattened request object with top-level fields:

- `action`: required for every request.
- `target_alias`: preferred routing key for `send`, `watch`, `status`, and `cancel`.
- `target_url`: explicit remote base URL when policy allows it or when it matches a configured target.
- `parts`: required non-empty array for `send`; each part is `text`, `file`, or `data`.
- `message_id`: optional client-supplied message id for `send`.
- `task_handle`: opaque delegated-task handle. `send`, `watch`, `status`, and `cancel` all accept it.
- `task_id`: for `send`, continue an existing remote task when no `task_handle` is available; for `watch`/`status`/`cancel`, fallback follow-up key when no live `task_handle` is available.
- `context_id`: optional remote conversation context id for `send` only. Use it either with `task_id` or by itself to start a new task inside an existing conversation. Flat `context_id` must not be used for `watch`, `status`, or `cancel`.
- `reference_task_ids`: optional related task ids for `send`. `task_id` continues an existing task; `reference_task_ids` references prior tasks without continuing them.
- `task_requirement`: optional `send` contract. Defaults to `"optional"`; set `task_requirement="required"` to require a real task.
- `follow_updates`: stream the initial `send`. `follow_updates=true` means “stream the initial send”; it does not guarantee task creation unless `task_requirement="required"`.
- `accepted_output_modes`: optional per-call output mode override for `send`.
- `blocking`: optional non-stream `send` knob. Rejected when `follow_updates=true`.
- `history_length`: optional history window for `send` and `status`.
- `push_notification_config`: optional push callback config for `send`.
- `timeout_ms`: per-request timeout override.
- `service_parameters`: optional outbound service parameters.
- `metadata`: optional metadata payload for `send`.

Snake_case tool fields are translated internally to the A2A SDK camelCase request payload. Action-specific validation rejects unsupported fields for each action, so keep requests flat and action-focused.

## Actions

- `list_targets`: discover configured targets, aliases, examples, and hydrated peer-card metadata.
- `send`: send one or more message parts to a remote agent, either as a new turn or as a follow-up turn on an existing task/conversation.
- `watch`: resubscribe to a running delegated task and stream updates.
- `status`: fetch the latest task snapshot.
- `cancel`: request cancellation for a delegated task.

Failed `send` and `sendStream` calls include `error.details.capability_diagnostics` so remote validation or content-type rejections can be compared against the stored peer card without blocking permissive runtime sends.

## Continuation Rules

This package returns continuation metadata under `summary.continuation`. Persist that subtree verbatim and use it to choose the next action.

- `summary.continuation.target`: the canonical persisted routing contract for machine follow-up. Persist `target_url`, `card_path`, and `preferred_transports` verbatim; `target_alias` is optional descriptive metadata.
- `summary.continuation.task`: the only machine-readable signal that a real remote task exists. Read `task_handle`, `task_id`, `status`, `can_resume_send`, `can_watch`, and the deprecated alias `can_send` from here, and use it for follow-up `send`, `watch`, `status`, and `cancel`.
- `summary.continuation.conversation`: send-only conversation continuity. Read `context_id` from here and use it only for follow-up `send`.
- `response_kind`: descriptive wire-shape classification only. `response_kind="message"` means the peer returned a `Message`; `response_kind="task"` means a task-bearing response or event appeared. `response_kind` does not replace `summary.continuation`.
- `summary.target_*` and other top-level compatibility aliases are descriptive only. Do not infer lifecycle continuity from flat `task_id`, flat `context_id`, or other top-level fields.
- `watch`, `status`, and `cancel` require `summary.continuation.task`.
- Conversation-only follow-up uses `context_id`, not task actions.

Supported `send` modes:

- new task: `send` with `target_alias`/`target_url` or a configured default target, and no continuation fields
- existing task continuation: `send` with a persisted `continuation`; flat `task_handle`, or `task_id` plus `target_alias`/`target_url`, remain manual compatibility inputs only
- related new task: `send` with `reference_task_ids`, optionally plus `context_id`, plus `target_alias`/`target_url` or a configured default target
- new task in an existing conversation: `send` with a persisted conversation-only `continuation`; flat `context_id` plus `target_alias`/`target_url` remains manual compatibility only

When a delegated task pauses in `input-required` or an approval workflow, resume it with `send` again. If the nested `task_handle` is expired or unavailable, the plugin automatically falls back within that nested contract to `continuation.target` + `continuation.task.task_id`; callers should not flatten persisted follow-up state back into `target_alias`/`task_id`.

Choose the next action based on the continuation shape:

```ts
const continuation = result.summary.continuation
const task = continuation?.task
const conversation = continuation?.conversation

if (task) {
  const followUp = { action: "status", continuation }
} else if (conversation) {
  const followUp = {
    action: "send",
    continuation,
    parts: [{ kind: "text", text: "Start a related task in the same conversation." }],
  }
}
```

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
        "examples": ["Summarize this incident and propose immediate actions."],
        "target_name": "Support Agent",
        "description": "Primary support lane",
        "streaming_supported": true,
        "peer_card": {
          "preferred_transport": "JSONRPC",
          "additional_interfaces": [
            {
              "transport": "JSONRPC",
              "url": "https://support.example/a2a/jsonrpc"
            },
            {
              "transport": "HTTP+JSON",
              "url": "https://support.example/a2a/rest"
            }
          ],
          "capabilities": {
            "streaming": true,
            "push_notifications": true,
            "state_transition_history": true
          },
          "default_input_modes": ["text/plain"],
          "default_output_modes": ["text/plain"],
          "skills": [
            {
              "id": "triage",
              "name": "Incident Triage",
              "description": "Summarize incidents and propose next actions.",
              "tags": ["support"],
              "examples": ["Summarize this incident and propose immediate actions."],
              "input_modes": ["application/json"],
              "output_modes": ["application/pdf"]
            }
          ]
        }
      }
    ]
  },
  "raw": [
    {
      "target": {
        "baseUrl": "https://support.example/",
        "cardPath": "/.well-known/agent-card.json",
        "preferredTransports": ["JSONRPC", "HTTP+JSON"],
        "alias": "support",
        "displayName": "Support Agent",
        "description": "Primary support lane",
        "streamingSupported": true
      },
      "configuredDescription": "Primary support lane",
      "default": true,
      "tags": ["support"],
      "examples": ["Summarize this incident and propose immediate actions."],
      "card": {
        "displayName": "Support Agent",
        "description": "Summarize incidents and propose next actions.",
        "preferredTransport": "JSONRPC",
        "additionalInterfaces": [
          {
            "transport": "JSONRPC",
            "url": "https://support.example/a2a/jsonrpc"
          },
          {
            "transport": "HTTP+JSON",
            "url": "https://support.example/a2a/rest"
          }
        ],
        "capabilities": {
          "streaming": true,
          "pushNotifications": true,
          "stateTransitionHistory": true
        },
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": [
          {
            "id": "triage",
            "name": "Incident Triage",
            "description": "Summarize incidents and propose next actions.",
            "tags": ["support"],
            "examples": ["Summarize this incident and propose immediate actions."],
            "inputModes": ["application/json"],
            "outputModes": ["application/pdf"]
          }
        ],
        "lastRefreshedAt": "2026-03-12T10:00:00.000Z"
      }
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
    "response_kind": "message",
    "message_text": "Triage summary: reproduce, collect logs, and notify the on-call engineer."
  },
  "raw": {
    "kind": "message"
  }
}
```

### Require A Durable Task

```json
{
  "action": "send",
  "target_alias": "support",
  "task_requirement": "required",
  "parts": [
    {
      "kind": "text",
      "text": "Start a trackable task and return immediately."
    }
  ]
}
```

### Start Related Work Without Continuing A Task

```json
{
  "action": "send",
  "target_alias": "support",
  "context_id": "ctx-123",
  "reference_task_ids": ["task-101", "task-102"],
  "parts": [
    {
      "kind": "text",
      "text": "Start a related task in the same conversation."
    }
  ]
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
    "response_kind": "task",
    "continuation": {
      "target": {
        "target_url": "https://support.example/",
        "card_path": "/.well-known/agent-card.json",
        "preferred_transports": ["JSONRPC", "HTTP+JSON"],
        "target_alias": "support"
      },
      "task": {
        "task_handle": "rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0",
        "task_id": "task-456",
        "status": "completed",
        "can_resume_send": false,
        "can_send": false,
        "can_status": true,
        "can_cancel": false,
        "can_watch": false
      },
      "conversation": {
        "context_id": "ctx-456",
        "can_send": true
      }
    }
  },
  "raw": {
    "events": [
      {
        "kind": "task",
        "id": "task-456",
        "contextId": "ctx-456",
        "status": {
          "state": "submitted"
        }
      },
      {
        "kind": "status-update",
        "taskId": "task-456",
        "contextId": "ctx-456",
        "status": {
          "state": "completed"
        },
        "final": true
      }
    ],
    "finalEvent": {
      "kind": "status-update",
      "taskId": "task-456",
      "contextId": "ctx-456",
      "status": {
        "state": "completed"
      },
      "final": true
    }
  }
}
```

```ts
const task = result.summary.continuation?.task
const conversation = result.summary.continuation?.conversation

if (!task) {
  throw new Error("expected a trackable delegated task")
}

if (task.can_watch) {
  // `watch` is valid here.
}

const followUpContext = conversation?.context_id
```

### Continue An Existing Remote Task With `task_handle`

Resend the persisted continuation subtree:

```json
{
  "action": "send",
  "continuation": {
    "target": {
      "target_url": "https://support.example/",
      "card_path": "/.well-known/agent-card.json",
      "preferred_transports": ["JSONRPC", "HTTP+JSON"],
      "target_alias": "support"
    },
    "task": {
      "task_handle": "rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0",
      "task_id": "task-456"
    },
    "conversation": {
      "context_id": "ctx-456",
      "can_send": true
    }
  },
  "parts": [
    {
      "kind": "text",
      "text": "Approved. Continue with the task and finish the reply."
    }
  ]
}
```

### Continue An Existing Remote Task With `task_id`

Use the persisted continuation without `task_handle`:

```json
{
  "action": "send",
  "continuation": {
    "target": {
      "target_url": "https://support.example/",
      "card_path": "/.well-known/agent-card.json",
      "preferred_transports": ["JSONRPC", "HTTP+JSON"],
      "target_alias": "support"
    },
    "task": {
      "task_id": "task-456"
    },
    "conversation": {
      "context_id": "ctx-456",
      "can_send": true
    }
  },
  "parts": [
    {
      "kind": "text",
      "text": "Continue the prior conversation and draft the final reply."
    }
  ]
}
```

### Start A New Task In An Existing Conversation

Use `summary.continuation.conversation.context_id` when only conversation continuity exists:

```json
{
  "action": "send",
  "continuation": {
    "target": {
      "target_url": "https://support.example/",
      "card_path": "/.well-known/agent-card.json",
      "preferred_transports": ["JSONRPC", "HTTP+JSON"],
      "target_alias": "support"
    },
    "conversation": {
      "context_id": "ctx-456",
      "can_send": true
    }
  },
  "parts": [
    {
      "kind": "text",
      "text": "Start a new side task, but keep it in the same conversation."
    }
  ]
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
    "response_kind": "message",
    "message_text": "Conversation continued. Start the next task when ready.",
    "continuation": {
      "target": {
        "target_url": "https://support.example/",
        "card_path": "/.well-known/agent-card.json",
        "preferred_transports": ["JSONRPC", "HTTP+JSON"],
        "target_alias": "support"
      },
      "conversation": {
        "context_id": "ctx-456",
        "can_send": true
      }
    }
  },
  "raw": {
    "kind": "message"
  }
}
```

```ts
const task = result.summary.continuation?.task
const conversation = result.summary.continuation?.conversation

if (task) {
  throw new Error("expected a context-only continuation")
}

if (conversation) {
  const followUp = {
    action: "send",
    continuation: result.summary.continuation,
    parts: [{ kind: "text", text: "Start the next task in this conversation." }],
  }
}
```

Conversation continuity is send-only. `watch`, `status`, and `cancel` require `summary.continuation.task`.

### Check Task Status With `task_handle`

```json
{
  "action": "status",
  "continuation": {
    "target": {
      "target_url": "https://support.example/",
      "card_path": "/.well-known/agent-card.json",
      "preferred_transports": ["JSONRPC", "HTTP+JSON"],
      "target_alias": "support"
    },
    "task": {
      "task_handle": "rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0",
      "task_id": "task-456"
    },
    "conversation": {
      "context_id": "ctx-456",
      "can_send": true
    }
  },
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
    "response_kind": "task",
    "continuation": {
      "target": {
        "target_url": "https://support.example/",
        "card_path": "/.well-known/agent-card.json",
        "preferred_transports": ["JSONRPC", "HTTP+JSON"],
        "target_alias": "support"
      },
      "task": {
        "task_handle": "rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0",
        "task_id": "task-456",
        "status": "completed",
        "can_resume_send": false,
        "can_send": false,
        "can_status": true,
        "can_cancel": false,
        "can_watch": false
      },
      "conversation": {
        "context_id": "ctx-456",
        "can_send": true
      }
    }
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

```ts
const task = result.summary.continuation?.task
const conversation = result.summary.continuation?.conversation

if (!task) {
  throw new Error("status requires summary.continuation.task")
}

const nextStatus = task.task_handle
  ? { action: "status", continuation: result.summary.continuation }
  : { action: "status", continuation: result.summary.continuation }

const nextSend = conversation
  ? { action: "send", continuation: result.summary.continuation }
  : undefined
```

If `summary.continuation.task.task_handle` is expired or unavailable, retry with the same persisted `continuation`:

```json
{
  "action": "status",
  "continuation": {
    "target": {
      "target_url": "https://support.example/",
      "card_path": "/.well-known/agent-card.json",
      "preferred_transports": ["JSONRPC", "HTTP+JSON"],
      "target_alias": "support"
    },
    "task": {
      "task_handle": "rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0",
      "task_id": "task-456"
    }
  }
}
```

`watch` and `cancel` require `summary.continuation.task` from a prior result:

```json
{ "action": "watch", "continuation": { "target": { "target_url": "https://support.example/", "card_path": "/.well-known/agent-card.json", "preferred_transports": ["JSONRPC", "HTTP+JSON"], "target_alias": "support" }, "task": { "task_handle": "rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0", "task_id": "task-456" } } }
```

```json
{ "action": "cancel", "continuation": { "target": { "target_url": "https://support.example/", "card_path": "/.well-known/agent-card.json", "preferred_transports": ["JSONRPC", "HTTP+JSON"], "target_alias": "support" }, "task": { "task_handle": "rah_0a3ff8c2-4a6d-48cb-a57d-4ae6f3c589d0", "task_id": "task-456" } } }
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
          "message": "send requires task_handle, target_alias, target_url, or a configured default target"
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
      "retryHint": "Retry with the same nested continuation so the plugin can fall back to the persisted target plus taskId, or resend the original request after a restart to obtain a new handle.",
      "restartInvalidatesHandles": true,
      "suggested_actions": ["status", "send"],
      "hint": "Retry with the same nested continuation, or use flat target_alias + task_id only as manual compatibility."
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
