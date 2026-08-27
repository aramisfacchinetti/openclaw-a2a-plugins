---
"@aramisfa/openclaw-a2a-inbound": patch
---

Add a channelConfigs descriptor for the `a2a` channel to openclaw.plugin.json

The manifest declared `channels: ["a2a"]` but shipped no matching
`channelConfigs.a2a` entry. OpenClaw warns about every non-bundled load in this
state ("channel plugin manifest declares a2a without channelConfigs metadata"),
because manifest-level descriptors are what drive config-schema and setup
surfaces before runtime loads — and those surfaces currently fall back with no
account schema at all.

This wires the canonical descriptor (`A2A_INBOUND_CHANNEL_CONFIG_SCHEMA`,
already exported from src/config.ts) into the manifest, and adds a lockstep
test so the embedded JSON cannot drift from the TypeScript source of truth.
