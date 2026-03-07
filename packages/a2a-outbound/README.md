# @aramisfa/openclaw-a2a-outbound

Native OpenClaw outbound A2A delegation plugin.

This package registers five optional tools in OpenClaw:

- `a2a_delegate`
- `a2a_delegate_stream`
- `a2a_task_status`
- `a2a_task_resubscribe`
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
- `a2a_delegate_stream`: same input contract as `a2a_delegate`, but bridges every yielded A2A stream event into OpenClaw `onUpdate(...)` callbacks and returns the full event transcript at completion.
- `a2a_task_status`: fetch the current state of a remote task.
- `a2a_task_resubscribe`: reconnect to a remote task stream using `target` plus `request.taskId`, `timeoutMs`, and `serviceParameters`.
- `a2a_task_cancel`: request cancellation for a remote task.

`a2a_delegate_stream` uses the SDK's built-in fallback behavior. If the peer card reports `streaming: false`, the SDK yields a single fallback `Message` or `Task`, and the tool still returns a normal stream transcript envelope. `a2a_task_resubscribe` requires peer streaming support and surfaces the SDK error when it is unavailable.

## Streaming Results

Streaming tools emit one OpenClaw tool update per yielded A2A event. Each update is wrapped with the normal `jsonResult(...)` helper and carries this payload:

```json
{
  "ok": true,
  "operation": "a2a_delegate_stream",
  "phase": "update",
  "target": {
    "baseUrl": "https://peer.example/",
    "cardPath": "/.well-known/agent-card.json",
    "preferredTransports": ["JSONRPC"]
  },
  "summary": {
    "kind": "status-update",
    "taskId": "task-123",
    "status": "working"
  },
  "raw": {
    "kind": "status-update",
    "taskId": "task-123",
    "contextId": "ctx-123",
    "status": { "state": "working" },
    "final": false
  }
}
```

On success, both streaming tools return a self-contained transcript payload:

```json
{
  "ok": true,
  "operation": "a2a_task_resubscribe",
  "summary": {
    "kind": "stream",
    "eventCount": 2,
    "finalEventKind": "artifact-update",
    "taskId": "task-123",
    "artifactId": "artifact-1"
  },
  "raw": {
    "events": [{ "...": "all yielded events in order" }],
    "finalEvent": { "...": "the terminal event object" }
  }
}
```

If a stream finishes without yielding any events, the tool returns:

```json
{
  "ok": false,
  "operation": "a2a_delegate_stream",
  "error": {
    "code": "A2A_SDK_ERROR",
    "message": "stream ended without events"
  }
}
```

If a stream fails after already yielding events, the error envelope still follows the normal failure shape and adds `partialEventCount` plus `latestEventSummary` to `error.details`.

## Development

```bash
pnpm build
pnpm test
```

## License

MIT
