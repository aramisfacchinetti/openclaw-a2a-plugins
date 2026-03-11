# RFC: Durable Committed Journal Persistence For `openclaw-a2a-inbound`

Status: Complete

Date: 2026-03-11

## Summary

Phase 2 extends the phase 1 single-runtime model by persisting a durable committed journal beside the latest committed task snapshot inside the same per-task record.

The public A2A surface stays unchanged:

- request and response payloads stay the same
- `taskStore` config stays `{ kind: "memory" } | { kind: "json-file"; path: string }`
- `tasks/resubscribe` stays `latest snapshot + optional live committed tail`

This phase does not expose stored backlog replay yet.

## Decision

The runtime should preserve enough committed history for a future replay phase without shipping a non-monotonic public contract now.

The committed journal is therefore internal-only in phase 2. Persisted `sequence` values are storage-only and must not appear in:

- A2A payload metadata
- A2A request params
- agent-card capabilities

## Persisted Record Shape

Schema v2 extends the existing per-task record in place:

```json
{
  "schemaVersion": 2,
  "task": { "...": "latest committed Task snapshot" },
  "binding": { "...": "optional OpenClaw binding" },
  "currentSequence": 3,
  "journal": [
    {
      "sequence": 1,
      "event": { "kind": "status-update", "...": "committed event payload" }
    },
    {
      "sequence": 2,
      "event": { "kind": "artifact-update", "...": "committed event payload" }
    }
  ]
}
```

`StoredCommittedJournalRecord` is:

- `sequence`
- `event`

Only committed `status-update` and `artifact-update` events are journaled. The initial committed `Task` snapshot is not journaled.

## Journal Persistence Semantics

On every committed journal event, the runtime must:

1. assign the next per-task `sequence`
2. append the journal record
3. fold the event into the latest committed `Task` snapshot
4. atomically persist the updated record
5. notify in-process subscribers

Snapshot-oriented writes such as `save`, `writeBinding`, and `persistIncomingMessage` must preserve the existing `journal` and `currentSequence`.

## Backends And Upgrade

Both backends store the same schema v2 shape:

- memory backend: process-local only, lost on restart
- json-file backend: one file per task, temp-file-and-rename atomic writes, single-writer lock per root

Existing schema v1 json-file records are supported by lazy upgrade:

- load schema v1 records in memory as `{ currentSequence: 0, journal: [] }`
- do not synthesize journal history from old snapshots or message history
- persist schema v2 on the next write only

The upgrade is one-way.

## Resubscribe Preparation

`prepareResubscribe(taskId)` runs on the same per-task queue used for commits and returns:

- `snapshot`
- `subscription?`

This keeps snapshot loading and live-tail attachment from racing with committed event persistence.

`tasks/resubscribe` continues to:

- emit the latest committed snapshot first
- attach a live committed tail only when the task is still active and owned by a live execution in the current process
- close after the snapshot for terminal tasks, quiescent tasks, and restart-orphaned active tasks

This phase does not emit stored journal backlog from `tasks/resubscribe`.

## Deferred Replay

Full no-cursor replay remains deferred because the current metadata-free public contract cannot distinguish replayed events from live events.

Emitting:

- latest snapshot first
- then unmarked historical backlog
- then live tail

would not be a monotonic state stream once the latest snapshot already folds earlier committed status and artifact updates.

Any future replay phase must introduce a monotonic public replay contract before exposing stored backlog.
