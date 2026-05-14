# @aramisfa/openclaw-a2a-inbound

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
