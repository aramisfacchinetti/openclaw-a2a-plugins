# @aramisfa/openclaw-a2a-inbound

Native OpenClaw inbound A2A channel plugin.

This package serves an A2A agent card plus a JSON-RPC endpoint and routes supported inbound A2A requests into OpenClaw through the channel runtime.

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
