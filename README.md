# A2A Plugins for OpenClaw

[![outbound npm](https://img.shields.io/npm/v/%40aramisfa%2Fopenclaw-a2a-outbound?label=outbound%20npm)](https://www.npmjs.com/package/@aramisfa/openclaw-a2a-outbound)
[![node](https://img.shields.io/node/v/%40aramisfa%2Fopenclaw-a2a-outbound)](https://www.npmjs.com/package/@aramisfa/openclaw-a2a-outbound)
[![license](https://img.shields.io/github/license/aramisfacchinetti/openclaw-a2a-plugins)](https://github.com/aramisfacchinetti/openclaw-a2a-plugins/blob/master/LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.3.2-0A7B83)](https://github.com/aramisfacchinetti/openclaw-a2a-plugins/tree/master/packages/a2a-outbound)

`openclaw-a2a-plugins` is a monorepo for OpenClaw Agent-to-Agent (A2A) plugins.

Today, the only implemented package intended for use is [`@aramisfa/openclaw-a2a-outbound`](./packages/a2a-outbound). The inbound package, [`@aramisfa/openclaw-a2a-inbound`](./packages/a2a-inbound), is currently a placeholder and is not documented or ready for general use.

## Getting Started

Start with the outbound plugin, [`@aramisfa/openclaw-a2a-outbound`](./packages/a2a-outbound). It is the supported package in this repository today. It lets OpenClaw discover configured targets, delegate work to external A2A agents, watch live task updates, poll delegated task status, and cancel delegated work through one unified tool: `remote_agent`.

### Prerequisites

- Node.js `>=22.12.0`
- OpenClaw `2026.3.2`

### Install the Package

```bash
npm install @aramisfa/openclaw-a2a-outbound
```

### Enable the Plugin

Enable plugin id `a2a-outbound` in your OpenClaw plugin config. The outbound config starts with this top-level shape:

```json
{
  "enabled": true,
  "defaults": {
    "timeoutMs": 120000
  },
  "policy": {
    "normalizeBaseUrl": true
  }
}
```

### Where to Go Next

Use [`packages/a2a-outbound/README.md`](./packages/a2a-outbound/README.md) for full configuration details, validation behavior, and package-specific usage.

## Packages

| Package | Status | Notes |
| --- | --- | --- |
| [`@aramisfa/openclaw-a2a-outbound`](./packages/a2a-outbound) | Available now | Outbound OpenClaw plugin exposing one `remote_agent` tool for remote delegation and task follow-up. |
| [`@aramisfa/openclaw-a2a-inbound`](./packages/a2a-inbound) | Placeholder / experimental | Stub package only. Do not assume installation or usage guidance exists yet. |

## Current Capabilities

Current usable functionality is provided by `@aramisfa/openclaw-a2a-outbound` only.

It registers one optional OpenClaw tool:

- `remote_agent`

`remote_agent` exposes these actions:

- `list_targets`: discover configured targets and refreshed target-card metadata.
- `send`: route work to a configured alias, an allowed explicit URL, or the configured default target.
- `watch`: stream updates for a delegated task.
- `status`: fetch the latest snapshot for a delegated task.
- `cancel`: request cancellation for a delegated task.

Follow-up actions prefer `task_handle` first, then `target_alias` + `task_id` when the handle has expired or is unavailable.

Plugin id: `a2a-outbound`

## Repository Layout

- [`packages/a2a-outbound`](./packages/a2a-outbound): implemented outbound A2A plugin package, including docs, source, tests, and plugin manifest.
- [`packages/a2a-inbound`](./packages/a2a-inbound): placeholder inbound workspace package that is not yet ready for general use.
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

## License

See the root [`LICENSE`](./LICENSE).
