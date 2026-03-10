# @aramisfa/openclaw-a2a-inbound

Native OpenClaw inbound A2A channel plugin.

This package serves an A2A agent card plus a JSON-RPC endpoint and routes supported inbound A2A requests into OpenClaw through the channel runtime. The agent card advertises the main `url` as its preferred `JSONRPC` transport and does not list duplicate interfaces when only that one official transport is available.

## Installation

```bash
openclaw plugins install @aramisfa/openclaw-a2a-inbound
```

Pin the exact published version if you want reproducible installs:

```bash
openclaw plugins install @aramisfa/openclaw-a2a-inbound --pin
```

## Minimal-Core Contract

- Plugin/package id: `openclaw-a2a-inbound`
- Registers one OpenClaw channel: `a2a`
- Serves:
  - agent card
  - JSON-RPC
- Does not expose:
  - file-delivery HTTP routes
  - outbound A2A file transport
  - optional JSON-RPC methods such as `message/stream`, `tasks/resubscribe`, and task push-notification config methods
- Default input modes: `["text/plain", "application/json"]`
- Default output modes: `["text/plain", "application/json"]`
- Documented supported A2A methods:
  - `message/send`
  - `tasks/get`
  - `tasks/cancel`

The channel account contract is:

- `enabled`
- `label`
- `description`
- `publicBaseUrl`
- `defaultAgentId`
- `sessionStore`
- `protocolVersion`
- `agentCardPath`
- `jsonRpcPath`
- `maxBodyBytes`
- `defaultInputModes`
- `defaultOutputModes`
- `skills`

Legacy config fields such as `restPath`, `capabilities`, `auth`, and `taskStore` are rejected during config parsing.

Removed optional methods are rejected at the JSON-RPC boundary instead of being routed through internal backdoors.

A2A tasks, events, messages, reply parts, and artifacts no longer emit `metadata.openclaw.*` or vendor `openclaw.reply` payloads.

Outbound replies only surface representable text. If a reply only contains media URLs or vendor-only payload after filtering, the request fails with A2A content-type-not-supported instead of exposing dead file links or synthetic vendor JSON parts.

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
          maxBodyBytes: 1048576,
          defaultInputModes: ["text/plain", "application/json"],
          defaultOutputModes: ["text/plain", "application/json"],
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

`publicBaseUrl` is the only required readiness prerequisite because the plugin needs it to publish a valid agent card URL.

## Package Layout

- `src/index.ts`: plugin entrypoint and registration
- `src/channel.ts`: OpenClaw channel definition
- `src/http-routes.ts`: plugin HTTP route registration
- `src/plugin-host.ts`: active account registry
- `src/a2a-server.ts`: A2A SDK server wiring
- `src/openclaw-executor.ts`: bridge from A2A `AgentExecutor` into OpenClaw
- `src/session-routing.ts`: inbound message and session mapping helpers
- `src/task-store.ts`: internal task runtime implementation
- `src/config.ts`: channel config schema and parser

## Development

```bash
corepack pnpm --filter @aramisfa/openclaw-a2a-inbound run build
corepack pnpm --filter @aramisfa/openclaw-a2a-inbound run test
```
