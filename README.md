# A2A Plugins for OpenClaw

[![license](https://img.shields.io/github/license/aramisfacchinetti/openclaw-a2a-plugins)](https://github.com/aramisfacchinetti/openclaw-a2a-plugins/blob/master/LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.3.2-0A7B83)](https://github.com/aramisfacchinetti/openclaw-a2a-plugins)
[![outbound npm](https://img.shields.io/npm/v/%40aramisfa%2Fopenclaw-a2a-outbound?label=outbound%20npm)](https://www.npmjs.com/package/@aramisfa/openclaw-a2a-outbound)
[![inbound npm](https://img.shields.io/badge/inbound%20npm-not%20published%20yet-lightgrey)](./packages/openclaw-a2a-inbound)

`openclaw-a2a-plugins` is a monorepo for OpenClaw Agent-to-Agent (A2A) plugins.

Today, the repository includes one published package and one package that is not published yet:

- [`@aramisfa/openclaw-a2a-outbound`](./packages/openclaw-a2a-outbound): delegate requests from OpenClaw to external A2A agents through the `remote_agent` tool.
- [`@aramisfa/openclaw-a2a-inbound`](./packages/openclaw-a2a-inbound): expose an OpenClaw agent as an inbound A2A endpoint through the `a2a` channel.

## Getting Started

Choose the package that matches the traffic direction you need:

- outbound: OpenClaw initiates calls to remote A2A peers.
- inbound: remote A2A peers initiate calls into an OpenClaw agent.

### Prerequisites

- Node.js `>=22.12.0`
- OpenClaw `2026.3.2`

### Install a Package

```bash
openclaw plugins install @aramisfa/openclaw-a2a-outbound
```

`@aramisfa/openclaw-a2a-inbound` is implemented in this repository and will be published to npm in the future.

Optional guided setup helper:

```bash
clawhub install a2a-delegation-setup
```

The ClawHub skill is a slash-command setup helper for installing, enabling, configuring, verifying, updating, and troubleshooting `@aramisfa/openclaw-a2a-outbound`. It is optional and does not replace the primary plugin distribution path above.

### Outbound Quickstart

1. Enable plugin id `openclaw-a2a-outbound` in your OpenClaw plugin config and add at least one target:

```json
{
  "enabled": true,
  "targets": [
    {
      "alias": "support",
      "baseUrl": "https://support.example",
      "default": true
    }
  ]
}
```

2. In OpenClaw, call `remote_agent` with:

```json
{ "action": "list_targets" }
```

3. Send work to a configured alias:

```json
{
  "action": "send",
  "target_alias": "support",
  "input": "Summarize this incident and propose next steps."
}
```

### Inbound Quickstart

1. Enable channel id `a2a` and add at least one account under `channels.a2a.accounts`:

```json5
{
  channels: {
    a2a: {
      accounts: {
        default: {
          enabled: true,
          publicBaseUrl: "https://agents.example.com",
          defaultAgentId: "main",
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

2. Start OpenClaw and fetch the published agent card from `/.well-known/agent-card.json`.

3. Send A2A traffic to `/a2a/jsonrpc` or `/a2a/rest`.

### Where to Go Next

Use the package READMEs for full configuration details and examples:

- [`packages/openclaw-a2a-outbound/README.md`](./packages/openclaw-a2a-outbound/README.md)
- [`packages/openclaw-a2a-inbound/README.md`](./packages/openclaw-a2a-inbound/README.md)

## Packages

| Package | Status | Notes |
| --- | --- | --- |
| [`@aramisfa/openclaw-a2a-outbound`](./packages/openclaw-a2a-outbound) | Available now | Outbound OpenClaw plugin exposing one `remote_agent` tool for remote delegation and task follow-up. |
| [`@aramisfa/openclaw-a2a-inbound`](./packages/openclaw-a2a-inbound) | Not published yet | Inbound OpenClaw channel plugin exposing an `a2a` endpoint with direct, non-blocking, streaming, and durable task flows. Push notifications and OpenClaw-initiated outbound delivery are not implemented yet. |

## Current Capabilities

- `@aramisfa/openclaw-a2a-outbound` registers the `remote_agent` tool with `list_targets`, `send`, `watch`, `status`, and `cancel`.
- `@aramisfa/openclaw-a2a-inbound` registers the `a2a` channel plus per-account agent-card, JSON-RPC, and REST routes.
- The outbound package config lives under plugin id `openclaw-a2a-outbound`.
- The inbound package config lives under `channels.a2a`, not `plugins.entries`.

## Repository Layout

- [`packages/openclaw-a2a-outbound`](./packages/openclaw-a2a-outbound): implemented outbound A2A plugin package, including docs, source, tests, and plugin manifest.
- [`packages/openclaw-a2a-inbound`](./packages/openclaw-a2a-inbound): inbound A2A channel plugin package, including docs, source, tests, and plugin manifest.
- Workspace root: shared `pnpm` workspace tooling, TypeScript project configuration, and Changesets release management.

## Development

This repository uses a `pnpm` workspace.

From the repository root:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm clean
```

Releases are managed with [Changesets](https://github.com/changesets/changesets).

Create version intent locally with:

```bash
pnpm changeset
pnpm version-packages
```

`pnpm version-packages` runs `changeset version` and then syncs any `openclaw.plugin.json` manifest version with its package version before the release PR is committed.

Do not run `pnpm release` or `npm publish` for real publishes from a local checkout. Publishing is CI-only through [`.github/workflows/release.yml`](./.github/workflows/release.yml) on `master`, which opens or updates the Changesets release PR, publishes to npm after merge, and creates package-specific GitHub Releases. Local verification should use `npm publish --dry-run`.

The release workflow uses npm trusted publishing through GitHub Actions OIDC instead of an `NPM_TOKEN` secret. Configure npm trusted publishing for each package you want CI to publish, and keep the workflow filename exactly `release.yml`.

## License

See the root [`LICENSE`](./LICENSE).
