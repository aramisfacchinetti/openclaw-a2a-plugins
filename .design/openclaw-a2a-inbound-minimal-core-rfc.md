# RFC: Restore `openclaw-a2a-inbound` To A Committed Runtime

Status: Complete

Date: 2026-03-09

Last Updated: 2026-03-11

## Summary

This RFC describes the committed shape for `openclaw-a2a-inbound`.

The package restores:

- `message/stream`
- `tasks/resubscribe`
- public `taskStore` account config

while keeping one committed task runtime as the only source of truth for:

- `message/send`
- `message/stream`
- `tasks/get`
- `tasks/cancel`
- `tasks/resubscribe`

The implementation uses the official A2A SDK for transport, SSE framing, queues, event buses, and types. It does not use `DefaultRequestHandler` or `ResultManager` for task lifecycle semantics because their behavior does not match the committed runtime already implemented in this package.

## Decision

The package should stabilize on a committed contract with:

- JSON-RPC plus agent-card transport only
- one committed task runtime
- streaming enabled
- push notifications disabled
- public task-storage configuration
- latest-snapshot persistence only

Breaking changes remain acceptable because the repository is still greenfield and the project instructions explicitly allow structural iteration without backward-compatibility constraints.

## Implemented Public Contract

### Supported transport and methods

Publicly exposed:

- agent card endpoint
- JSON-RPC endpoint
- `message/send`
- `message/stream`
- `tasks/get`
- `tasks/cancel`
- `tasks/resubscribe`

Still not part of the contract:

- REST transport
- `/a2a/files`
- outbound file transport URLs
- push notifications

The push-notification config methods remain rejected with JSON-RPC `methodNotFound`:

- `tasks/pushNotificationConfig/set`
- `tasks/pushNotificationConfig/get`
- `tasks/pushNotificationConfig/list`
- `tasks/pushNotificationConfig/delete`

### Advertised agent-card capabilities

The current agent card advertises:

- `streaming = true`
- `pushNotifications = false`

### Content contract

Defaults remain:

- input: `["text/plain", "application/json"]`
- output: `["text/plain", "application/json"]`

Inbound requests accept only:

- A2A `text`
- A2A `data`

Inbound A2A `file` parts are rejected with `invalidParams`.

Serialized A2A messages, tasks, and events do not emit:

- `metadata.openclaw.*`
- vendor reply payload wrappers
- synthetic outbound file links

## Implemented Account Config

The public account contract now includes:

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
- `taskStore`
- `skills`

The parser still rejects:

- `restPath`
- `capabilities`
- `auth`

`taskStore` is restored and normalized as follows:

- missing `taskStore` becomes `{ kind: "memory" }`
- `taskStore.kind = "memory"` uses process-local storage only
- `taskStore.kind = "json-file"` requires a non-empty absolute `path`

## Runtime Model

### Single committed path

`A2AInboundRequestHandler` owns the task lifecycle for all task-bearing methods:

- `sendMessage`
- `sendMessageStream`
- `getTask`
- `cancelTask`
- `resubscribe`

`DefaultRequestHandler` is retained only as a thin delegate for:

- `getAgentCard`
- `getAuthenticatedExtendedAgentCard`

### Shared execution bootstrap

`sendMessage` and `sendMessageStream` share one execution bootstrap that performs:

- inbound message validation
- accepted-output-mode normalization
- request-mode registration
- request-context creation
- execution event bus creation
- execution queue creation
- executor dispatch with the existing fallback error publication behavior

### Response-mode behavior

The request-mode enum is now:

- `blocking`
- `non_blocking`
- `streaming`

Promotion rules are:

- `non_blocking` auto-promotes at startup
- `blocking` and `streaming` may still return direct canonical `Message` results if promotion never becomes necessary
- existing promotion triggers remain intact

### Streaming behavior

`message/stream` now streams committed output:

- direct runs that never promote emit exactly one canonical final `Message`
- promoted runs emit:
  - the committed initial `Task` snapshot
  - committed `status-update` events
  - committed `artifact-update` events
  - the committed final status update

No separate stream-only task representation exists.

### Follow-up behavior

Follow-up requests keep the existing committed path:

- load the committed task
- validate `contextId` binding
- require a stored binding
- persist the incoming follow-up message before executor dispatch

## Storage Model

`A2ATaskRuntimeStore` remains the runtime wrapper responsible for:

- per-task serialization queues
- pending bindings
- in-process live subscribers

Durable storage is split behind two backends only:

- memory backend
- json-file backend

Each task persists one record containing:

- the latest committed task snapshot
- the stored binding

The json-file backend uses:

- `<root>/<encodeTaskStorageId(taskId)>.json` for each task record
- `<root>/.writer.lock` for startup-time exclusive single-writer locking
- same-directory temp-file-and-rename writes for every save

## Live Tail, Resubscribe, And Cancel

Snapshot loading and live-tail subscription are separate operations.

`tasks/resubscribe` semantics:

- load the latest committed task first
- emit that snapshot immediately
- attach a live tail only if:
  - the task is still active
  - `liveExecutions.has(taskId)` is true in the current process
- terminal, quiescent, and restart-orphaned active tasks emit the snapshot and close
- live tails stream committed `status-update` and `artifact-update` events that arrive after subscription

`tasks/cancel` semantics:

- terminal tasks pass through unchanged
- quiescent tasks are canceled immediately through the committed runtime
- active tasks only cancel live in-process executions
- restart-orphaned active tasks return the existing unsupported-operation error instead of pretending a live tail exists

## Not Implemented

The runtime does not implement:

- durable committed-journal replay
- backlog replay
- lease heartbeats
- orphan recovery
- hidden replay toggles
- a second stream-only task model

## Acceptance Criteria

The current codebase satisfies the committed criteria:

- `message/stream` and `tasks/resubscribe` are restored through the SDK JSON-RPC/SSE transport
- push notifications remain disabled and rejected
- `taskStore` is restored as public config with memory/json-file backends
- missing `taskStore` normalizes to memory
- invalid `json-file.path` values fail during config parsing
- the runtime keeps one committed task path
- promoted streaming runs persist and stream committed state
- direct streaming runs emit one canonical `Message` without materializing a task
- restart-orphaned active tasks remain readable and snapshot-resubscribable but not durably live
