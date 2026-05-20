# A2A Plugins for OpenClaw

[![license](https://img.shields.io/github/license/aramisfacchinetti/openclaw-a2a-plugins)](https://github.com/aramisfacchinetti/openclaw-a2a-plugins/blob/master/LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.3.2-0A7B83)](https://github.com/aramisfacchinetti/openclaw-a2a-plugins)
[![outbound npm](https://img.shields.io/npm/v/%40aramisfa%2Fopenclaw-a2a-outbound?label=outbound%20npm)](https://www.npmjs.com/package/@aramisfa/openclaw-a2a-outbound)
[![inbound npm](https://img.shields.io/npm/v/%40aramisfa%2Fopenclaw-a2a-inbound?label=inbound%20npm)](https://www.npmjs.com/package/@aramisfa/openclaw-a2a-inbound)

Delegate work from OpenClaw to remote A2A agents with one plugin-first path: start with [`@aramisfa/openclaw-a2a-outbound`](./packages/openclaw-a2a-outbound/README.md).

If you want a believable first success quickly, this repository is primarily about the outbound `remote_agent` tool: discover a reachable peer, send work to it, and keep the returned `summary.continuation` so you can resume, watch, check status, or cancel later.

## Why This Exists

OpenClaw already gives you a local host runtime. These plugins add a practical A2A delegation path so that host can work with other agents.

- delegate work from OpenClaw to remote A2A agents
- track long-running tasks instead of losing them after one request
- resume later with persisted `summary.continuation`
- watch status or cancel when the remote side turns the exchange into a task

## Start With Outbound

Install [`@aramisfa/openclaw-a2a-outbound`](./packages/openclaw-a2a-outbound/README.md) first. It is the default adoption path in this repo and the only outbound A2A continuation surface here.

Use the package README for the full contract, action reference, continuation rules, and advanced examples:

- [`packages/openclaw-a2a-outbound/README.md`](./packages/openclaw-a2a-outbound/README.md)

## 5-Minute Quickstart

This quickstart is intentionally payload-centric and CLI-neutral for tool execution. The repo documents exact install commands, exact config shape, and exact `remote_agent` payloads, but it does not define one canonical OpenClaw command for invoking the tool.

Assume one local OpenClaw host with outbound installed and one reachable local OpenClaw peer exposing inbound. For a repo-owned example target, the e2e harness uses the alias `local`.

### 1. Install Outbound

```bash
openclaw plugins install @aramisfa/openclaw-a2a-outbound
```

### 2. Enable It In Your OpenClaw Plugin Config

Set `"enabled": true` under plugin id `openclaw-a2a-outbound` and add one reachable target. This minimal example keeps the same contract terms documented in the outbound package README:

```json
{
  "enabled": true,
  "defaults": {
    "timeoutMs": 120000,
    "cardPath": "/.well-known/agent-card.json",
    "preferredTransports": ["JSONRPC", "HTTP+JSON"],
    "serviceParameters": {}
  },
  "targets": [
    {
      "alias": "local",
      "baseUrl": "http://127.0.0.1:<port>",
      "description": "Local paired A2A peer",
      "default": true
    }
  ],
  "taskHandles": {
    "ttlMs": 86400000,
    "maxEntries": 1000
  },
  "policy": {
    "acceptedOutputModes": [],
    "normalizeBaseUrl": true,
    "enforceSupportedTransports": true,
    "allowTargetUrlOverride": false
  }
}
```

Replace `<port>` with the actual reachable base URL of your local inbound peer.

### 3. Discover Configured Targets

Call `remote_agent` with `list_targets` first:

```json
{ "action": "list_targets" }
```

You should see your configured alias and refreshed peer-card metadata. In the local paired demo path, the important success signal is that `target_alias: "local"` resolves and the peer card loads.

### 4. Send A First Request

Use the configured alias instead of a raw URL:

```json
{
  "action": "send",
  "target_alias": "local",
  "parts": [
    {
      "kind": "text",
      "text": "Summarize what you can help with in one short paragraph."
    }
  ]
}
```

Expected first success: the peer returns either a direct message result or a task-shaped result. If a task is created, persist `summary.continuation` exactly as returned. That continuation is the follow-up contract for later `send`, `watch`, `status`, and `cancel`.

For the full continuation model, task semantics, and follow-up examples, continue in:

- [`packages/openclaw-a2a-outbound/README.md`](./packages/openclaw-a2a-outbound/README.md)

## Add Inbound When You Need It

Add [`@aramisfa/openclaw-a2a-inbound`](./packages/openclaw-a2a-inbound/README.md) when you want your OpenClaw instance to be callable by other A2A peers.

The practical prerequisites are short:

- set `publicBaseUrl`
- make the gateway externally reachable with the networking setup that matches your environment

Use the inbound package README for the exact channel contract and networking details:

- [`packages/openclaw-a2a-inbound/README.md`](./packages/openclaw-a2a-inbound/README.md)

## Repository Layout

- workspace root: shared `pnpm` workspace tooling, TypeScript project configuration, and Changesets release management
- `packages/openclaw-a2a-outbound`: outbound A2A delegation plugin for OpenClaw
- `packages/openclaw-a2a-inbound`: inbound A2A channel plugin for OpenClaw
- `skills/`: standalone skills published separately from npm package releases

## Development

This repository uses a `pnpm` workspace.

From the repository root:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm clean
```

## Releases

Releases are managed with [Changesets](https://github.com/changesets/changesets).

Create version intent locally with:

```bash
pnpm changeset
pnpm version-packages
```

`pnpm version-packages` runs `changeset version` and then syncs any `openclaw.plugin.json` manifest version with its package version before the release PR is committed.

## License

See the root [`LICENSE`](./LICENSE).
