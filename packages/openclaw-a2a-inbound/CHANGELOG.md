# @aramisfa/openclaw-a2a-inbound

## 3.0.0

### Major Changes

- f177507: Require OpenClaw 2026.9.6 and align both plugins with its public SDK entry points and Node.js runtime floor.

### Patch Changes

- 42462d1: Harden inbound A2A isolation by requiring exact session-key matches for agent events, and accept supported A2A v1-style member-discriminated text/data Parts while continuing to reject inbound file Parts.

## 2.0.2

### Patch Changes

- 7f2faba: Add `channelConfigs.a2a` metadata to the inbound plugin manifest so OpenClaw can expose the channel configuration schema and setup UI before runtime loading.

## 2.0.1

### Patch Changes

- d03a16f: Ship outbound-first onboarding with the `openclaw a2a` CLI, a packaged local demo peer, diagnostics, quickstart docs, examples, and inbound positioning as an advanced follow-on package.

## 2.0.0

### Major Changes

- bcc1a6a: Raise the OpenClaw peer/runtime requirement to `2026.4.15` and upgrade
  `@a2a-js/sdk` to `^0.3.13`.

  This release also ships the current A2A plugin runtime and contract updates,
  including the newer inbound task-store, queued-reply, and resubscribe behavior,
  plus the newer outbound continuation, registration-mode, and target/result-shape
  behavior.

## 1.0.2

### Patch Changes

- 7d9e318: Fix `tasks/resubscribe` live-tail planning so subscriptions decide eligibility before the
  initial snapshot is yielded and do not drop already-buffered committed final events.

  Read `PLUGIN_VERSION` from `package.json` at runtime instead of a hardcoded constant so the
  exposed plugin version stays aligned with the published package.

  Document the networking prerequisites around `publicBaseUrl` and externally reachable gateway
  binding so inbound deployments fail less opaquely.

## 1.0.0

### Major Changes

- Initial release of the inbound A2A channel plugin.
