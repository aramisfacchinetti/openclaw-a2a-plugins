# @aramisfa/openclaw-a2a-outbound

## 3.0.0

### Major Changes

- Make `summary.continuation` the canonical persisted follow-up contract by adding
  `summary.continuation.target` and accepting the same nested `continuation` subtree as the
  preferred machine-readable input for `send`, `watch`, `status`, and `cancel`.

  Treat `summary.continuation.task` as the only machine-readable task lifecycle authority and keep
  conversation continuity send-only; `watch`, `status`, and `cancel` now require task continuity
  instead of inferring lifecycle follow-up from conversation state or descriptive top-level fields.

  Fall back from expired or unknown nested task handles to the persisted durable target plus
  `task_id`, preserve conversation context in that persisted continuation, and return the full
  continuation recovery contract in expired-handle errors.

## 2.0.0

### Major Changes

- 8627a84: Replace the flat `remote_agent` summary task fields with nested `summary.continuation.task` and `summary.continuation.conversation` objects so task lifecycle and conversation continuity are handled separately.

### Patch Changes

- dc7ba6e: Align the bundled remote-agent skill gate with both outbound enable flags and document the optional a2a-delegation-setup helper.

## 1.0.0

### Major Changes

- d672f50: Migrate `@aramisfa/openclaw-a2a-outbound` to the official OpenClaw Plugin SDK with a latest-SDK-only breaking contract:

  - Collapse the outbound tool family into a single `remote_agent` tool with `list_targets`, `send`, `watch`, `status`, and `cancel` actions.
  - Replace nested protocol-shaped requests with flat `remote_agent` inputs.
  - Normalize tool outputs to `{ ok, operation, action, summary, raw }` on success and `{ ok, operation, action, error }` on failure.
  - Redesign plugin config to nested `defaults` + `policy` keys.
  - Remove runtime compatibility shims and require official `OpenClawPluginApi` shape.
  - Raise Node engine baseline to `>=22.12.0`.
  - Pin `openclaw` runtime dependency to `2026.3.2` and add matching peer dependency.

### Minor Changes

- d672f50: Replace manual tool input validators with Ajv strict-mode compiled schemas in `@aramisfa/openclaw-a2a-outbound`.

  - Added `ajv` and `ajv-formats` as direct dependencies.
  - Introduced `ajv-validator.ts` with strict-mode Ajv factory and error helper.
  - Replaced hand-written assertion/normalization functions in `schemas.ts` with Ajv-compiled validators.
  - Added `format: "uri"` and `pattern: "^https?://"` constraints to `target.baseUrl` schema.
  - Validation error `details` now carries `{ source: "ajv", tool, errors }` with native Ajv error objects instead of the previous `path`/`hint`/`expected`/`receivedType` shape.

- d672f50: Align `@aramisfa/openclaw-a2a-outbound` with SDK-native plugin entry/config handling.

  - Added `src/plugin-config.ts` with `parseA2AOutboundPluginConfig` and `A2AOutboundPluginConfigSchema`.
  - Moved config normalization out of `service.ts`; `A2AOutboundServiceOptions.config` is now typed as `A2AOutboundPluginConfig | undefined`.
  - Updated plugin entry to expose `configSchema` and parse `pluginConfig` at registration.
  - Removed legacy `registerPlugin` named export and `A2AOutboundPluginDefinition` export.

- d672f50: Harden delegate payload typing and runtime validation in `@aramisfa/openclaw-a2a-outbound`.

  - Switched delegate request typing to SDK-native `Message` and `MessageSendParams["metadata"]`.
  - Added strict runtime validation for `request.message` and part variants (`text`, `file`, `data`) with deterministic validation paths.
  - Removed unsafe delegate message cast in service flow and aligned delegate/status/cancel parameter typing with SDK request types.
  - Typed success envelope `raw` payloads by operation (`SendMessageResult`/`Task`) without changing envelope keys.
  - Tightened delegate tool JSON schema to explicit message and part structures.
  - Malformed delegate message objects that may have been accepted before are now rejected with `VALIDATION_ERROR`.
