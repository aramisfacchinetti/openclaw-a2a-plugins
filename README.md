# A2A Plugins for OpenClaw

[![outbound npm](https://img.shields.io/npm/v/%40aramisfa%2Fopenclaw-a2a-outbound?label=outbound%20npm)](https://www.npmjs.com/package/@aramisfa/openclaw-a2a-outbound)
[![node](https://img.shields.io/node/v/%40aramisfa%2Fopenclaw-a2a-outbound)](https://www.npmjs.com/package/@aramisfa/openclaw-a2a-outbound)
[![license](https://img.shields.io/github/license/aramisfacchinetti/openclaw-a2a-plugins)](https://github.com/aramisfacchinetti/openclaw-a2a-plugins/blob/master/LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.3.2-0A7B83)](https://github.com/aramisfacchinetti/openclaw-a2a-plugins/tree/master/packages/openclaw-a2a-outbound)

`openclaw-a2a-plugins` is a monorepo for OpenClaw Agent-to-Agent (A2A) plugins.

Today, the repository includes one production-oriented package, [`@aramisfa/openclaw-a2a-outbound`](./packages/openclaw-a2a-outbound), and one inbound channel scaffold, [`@aramisfa/openclaw-a2a-inbound`](./packages/openclaw-a2a-inbound). The inbound package now has a concrete OpenClaw channel/plugin skeleton, but it is still exploratory and not ready to treat as a finished production integration.

## Getting Started

Start with the outbound plugin, [`@aramisfa/openclaw-a2a-outbound`](./packages/openclaw-a2a-outbound). It is the supported package in this repository today. It lets OpenClaw discover configured targets, delegate work to external A2A agents, watch live task updates, poll delegated task status, and cancel delegated work through one unified tool: `remote_agent`.

### Prerequisites

- Node.js `>=22.12.0`
- OpenClaw `2026.3.2`

### Install the Plugin

```bash
openclaw plugins install @aramisfa/openclaw-a2a-outbound
```

### Quickstart

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

### Where to Go Next

Use [`packages/openclaw-a2a-outbound/README.md`](./packages/openclaw-a2a-outbound/README.md) for full configuration details, validation behavior, and package-specific usage.

## Packages

| Package | Status | Notes |
| --- | --- | --- |
| [`@aramisfa/openclaw-a2a-outbound`](./packages/openclaw-a2a-outbound) | Available now | Outbound OpenClaw plugin exposing one `remote_agent` tool for remote delegation and task follow-up. |
| [`@aramisfa/openclaw-a2a-inbound`](./packages/openclaw-a2a-inbound) | Exploratory scaffold | Concrete inbound channel/plugin skeleton using the official A2A SDK handlers, but task streaming and production-hardening remain unfinished. |

## Current Capabilities

Current production-ready functionality is provided by `@aramisfa/openclaw-a2a-outbound`. The inbound package now provides a concrete scaffold for follow-on implementation work.

It registers one optional OpenClaw tool:

- `remote_agent`

`remote_agent` exposes these actions:

- `list_targets`: discover configured targets and refreshed target-card metadata.
- `send`: route work to a configured alias, an allowed explicit URL, or the configured default target.
- `watch`: stream updates for a delegated task.
- `status`: fetch the latest snapshot for a delegated task.
- `cancel`: request cancellation for a delegated task.

Follow-up actions prefer `task_handle` first, then `target_alias` + `task_id` when the handle has expired or is unavailable.

Plugin id: `openclaw-a2a-outbound`

## Repository Layout

- [`packages/openclaw-a2a-outbound`](./packages/openclaw-a2a-outbound): implemented outbound A2A plugin package, including docs, source, tests, and plugin manifest.
- [`packages/openclaw-a2a-inbound`](./packages/openclaw-a2a-inbound): inbound A2A channel/plugin scaffold with config schema, route registration, and A2A/OpenClaw bridge structure.
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
