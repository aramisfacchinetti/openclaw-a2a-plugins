# A2A Plugins for OpenClaw

[![license](https://img.shields.io/github/license/aramisfacchinetti/openclaw-a2a-plugins)](https://github.com/aramisfacchinetti/openclaw-a2a-plugins/blob/master/LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.4.15-0A7B83)](https://github.com/aramisfacchinetti/openclaw-a2a-plugins)
[![outbound npm](https://img.shields.io/npm/v/%40aramisfa%2Fopenclaw-a2a-outbound?label=outbound%20npm)](https://www.npmjs.com/package/@aramisfa/openclaw-a2a-outbound)
[![inbound npm](https://img.shields.io/npm/v/%40aramisfa%2Fopenclaw-a2a-inbound?label=inbound%20npm)](https://www.npmjs.com/package/@aramisfa/openclaw-a2a-inbound)

Make OpenClaw delegate work to remote A2A agents in about 5 minutes.

Start with the outbound plugin. It gives OpenClaw one durable delegation tool, `remote_agent`, plus a local demo that proves outbound calls, task watching, and continuation replay without any external setup. Add inbound later only when you want your OpenClaw instance to receive A2A calls from other peers.

## Why This Exists

OpenClaw is good at orchestrating tools you already trust. This repo adds a clean way to send work to other A2A agents without inventing a second continuation format or wiring ad hoc webhooks between systems.

Use it when you want OpenClaw to:

- delegate a task to a specialist remote agent
- watch or cancel long-running delegated work
- persist follow-up state and resume later with the exact returned continuation
- pair two OpenClaw instances over A2A once you are ready for inbound networking

## First Success

```bash
openclaw plugins install @aramisfa/openclaw-a2a-outbound
openclaw a2a demo run
```

`openclaw a2a demo run` starts a deterministic local A2A peer, configures a temporary `local-demo` outbound target in memory, runs `list_targets`, sends a task-bearing request, watches it, checks status, prints `summary.continuation`, and replays one follow-up using that exact continuation.

If that command succeeds, you have already verified the core contract:

- OpenClaw can call an A2A agent through `remote_agent`
- task-bearing requests can be watched and resumed
- follow-up state is returned as `summary.continuation`

## Who This Is For

- OpenClaw users who want cross-agent delegation without standing up custom glue code
- A2A developers who want a concrete OpenClaw integration instead of another protocol demo
- self-hosters who want a local-first proof before exposing any inbound endpoint

## What You Get

- `@aramisfa/openclaw-a2a-outbound`: the hero package. It registers `remote_agent` plus the `openclaw a2a` onboarding CLI.
- `openclaw a2a demo run`: zero-config local proof that outbound delegation and continuation replay work.
- `openclaw a2a demo serve`: long-lived local demo peer for raw `remote_agent` payload testing.
- `openclaw a2a doctor`: read-only diagnostics for installed outbound targets.
- `@aramisfa/openclaw-a2a-inbound`: advanced inbound bridge for exposing an OpenClaw agent as an A2A endpoint.

## Quickstart Paths

Use the docs in this order:

1. [5-minute quickstart](./docs/quickstart.md) for `demo run` and raw `remote_agent` payloads via `demo serve`.
2. [One-shot delegation](./docs/one-shot-delegation.md) when the remote agent can answer directly.
3. [Durable task plus continuation](./docs/durable-task-continuation.md) when you need status, watch, cancel, or later follow-up.
4. [Pair two OpenClaw instances](./docs/pair-openclaw-instances.md) when you are ready to add inbound networking.

## Examples And Demos

- [Minimal outbound consumer](./examples/outbound-consumer/README.md): version-pinned config for one local demo target.
- [Raw continuation payloads](./examples/raw-continuation/README.md): copy-pasteable `remote_agent` requests for continuation replay.
- [Terminal recording asset](./docs/assets/openclaw-a2a-demo-run.cast): short `demo run` transcript for docs and directory listings.
- [Continuation round trip snippet](./docs/assets/continuation-round-trip.json): compact machine-readable continuation example.

## Outbound Contract

The outbound package exposes one tool contract: `remote_agent`.

Supported actions:

- `list_targets`
- `send`
- `watch`
- `status`
- `cancel`

Every task-aware follow-up should persist and replay `summary.continuation` verbatim. Do not invent a second continuation format and do not route outbound follow-ups through the inbound channel.

See [packages/openclaw-a2a-outbound/README.md](./packages/openclaw-a2a-outbound/README.md) for the full tool schema and continuation rules.

## Add Inbound Later

Install [`@aramisfa/openclaw-a2a-inbound`](./packages/openclaw-a2a-inbound/README.md) only when another A2A peer needs to call your OpenClaw instance.

Inbound requires a real reachable gateway URL and explicit networking decisions. It is not part of the first-success path.

## Repository Layout

- `packages/openclaw-a2a-outbound`: outbound A2A delegation plugin and local onboarding CLI.
- `packages/openclaw-a2a-inbound`: advanced inbound A2A channel plugin.
- `docs/`: quickstarts, scenarios, sandbox policy, and public demo assets.
- `examples/`: copy-pasteable outbound examples.
- `skills/`: standalone skills published manually, separately from npm releases.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm clean
```

## Releases

Releases are managed with [Changesets](https://github.com/changesets/changesets). Real npm publishes and GitHub Releases come from the repository workflows, not direct local publishes.

## License

See [LICENSE](./LICENSE).
