# @aramisfa/openclaw-a2a-inbound

Native OpenClaw inbound A2A channel plugin.

This package serves an A2A agent card plus a JSON-RPC endpoint and routes inbound A2A requests into OpenClaw through one committed task runtime. The runtime is the single source of truth for `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, and `tasks/resubscribe`.

## Installation

```bash
openclaw plugins install @aramisfa/openclaw-a2a-inbound
```

Pin the exact published version if you want reproducible installs:

```bash
openclaw plugins install @aramisfa/openclaw-a2a-inbound --pin
```

## Phase 1 Contract

- Plugin/package id: `openclaw-a2a-inbound`
- Registers one OpenClaw channel: `a2a`
- Serves:
  - agent card
  - JSON-RPC
- Advertises:
  - `streaming = true`
  - `pushNotifications = false`
- Supports:
  - `message/send`
  - `message/stream`
  - `tasks/get`
  - `tasks/cancel`
  - `tasks/resubscribe`
- Rejects with `methodNotFound`:
  - `tasks/pushNotificationConfig/set`
  - `tasks/pushNotificationConfig/get`
  - `tasks/pushNotificationConfig/list`
  - `tasks/pushNotificationConfig/delete`
- Does not expose:
  - REST transport
  - `/a2a/files`
  - outbound A2A file transport
  - push notifications

Default content modes:

- input: `["text/plain", "application/json"]`
- output: `["text/plain", "application/json"]`

Inbound request parts:

- supported: `text`, `data`
- rejected: any A2A `file` part with `invalidParams`

Serialized A2A payloads do not emit `metadata.openclaw.*` or vendor `openclaw.reply` payloads.

## Task Storage

Each account can select one phase 1 task store:

- `memory`
- `json-file`

If `taskStore` is omitted, it defaults to:

```json
{ "kind": "memory" }
```

`json-file.path` must be a non-empty absolute path.

Phase 1 persistence stores one durable record per task containing:

- the latest committed task snapshot
- the stored OpenClaw binding

Phase 1 does not add:

- committed journal replay
- backlog replay
- lease heartbeats
- orphan recovery
- hidden replay toggles

Direct streaming runs that never promote return one canonical final `Message` and do not materialize a task. Promoted runs persist the committed task snapshot and committed updates.

## Example OpenClaw Config

Channel config lives under `channels.a2a`, not under `plugins.entries`.

```json5
{
  channels: {
    a2a: {
      accounts: {
        default: {
          enabled: true,
          label: "Primary A2A Endpoint",
          publicBaseUrl: "https://agents.example.com",
          defaultAgentId: "main",
          agentCardPath: "/.well-known/agent-card.json",
          jsonRpcPath: "/a2a/jsonrpc",
          maxBodyBytes: 1048576,
          defaultInputModes: ["text/plain", "application/json"],
          defaultOutputModes: ["text/plain", "application/json"],
          taskStore: {
            kind: "json-file",
            path: "/var/lib/openclaw/a2a-tasks"
          },
          skills: [
            {
              id: "chat",
              name: "Chat"
            }
          ]
        }
      }
    }
  }
}
```

`publicBaseUrl` is the only readiness prerequisite because the plugin needs it to publish a valid agent card URL.

## Streaming And Resubscribe Semantics

- `message/send`
  - `blocking`: may return a direct canonical `Message` or a committed `Task`
  - `non_blocking`: always starts on the task path
- `message/stream`
  - direct runs yield exactly one canonical final `Message`
  - promoted runs yield the committed initial `Task`, then committed `status-update` and `artifact-update` events, then the committed final status update
- `tasks/resubscribe`
  - emits the latest committed task snapshot first
  - attaches a live tail only when the task is still active and the execution is live in the current process
  - terminal, quiescent, and restart-orphaned active tasks emit the snapshot and close

`tasks/cancel` keeps the same committed semantics:

- terminal tasks pass through unchanged
- quiescent tasks are canceled immediately
- active tasks can be canceled only while live in the current process

## Package Layout

- `src/index.ts`: plugin entrypoint and registration
- `src/channel.ts`: OpenClaw channel definition
- `src/http-routes.ts`: plugin HTTP route registration
- `src/plugin-host.ts`: active account registry
- `src/a2a-server.ts`: A2A SDK server wiring
- `src/request-handler.ts`: committed request lifecycle handling
- `src/openclaw-executor.ts`: bridge from A2A `AgentExecutor` into OpenClaw
- `src/task-store.ts`: committed runtime store plus memory/json-file backends
- `src/session-routing.ts`: inbound message and session mapping helpers
- `src/config.ts`: channel config schema and parser

## Requirements

- Node.js `>=22.12.0`
- OpenClaw `2026.3.2`

## Development

```bash
corepack pnpm --filter @aramisfa/openclaw-a2a-inbound run build
corepack pnpm --filter @aramisfa/openclaw-a2a-inbound run test
```
