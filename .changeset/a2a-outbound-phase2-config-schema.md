---
'@aramisfa/openclaw-a2a-outbound': minor
---

Align `@aramisfa/openclaw-a2a-outbound` with SDK-native plugin entry/config handling.

- Added `src/plugin-config.ts` with `parseA2AOutboundPluginConfig` and `A2AOutboundPluginConfigSchema`.
- Moved config normalization out of `service.ts`; `A2AOutboundServiceOptions.config` is now typed as `A2AOutboundPluginConfig | undefined`.
- Updated plugin entry to expose `configSchema` and parse `pluginConfig` at registration.
- Removed legacy `registerPlugin` named export and `A2AOutboundPluginDefinition` export.
