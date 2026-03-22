# @aramisfa/openclaw-a2a-inbound

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
