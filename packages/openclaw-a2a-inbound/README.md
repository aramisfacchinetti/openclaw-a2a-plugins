# @aramisfa/openclaw-a2a-inbound

Inbound A2A channel plugin scaffold for OpenClaw agents.

This package is a concrete implementation skeleton for accepting inbound A2A traffic with the official `@a2a-js/sdk` server handlers while routing requests into OpenClaw through the channel runtime. It is intentionally scoped as an exploratory foundation, not a finished production channel.

## Current Scope

- Plugin/package id: `openclaw-a2a-inbound`
- Registers one OpenClaw channel: `a2a`
- Registers per-account HTTP routes for:
  - agent card
  - JSON-RPC
  - REST
- Builds A2A handlers using the official SDK
- Bridges direct text requests into the OpenClaw reply pipeline
- Exposes a diagnostic gateway RPC method: `openclaw-a2a-inbound.describe`

## Not Yet Implemented

- durable task lifecycle beyond the included task-store scaffold
- streaming task updates mapped back into A2A task/status events
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
            kind: "memory"
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
- `src/task-store.ts`: in-memory and JSON-file task-store implementations
- `src/config.ts`: channel config schema and parser

## Development

```bash
corepack pnpm --filter @aramisfa/openclaw-a2a-inbound run build
corepack pnpm --filter @aramisfa/openclaw-a2a-inbound run test
```
