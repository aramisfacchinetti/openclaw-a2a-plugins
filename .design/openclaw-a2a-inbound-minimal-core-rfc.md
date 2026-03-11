# RFC: Reduce `openclaw-a2a-inbound` To A Minimal Core A2A Surface

Status: In Progress (Phases 1-5 complete; Phase 6 partial)

Date: 2026-03-09

Last Updated: 2026-03-11

## Summary

This RFC now reflects the repository after the Phase 5 content-handling cleanup. The public HTTP/plugin surface, the effective JSON-RPC method surface, and serialized A2A payloads are aligned with the intended minimal-core contract. The remaining work is Phase 6 cleanup around the final reduced runtime and test/document shape.

The current codebase has completed the public contract and transport cleanup:

- the public channel account contract is reduced to the minimal-core fields
- removed config keys now fail fast during parsing
- default input/output modes are narrowed to `text/plain` and `application/json`
- REST transport is no longer part of the public contract or registered plugin routes
- `/a2a/files` is removed
- `openclaw-a2a-inbound.describe` is removed
- outbound file parts are no longer exposed through same-origin transport URLs
- advertised agent-card defaults are fixed to `streaming = false` and `pushNotifications = false`
- inbound A2A file parts are rejected at the request boundary with `invalidParams`
- inbound file fetch/staging/media-context plumbing is removed

The current codebase has completed the runtime and protocol cleanup:

- task state is intentionally in-memory and process-local only
- the server always constructs that in-memory runtime internally
- removed optional JSON-RPC methods are rejected at the protocol boundary
- replay/resubscribe and backlog-only runtime paths are deleted
- OpenClaw metadata extensions are no longer emitted in serialized A2A payloads
- vendor reply payload decoration is removed
- push notification config methods are no longer part of the effective handler surface

This document now records the minimal-core contract that is implemented in the current codebase.

## Decision

The package should converge on a smaller A2A surface whose main job is:

- serve a valid agent card
- serve A2A JSON-RPC
- implement `message/send`
- implement `tasks/get`
- implement `tasks/cancel`

Breaking changes are acceptable. The repo is still pre-1.0 and the project instructions explicitly do not require backward compatibility while iterating on structure.

## Current State Snapshot

### Implemented in the current codebase

- Public account config is reduced to:
  - `enabled`
  - `label`
  - `description`
  - `publicBaseUrl`
  - `defaultAgentId`
  - `sessionStore`
  - `protocolVersion`
  - `agentCardPath`
  - `jsonRpcPath`
  - `maxBodyBytes`
  - `defaultInputModes`
  - `defaultOutputModes`
  - `skills`
- Parser rejects:
  - `restPath`
  - `capabilities`
  - `auth`
  - `taskStore`
- Account readiness now depends only on `publicBaseUrl`.
- Public docs and examples are rewritten around the reduced contract.
- Plugin route registration no longer includes REST.
- Agent cards no longer advertise REST interfaces.
- Agent cards now advertise:
  - `streaming = false`
  - `pushNotifications = false`
  - no `stateTransitionHistory`
- Default modes are now:
  - `["text/plain", "application/json"]` for input
  - `["text/plain", "application/json"]` for output
- The plugin no longer registers `/a2a/files`.
- The plugin no longer registers `openclaw-a2a-inbound.describe`.
- Outbound reply file parts are filtered instead of being rewritten to same-origin transport URLs.
- Mixed outbound replies preserve any representable text after filtering.
- File-only outbound replies now fail with A2A `-32005` instead of returning dead file links.
- Production startup defaults to in-memory task storage because task-store config was removed from the public account contract.
- The task runtime is now always created through a zero-argument in-memory factory.
- The effective JSON-RPC surface only handles:
  - `message/send`
  - `tasks/get`
  - `tasks/cancel`
- Raw JSON-RPC calls for removed optional methods fail at the HTTP JSON-RPC boundary:
  - `message/stream`
  - `tasks/resubscribe`
  - `tasks/pushNotificationConfig/set`
  - `tasks/pushNotificationConfig/get`
  - `tasks/pushNotificationConfig/list`
  - `tasks/pushNotificationConfig/delete`
- A2A tasks, events, messages, reply parts, and artifacts no longer emit `metadata.openclaw.*`.
- Vendor reply metadata, vendor `data` parts, and the `reply-v1` schema marker are removed.
- Vendor-only replies now fail with A2A `-32005`.
- Inbound requests now accept only A2A `text` and `data` parts.
- Any inbound A2A `file` part now fails at request preparation with A2A `invalidParams`.
- Inbound requests no longer decode base64 file bytes, parse `file.uri`, fetch remote media, stage local media, or populate `MediaPath`/`MediaUrl`/`MediaType` fields in the OpenClaw inbound context.
- `defaultInputModes` is schema- and parser-validated to `text/plain` and `application/json` only.

### Phase 3 runtime note

- Task state is intentionally non-durable.
- Tasks and bindings now exist only for the lifetime of the current server process.
- Each materialized task is held only as its latest snapshot plus the minimum live subscription state needed for correct cancellation and terminal-state observation.
- Restarting the server drops prior task state and subsequent reads return `task not found`.

### Practical consequence

The package is now effectively at the intended minimal-core protocol surface:

- the public config and public transport/output contract are minimal-core
- the runtime is process-local and reduced to the currently supported method set
- removed optional methods are rejected instead of being silently reachable through internal switches
- serialized A2A payloads no longer carry OpenClaw-specific metadata or vendor reply payloads

The minimal-core content contract is now fully enforced: inbound requests accept only text and structured data, and outbound responses surface only representable text/data.

## Public Contract As Of Now

### Transport

Publicly documented and supported:

- agent card endpoint
- JSON-RPC endpoint

No longer part of the public contract:

- REST transport
- REST config
- auth config
- task-store config
- outbound file-delivery HTTP routes
- outbound file transport URLs

### Advertised capabilities

The current agent card advertises:

- `streaming = false`
- `pushNotifications = false`

The current agent card does not advertise:

- REST
- `stateTransitionHistory`

### Documented supported methods

The package documentation currently claims support for:

- `message/send`
- `tasks/get`
- `tasks/cancel`

That is the minimal-core method set and should remain the stable public contract.

Implementation note:

- removed optional methods are rejected at the JSON-RPC boundary instead of being routed internally
- the remaining effective method surface is limited to `message/send`, `tasks/get`, and `tasks/cancel`

### Default content modes

Current defaults are:

- `text/plain`
- `application/json`

`application/octet-stream` is no longer advertised by default.

Inbound content-policy note:

- `defaultInputModes` only accepts `text/plain` and `application/json`
- inbound A2A requests accept only `text` and `data` parts
- any inbound `file` part is rejected with A2A `invalidParams`

Important current implementation note:

- clients may still negotiate `application/octet-stream` as an accepted output mode
- the server will never emit a reachable outbound file URL or A2A `file` part
- file-only, media-only, and vendor-only replies that leave nothing representable now fail with A2A `-32005`

### Public config contract

Current public config keeps:

- `accounts`
- `enabled`
- `label`
- `description`
- `publicBaseUrl`
- `defaultAgentId`
- `sessionStore`
- `protocolVersion`
- `agentCardPath`
- `jsonRpcPath`
- `maxBodyBytes`
- `defaultInputModes`
- `defaultOutputModes`
- `skills`

Current public config rejects:

- `restPath`
- `capabilities`
- `auth`
- `taskStore`

## Updated Phasing

### Phase 1: Freeze the external contract

Status: Complete

Completed work:

- reduced public account contract
- removed legacy fields from schema and docs
- added forbidden-key parser validation
- narrowed default modes to text/JSON
- simplified readiness checks to `publicBaseUrl`
- removed REST from public exposure and agent-card advertising

### Phase 2: Remove remaining public/runtime mismatches

Status: Complete

Completed work:

- removed REST route registration
- removed plugin-host auth gating
- removed `/a2a/files`
- removed diagnostic gateway RPC registration
- removed outbound file URL materialization and registration plumbing
- changed outbound file-only replies to fail with A2A `-32005`

### Phase 3: Replace the task runtime

Status: Complete

Completed work:

- replaced the durable-capable task store with a process-local in-memory runtime
- removed `json-file` storage, lease heartbeats, orphan recovery, and startup sweep logic
- removed the internal `taskStoreConfig` server hook
- updated tests to assert process-lifetime task persistence for the reduced in-memory runtime
- deleted durable-runtime coverage that only validated removed behavior
- added restart-loss coverage so prior tasks now fail with `task not found` after server restart

### Phase 4: Remove optional protocol methods and metadata

Status: Complete

Completed work:

- removed the internal streaming-method test backdoor and all remaining streaming/replay paths
- removed push notification config methods from the effective JSON-RPC surface
- changed raw JSON-RPC calls for removed optional methods to fail at the protocol boundary
- removed `metadata.openclaw.*` emission from tasks, events, messages, reply parts, and artifacts
- removed vendor reply payload decoration and vendor-only reply success paths

### Phase 5: Finalize content handling

Status: Complete

Completed work:

- removed outbound file transport
- changed file-only outbound replies to fail instead of exposing dead links
- locked the inbound contract to A2A `text` and `data` parts only
- rejected inbound A2A `file` parts with A2A `invalidParams` before task creation or executor dispatch
- removed inbound file normalization, remote fetch/staging, and media-context forwarding
- restricted `defaultInputModes` to `text/plain` and `application/json` at schema and parser level

### Phase 6: Rewrite tests around the fully reduced runtime

Status: Partial

Completed work:

- config normalization tests now enforce the reduced contract
- schema tests now assert the removed fields are absent
- route/plugin tests now reflect the two-route minimal surface with no describe RPC
- default-mode tests now reflect text/JSON defaults
- file-only and mixed-content regressions now assert no outbound `file` parts or generated `/files` URLs remain
- durable-runtime tests were removed
- lifecycle tests now cover metadata-free blocking/non-blocking flows, raw JSON-RPC rejection for removed optional methods, quiescent/live cancellation, and restart-loss for the in-memory runtime

## Acceptance Criteria

### Criteria already satisfied

- public config surface for REST/auth/task persistence is gone
- removed config keys fail fast during parse
- public docs describe the reduced contract
- no REST route is registered
- no file route
- no plugin diagnostic RPC
- agent cards advertise JSON-RPC only
- agent cards advertise `streaming = false`
- agent cards advertise `pushNotifications = false`
- no durable task-store internals remain
- task state is intentionally process-local and disappears on restart
- default modes no longer include `application/octet-stream`
- outbound file-only replies fail instead of exposing dead links
- no outbound task, message, or artifact contains a generated `/files` URL or A2A `file` part
- no streaming/replay method surface
- no push notification config method surface
- no OpenClaw metadata extensions in A2A responses
- final inbound file-input policy is enforced

## Follow-up Work

The next updates to this RFC should happen when one of the following lands:

- the remaining Phase 6 test/document cleanup is finished

At that point this document can move from an in-progress RFC to a cleaner final-state RFC or an implementation-complete design note.
