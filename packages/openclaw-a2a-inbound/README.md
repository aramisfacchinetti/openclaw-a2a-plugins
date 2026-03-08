# @aramisfa/openclaw-a2a-inbound

Inbound A2A channel plugin scaffold for OpenClaw agents.

This package is a concrete implementation skeleton for accepting inbound A2A traffic on the official `@a2a-js/sdk` transport surface while routing requests into OpenClaw through the channel runtime. It is intentionally scoped as an exploratory foundation, not a finished production channel.

## Current Scope

- Plugin/package id: `openclaw-a2a-inbound`
- Registers one OpenClaw channel: `a2a`
- Registers per-account HTTP routes for:
  - agent card
  - JSON-RPC
  - REST
- Builds A2A transport handlers on the official SDK types
- Bridges direct text requests into the OpenClaw reply pipeline
- Exposes a diagnostic gateway RPC method: `openclaw-a2a-inbound.describe`
- Includes a repo-local durable task runtime for snapshot persistence, ordered event replay, and orphan recovery

## Response Behavior

The inbound executor uses request mode to decide whether the initial A2A response stays on the direct `Message` fast path or starts as a `Task`.

| A2A call | Initial response | Incremental progress | Terminal completion |
| --- | --- | --- | --- |
| `sendMessage(...)` with default blocking behavior | Direct `Message` for simple text-only runs; promoted `Task` when task-only features are needed | None on the direct-message path | Direct `Message` or terminal `Task` |
| `sendMessage({ blocking: false })` | Always `Task` with initial `submitted` state | `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent` updates during execution | Persisted terminal `Task` |
| `sendMessageStream(...)` | Always `Task` as the first streamed event | `submitted` / `working` status updates plus incremental `assistant-output`, tool-progress, and tool-result artifact updates | Final status update with a completed, failed, or canceled task |

Assistant preview text is emitted through a single `assistant-output` artifact for the whole run. Streaming and non-blocking executions publish incremental artifact updates as OpenClaw emits assistant and tool events, then close the artifact with a final `lastChunk` update when execution finishes.

`resubscribe()` now serves the latest task snapshot plus durable replay from the committed journal instead of depending on a live in-process event bus. If a nonterminal task is found without a live owner and with an expired or missing lease, it is reconciled to terminal `failed` with the message `Task execution was interrupted by process loss before completion.`

## Durable Task Runtime

`taskStore.kind = "json-file"` enables a directory-backed runtime store rooted at `taskStore.path`.

Per task, the runtime stores:

- `tasks/<base64url(taskId)>/snapshot.json`
- `tasks/<base64url(taskId)>/events.ndjson`
- `tasks/<base64url(taskId)>/runtime.json`

Notes:

- `taskStore.path` is a directory root in v1, not a single JSON file.
- The file-backed runtime is single-writer. Startup fails fast if another live process already owns the same root.
- Durable replay and `AgentCard.capabilities.stateTransitionHistory = true` are only enabled for `json-file` mode.
- `memory` mode keeps the same replay API inside the current process lifetime, but all task state disappears on restart.

## Vendor Extensions

The inbound runtime uses `openclaw` metadata extensions for durable replay cursors and journal sequence reporting.

- Request cursor: `params.metadata.openclaw.afterSequence`
- Task snapshot metadata: `task.metadata.openclaw.currentSequence`
- Stream event metadata: `metadata.openclaw.sequence`
- Replay marker on replayed events: `metadata.openclaw.replayed = true`

## Not Yet Implemented

- push notifications
- outbound delivery back to remote A2A peers initiated by OpenClaw

## Requirements

- Node.js `>=22.12.0`
- OpenClaw `2026.3.2`

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
          restPath: "/a2a/rest",
          auth: {
            mode: "header-token",
            headerName: "authorization",
            tokenEnv: "OPENCLAW_A2A_TOKEN"
          },
          taskStore: {
            kind: "json-file",
            path: "/var/lib/openclaw/a2a-runtime"
          }
        }
      }
    }
  }
}
```

## Package Layout

- `src/index.ts`: plugin entrypoint and registration
- `src/channel.ts`: OpenClaw channel definition
- `src/http-routes.ts`: plugin HTTP route registration
- `src/plugin-host.ts`: active account registry and auth gate
- `src/a2a-server.ts`: official A2A SDK server wiring
- `src/openclaw-executor.ts`: bridge from A2A `AgentExecutor` into OpenClaw
- `src/session-routing.ts`: inbound message and session mapping helpers
- `src/task-store.ts`: in-memory and JSON-file durable runtime store implementations
- `src/config.ts`: channel config schema and parser

## Development

```bash
corepack pnpm --filter @aramisfa/openclaw-a2a-inbound run build
corepack pnpm --filter @aramisfa/openclaw-a2a-inbound run test
```
