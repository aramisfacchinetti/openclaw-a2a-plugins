# openclaw-a2a-plugins

`openclaw-a2a-plugins` is a monorepo for OpenClaw Agent-to-Agent (A2A) plugins.

Today, the only implemented package intended for use is [`@aramisfa/openclaw-a2a-outbound`](./packages/a2a-outbound). The inbound package, [`@aramisfa/openclaw-a2a-inbound`](./packages/a2a-inbound), is currently a placeholder and is not documented or ready for general use.

## Packages

| Package | Status | Notes |
| --- | --- | --- |
| [`@aramisfa/openclaw-a2a-outbound`](./packages/a2a-outbound) | Available now | Outbound OpenClaw plugin for delegating work to external A2A agents. |
| [`@aramisfa/openclaw-a2a-inbound`](./packages/a2a-inbound) | Placeholder / experimental | Stub package only. Do not assume installation or usage guidance exists yet. |

## Current Capabilities

Current usable functionality is provided by `@aramisfa/openclaw-a2a-outbound` only.

It registers these OpenClaw tools:

- `a2a_delegate`
- `a2a_task_status`
- `a2a_task_cancel`

At a high level, the outbound plugin lets OpenClaw delegate work to external A2A agents, then check or cancel delegated tasks later.

Plugin id: `a2a-outbound`

## Getting Started

Install the outbound package:

```bash
npm install @aramisfa/openclaw-a2a-outbound
```

Requirements:

- Node.js `>=22.12.0`
- OpenClaw `2026.3.2`

For complete configuration and usage details, use the package-level documentation in [`packages/a2a-outbound/README.md`](./packages/a2a-outbound/README.md). The root README is intentionally a summary so the outbound package docs remain the main source of truth.

Minimal orientation example for the outbound plugin config:

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

The outbound package README documents the full config shape, defaults, and behavior.

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

This repository does not currently include a root `LICENSE` file in the workspace, so add it before publishing the repository.
