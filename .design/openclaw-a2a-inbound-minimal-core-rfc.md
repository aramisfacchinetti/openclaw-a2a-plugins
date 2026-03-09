# RFC: Reduce `openclaw-a2a-inbound` To A Minimal Core A2A Surface

Status: In Progress

Date: 2026-03-09

Last Updated: 2026-03-09

## Summary

This RFC still defines the direction for reducing `packages/openclaw-a2a-inbound` to a smaller minimal-core A2A package, but the repository is only partially aligned with that end state.

The current codebase has completed the public-contract freeze:

- the public channel account contract is reduced to the minimal-core fields
- removed config keys now fail fast during parsing
- default input/output modes are narrowed to `text/plain` and `application/json`
- REST transport is no longer part of the public contract or registered plugin routes
- advertised agent-card defaults are fixed to `streaming = false` and `pushNotifications = false`

The current codebase has not yet completed the deeper runtime simplification:

- durable task-store code still exists internally
- OpenClaw vendor metadata is still emitted
- push notification config methods have not been removed from the request handler surface

This document now records both:

1. the minimal-core contract that is already frozen
2. the remaining gaps before the full RFC target is actually implemented

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
- File-only outbound replies now fail with A2A `-32005` instead of returning dead file links.
- Production startup defaults to in-memory task storage because task-store config was removed from the public account contract.
- Production startup does not enable streaming methods because the plugin path does not pass the internal streaming switch.

### Still present in the current codebase

- Durable task-store code still exists in `src/task-store.ts`.
- Internal/test-only server options can still enable:
  - durable `json-file` task storage
  - streaming request-handler methods
- OpenClaw metadata extensions such as `metadata.openclaw.*` still exist in tasks and events.
- Push notification config methods are still delegated through the underlying SDK request handler.

### Practical consequence

The package is currently in a mixed state:

- the public config and advertised contract are minimal-core
- the internal runtime is still broader than the public contract

That mixed state is intentional for now. Phase 1 prioritized freezing the external contract before deleting the deeper runtime machinery.

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

### Default content modes

Current defaults are:

- `text/plain`
- `application/json`

`application/octet-stream` is no longer advertised by default.

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

## Gaps Between Current State And Final RFC Target

The final target described by this RFC is still not reached. The main remaining gaps are:

### Transport/runtime extras still present

- complete the remaining task-runtime replacement work after file transport removal

### Task-runtime simplification still pending

- replace the durable-capable task-store implementation with a smaller in-memory-only runtime
- remove durable replay, lease, orphan-recovery, and json-file storage paths from the package runtime

### Protocol-adjacent cleanup still pending

- remove or hard-disable streaming request paths without internal backdoors
- remove replay/resubscribe behavior from the runtime
- remove push notification config methods
- remove OpenClaw metadata extensions from A2A responses

### Content handling cleanup still pending

- decide whether inbound file inputs should remain accepted in the final minimal-core package

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

Status: Not started

Still targeted:

- replace the current durable-capable task store with a smaller in-memory-only runtime

### Phase 4: Remove optional protocol methods and metadata

Status: Not started

Still targeted:

- remove streaming paths
- remove replay/resubscribe
- remove push notification config methods
- remove OpenClaw metadata extensions

### Phase 5: Reduce content handling

Status: Not started

Still targeted:

- decide and enforce the final file-input/file-output policy for minimal core

### Phase 6: Rewrite tests around the fully reduced runtime

Status: Partial

Completed work:

- config normalization tests now enforce the reduced contract
- schema tests now assert the removed fields are absent
- route/plugin tests now reflect the two-route minimal surface with no describe RPC
- default-mode tests now reflect text/JSON defaults

Still pending:

- remove runtime tests that only exist for features the final RFC intends to delete

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
- default modes no longer include `application/octet-stream`
- outbound file-only replies fail instead of exposing dead links

### Criteria not yet satisfied

- no durable/runtime replay internals
- no streaming/replay method surface
- no OpenClaw metadata extensions in A2A responses

## Follow-up Work

The next updates to this RFC should happen when one of the following lands:

- durable task-store internals are deleted
- streaming/replay/push config methods are removed
- OpenClaw metadata extensions are removed from task/event payloads

At that point this document can move from "mixed current state plus target direction" to a cleaner final-state RFC or an implementation-complete design note.
