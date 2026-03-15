# A2A Plugins for OpenClaw

[![license](https://img.shields.io/github/license/aramisfacchinetti/openclaw-a2a-plugins)](https://github.com/aramisfacchinetti/openclaw-a2a-plugins/blob/master/LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.3.2-0A7B83)](https://github.com/aramisfacchinetti/openclaw-a2a-plugins)
[![outbound npm](https://img.shields.io/npm/v/%40aramisfa%2Fopenclaw-a2a-outbound?label=outbound%20npm)](https://www.npmjs.com/package/@aramisfa/openclaw-a2a-outbound)
[![inbound npm](https://img.shields.io/npm/v/%40aramisfa%2Fopenclaw-a2a-inbound?label=inbound%20npm)](https://www.npmjs.com/package/@aramisfa/openclaw-a2a-inbound)

`openclaw-a2a-plugins` is a monorepo for OpenClaw Agent-to-Agent (A2A) plugins.

For package-specific configuration, installation, and usage details, use the plugin READMEs:

- [`packages/openclaw-a2a-outbound/README.md`](./packages/openclaw-a2a-outbound/README.md)
- [`packages/openclaw-a2a-inbound/README.md`](./packages/openclaw-a2a-inbound/README.md)

## Repository Layout

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

## License

See the root [`LICENSE`](./LICENSE).
