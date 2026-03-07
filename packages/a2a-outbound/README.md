# @aramisfa/openclaw-a2a-outbound

Native OpenClaw outbound A2A delegation plugin.

This package registers three optional tools in OpenClaw:

- `a2a_delegate`
- `a2a_task_status`
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

## Development

```bash
pnpm build
pnpm test
```

## License

MIT
