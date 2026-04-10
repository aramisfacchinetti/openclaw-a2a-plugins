# @aramisfa/openclaw-a2a-inbound

Native OpenClaw inbound A2A channel plugin.

This package serves an A2A agent card plus a JSON-RPC endpoint and routes inbound A2A requests into OpenClaw through one committed task runtime. The runtime is the single source of truth for `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, and `tasks/resubscribe`.

The runtime keeps the public A2A contract unchanged while persisting an internal durable committed journal beside the latest committed task snapshot.

## Installation

```bash
openclaw plugins install @aramisfa/openclaw-a2a-inbound
```

Pin the exact published version if you want reproducible installs:

```bash
openclaw plugins install @aramisfa/openclaw-a2a-inbound --pin
```

## Networking Prerequisites

This plugin is an **inbound channel**: it waits for external A2A agents to call it over HTTP. Two independent requirements must both be met before any traffic can arrive.

**1. Set `publicBaseUrl` in the account config**

`publicBaseUrl` is the plugin's only config-level readiness gate. Without it the account will not start because the agent card URL cannot be constructed. Set it to the externally reachable base URL of your gateway (see below).

**2. Make the OpenClaw gateway reachable from the internet**

OpenClaw binds to `127.0.0.1` by default (`gateway.bind: "loopback"`). An external agent can never connect to a loopback address. You must configure the gateway to accept external connections before any A2A traffic can arrive:

| Goal | Gateway config |
| --- | --- |
| LAN / reverse proxy (nginx, Caddy, Cloudflare Tunnel, …) | `gateway.bind: "lan"` (binds `0.0.0.0`) |
| Tailscale Serve — tailnet-only HTTPS | `gateway.bind: "tailnet"`, `gateway.tailscale.mode: "serve"` |
| Tailscale Funnel — public internet HTTPS | `gateway.bind: "tailnet"`, `gateway.tailscale.mode: "funnel"` |
| Explicit bind host | `gateway.bind: "custom"`, `gateway.customBindHost: "<host>"` |

Set `publicBaseUrl` to the URL that resolves through whichever of the above options you choose — the agent card and the gateway endpoint must agree.

## Current Contract

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

## Follow-Up Routing Boundary

`@aramisfa/openclaw-a2a-inbound` is an inbound transport bridge. It is not the outbound A2A continuation surface for this repo.

Supported:

- direct inbound A2A request handling
- in-band replies during the active inbound request lifecycle
- A2A task APIs served by the inbound plugin

Unsupported:

- generic OpenClaw-initiated outbound sends through channel `a2a`
- generic queued follow-up routing that re-enters channel `a2a`
- treating inbound channel metadata as equivalent to `remote_agent` continuation

By default, inbound A2A suppresses generic OpenClaw origin-routing fields so later queued follow-ups do not get classified as generic channel-routable `a2a` replies. `OriginatingChannel`, `OriginatingTo`, and channel `capabilities.reply` do not establish generic queued outbound routability for channel `a2a`.

`originRoutingPolicy` defaults to `suppress-generic-followup`. Set `originRoutingPolicy: "legacy-origin-routing"` only as a short-lived escape hatch if some host behavior still requires generic OpenClaw origin metadata and you accept the queued follow-up boundary described here.

If OpenClaw tries to route a queued follow-up through the inbound channel adapter, the plugin fails deliberately with:

```text
A2A_OUTBOUND_DELIVERY_UNSUPPORTED: openclaw-a2a-inbound does not implement OpenClaw-initiated outbound delivery. Use openclaw-a2a-outbound for delegated outbound A2A calls.
```

That failure is the intended boundary. In this repository, outbound A2A continuation is supported only through `@aramisfa/openclaw-a2a-outbound`, the `remote_agent` tool, and persisted `summary.continuation` state.

## Task Storage

Each account can select one task store:

- `memory`
- `json-file`

If `taskStore` is omitted, it defaults to:

```json
{ "kind": "memory" }
```

`json-file.path` must be a non-empty absolute path.

The durable json-file store keeps one schema v2 record per task containing:

- the latest committed task snapshot
- the stored OpenClaw binding
- `currentSequence`
- the ordered committed journal of `status-update` and `artifact-update` events

The initial `Task` snapshot is not journaled. The durable journal is internal-only and is used only to preserve committed history.

Existing schema v1 snapshot-only json-file records load through a lazy one-way upgrade in memory and persist as schema v2 on the next write.

The runtime does not expose:

- public committed journal replay
- public backlog replay
- replay cursors or replay markers
- lease heartbeats
- orphan recovery
- hidden replay toggles

Direct streaming runs that never promote return one canonical final `Message` and do not materialize a task. Promoted runs persist the committed task snapshot and committed updates.

Each account also exposes `agentStyle`:

- `hybrid` (default): stay protocol-faithful and allow new blocking or streaming sends to complete as a direct `Message` when task promotion never becomes necessary
- `task-generating`: eagerly materialize every new execution as a task, so simple blocking replies return a `Task` and simple streaming replies emit task-bearing events

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
          agentStyle: "hybrid",
          originRoutingPolicy: "suppress-generic-followup",
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

`publicBaseUrl` is the only plugin-level readiness prerequisite — the account will not start without it. Gateway networking must also be configured independently; see [Networking Prerequisites](#networking-prerequisites).

## Streaming And Resubscribe Semantics

- `message/send`
  - `blocking` with `agentStyle="hybrid"`: may return a direct canonical `Message` or a committed `Task`
  - `blocking` with `agentStyle="task-generating"`: always returns a committed `Task`
  - `non_blocking`: always starts on the task path
- `message/stream`
  - `agentStyle="hybrid"` direct runs yield exactly one canonical final `Message`
  - `agentStyle="task-generating"` new runs emit the committed initial `Task`, then committed `status-update` and `artifact-update` events, then the committed final status update
  - promoted runs yield the committed initial `Task`, then committed `status-update` and `artifact-update` events, then the committed final status update
- `tasks/resubscribe`
  - emits the latest committed task snapshot first
  - attaches a live tail only when the task is still active and the execution is live in the current process
  - does not replay stored journal backlog
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
