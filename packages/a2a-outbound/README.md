# @aramisfa/openclaw-a2a-outbound

Native OpenClaw outbound A2A delegation plugin.

This package registers four optional tools in OpenClaw:

- `a2a_delegate`
- `a2a_task_status`
- `a2a_task_wait`
- `a2a_task_cancel`

## Installation

```bash
npm install @aramisfa/openclaw-a2a-outbound
```

## Requirements

- Node.js `>=22.12.0`
- OpenClaw `2026.3.2`

## OpenClaw Plugin Config

`@aramisfa/openclaw-a2a-outbound` is disabled by default. Enable it in your plugin config:

```json
{
  "enabled": true,
  "defaults": {
    "timeoutMs": 120000,
    "cardPath": "/.well-known/agent-card.json",
    "preferredTransports": ["JSONRPC", "HTTP+JSON"],
    "serviceParameters": {}
  },
  "policy": {
    "acceptedOutputModes": [],
    "normalizeBaseUrl": true,
    "enforceSupportedTransports": true
  }
}
```

## Validation Errors

Tool input validation is powered by [Ajv](https://ajv.js.org/) in strict mode. When validation fails, the error envelope contains native Ajv error objects:

```json
{
  "ok": false,
  "operation": "a2a_delegate",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "a2a_delegate input validation failed",
    "details": {
      "source": "ajv",
      "tool": "a2a_delegate",
      "errors": [
        {
          "keyword": "required",
          "instancePath": "/request/message",
          "params": { "missingProperty": "kind" }
        }
      ]
    }
  }
}
```

The `error.details.errors` array contains Ajv `ErrorObject` entries. See the [Ajv error documentation](https://ajv.js.org/api.html#error-objects) for the full shape.

## Tool Summary

- `a2a_delegate`: send one outbound A2A request and return the final `Message` or `Task`.
- `a2a_task_status`: fetch the current state of a remote task.
- `a2a_task_wait`: repeatedly call `tasks/get` until the task reaches a terminal state or `request.waitTimeoutMs` expires. `request.timeoutMs` stays a per-poll RPC timeout.
- `a2a_task_cancel`: request cancellation for a remote task.

## Delegate Then Wait

When `a2a_delegate` returns a task, pass that `taskId` into `a2a_task_wait`:

```json
{
  "delegateResult": {
    "ok": true,
    "operation": "a2a_delegate",
    "summary": {
      "kind": "task",
      "taskId": "task-123",
      "status": "submitted"
    }
  },
  "waitRequest": {
    "target": {
      "baseUrl": "https://peer.example"
    },
    "request": {
      "taskId": "task-123",
      "waitTimeoutMs": 60000,
      "timeoutMs": 10000
    }
  }
}
```

On success, `a2a_task_wait` returns the last observed task plus a compact wait summary:

```json
{
  "ok": true,
  "operation": "a2a_task_wait",
  "summary": {
    "taskId": "task-123",
    "status": "completed",
    "attempts": 3,
    "elapsedMs": 842
  },
  "raw": {
    "kind": "task",
    "id": "task-123",
    "contextId": "ctx-123",
    "status": { "state": "completed" }
  }
}
```

If the overall wait deadline expires first, the tool returns a timeout envelope with the latest task snapshot:

```json
{
  "ok": false,
  "operation": "a2a_task_wait",
  "error": {
    "code": "WAIT_TIMEOUT",
    "message": "timed out waiting for task task-123",
    "details": {
      "taskId": "task-123",
      "waitTimeoutMs": 60000,
      "attempts": 4,
      "elapsedMs": 60000,
      "lastTask": {
        "kind": "task",
        "id": "task-123",
        "status": { "state": "working" }
      }
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
