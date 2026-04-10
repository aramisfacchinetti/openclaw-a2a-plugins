---
name: remote-agent
description: Delegate work to external A2A agents using the remote_agent tool.
metadata: {"openclaw": {"requires": {"config": ["plugins.entries.openclaw-a2a-outbound.enabled", "plugins.entries.openclaw-a2a-outbound.config.enabled"]}}}
---

# Remote Agent Delegation

If the plugin is not installed or configured yet, use the `a2a-delegation-setup` skill first.

Use the `remote_agent` tool to delegate work to external A2A-compatible agents and manage delegated tasks. `send` is the only action to start a new remote turn or continue an existing one.

## When to delegate

Delegate when:

- The task requires capabilities you do not have (e.g. code execution, web search, domain-specific APIs)
- The user explicitly asks to send work to an external agent
- A configured target agent is better suited for the request

Do not delegate when you can handle the request directly.

## Tool

The `remote_agent` tool exposes five actions: `list_targets`, `send`, `watch`, `status`, `cancel`.

## Choosing a target

Call `list_targets` first to discover available agents. Prefer `target_alias` over `target_url` — aliases are stable names configured by the user. If a default target is configured, you can omit `target_alias` from `send`.

## Actions

### list_targets

Discover configured targets.

```json
{ "action": "list_targets" }
```

### send

Send a request to a remote agent. Use it for:

- a brand-new remote task
- a follow-up turn on an existing remote task
- a related new task that references prior work
- a new task inside an existing remote conversation

```json
{
  "action": "send",
  "target_alias": "my-agent",
  "parts": [
    {
      "kind": "text",
      "text": "Summarize the latest quarterly report."
    }
  ],
  "follow_updates": true
}
```

- `parts` (required): non-empty array of `text`, `file`, or `data` parts.
- `target_alias`: configured target name. Omit when a default target exists.
- `continuation`: canonical persisted follow-up contract from `summary.continuation`. Round-trip this subtree verbatim for `send`, `watch`, `status`, and `cancel`.
- `task_handle`: manual compatibility input for follow-up actions when you are not replaying a persisted `continuation`.
- `task_id`: manual compatibility continuation id for `send`; for follow-up actions it identifies the remote task only when no `task_handle` is available inside a persisted `continuation`. `task_id` continues an existing task.
- `context_id`: manual compatibility conversation continuation id for `send`. Use it with `task_id`, or by itself to start a new task in the same conversation, only when you are not replaying a persisted `continuation`.
- `reference_task_ids`: optional related task ids for `send`. `reference_task_ids` references prior tasks without continuing them.
- `task_requirement`: optional durability contract. `task_requirement="required"` forces explicit task creation or fails fast.
- `follow_updates`: when `true`, streams updates and returns the full event log. `follow_updates=true` means “stream the initial send”; it does not guarantee task creation unless `task_requirement="required"`.
- `blocking`: only for non-stream `send`; do not combine it with `follow_updates=true`.

Preferred continuation forms:

```json
{ "action": "send", "continuation": { "target": { "target_url": "https://my-agent.example/", "card_path": "/.well-known/agent-card.json", "preferred_transports": ["JSONRPC", "HTTP+JSON"], "target_alias": "my-agent" }, "task": { "task_handle": "rah_abc123", "task_id": "task-123" } }, "parts": [{ "kind": "text", "text": "Approved. Continue." }] }
```

```json
{ "action": "send", "continuation": { "target": { "target_url": "https://my-agent.example/", "card_path": "/.well-known/agent-card.json", "preferred_transports": ["JSONRPC", "HTTP+JSON"], "target_alias": "my-agent" }, "task": { "task_id": "task-123" } }, "parts": [{ "kind": "text", "text": "Continue the task." }] }
```

```json
{ "action": "send", "continuation": { "target": { "target_url": "https://my-agent.example/", "card_path": "/.well-known/agent-card.json", "preferred_transports": ["JSONRPC", "HTTP+JSON"], "target_alias": "my-agent" }, "conversation": { "context_id": "ctx-123", "can_send": true } }, "parts": [{ "kind": "text", "text": "Start a new task in the same conversation." }] }
```

Manual compatibility only:

```json
{ "action": "send", "target_alias": "my-agent", "context_id": "ctx-123", "reference_task_ids": ["task-1", "task-2"], "parts": [{ "kind": "text", "text": "Start related work without continuing those tasks." }] }
```

## Continuation safety

Interpret follow-up capability from `result.summary.continuation`, not from prompt text, message text, or other inferred context.

- `response_kind` is descriptive only. Keep follow-up logic anchored to `summary.continuation`.
- `summary.continuation.target`: canonical persisted routing contract. Persist `summary.continuation` verbatim and pass it back directly for machine follow-up.
- `summary.continuation.task`: trackable task continuity. Use it for follow-up `send`, `watch`, `status`, and `cancel`.
- `summary.continuation.conversation`: conversation continuity only. Use it only with `send` to start a new task in the same conversation.
- `summary.target_*` is descriptive only and no longer part of the machine follow-up recipe.
- Top-level compatibility aliases stay descriptive only. Do not infer task continuity from flat `task_id`, flat `context_id`, or other top-level summary fields.
- Branch on `summary.continuation.task` vs `summary.continuation.conversation` before choosing the next action.
- Never infer or synthesize `summary.continuation.task` from `summary.continuation.conversation`, session ids, run ids, prior prompts, or summary text.
- Do not call `watch`, `status`, or `cancel` from a result that has only `summary.continuation.conversation`.
- Do not poll from conversation continuity.
- If lifecycle tracking is required, fail fast when the peer returns only `summary.continuation.conversation`.
- Do not route `summary.continuation` back through channel `a2a`; inbound A2A channel delivery is separate from `remote_agent` continuation.
- If you see `A2A_OUTBOUND_DELIVERY_UNSUPPORTED`, the host selected the wrong boundary. Return to persisted `summary.continuation` plus `remote_agent`.

```ts
const task = result.summary.continuation?.task
const conversation = result.summary.continuation?.conversation

if (task) {
  // Trackable task lifecycle.
} else if (conversation) {
  // Send-only conversation continuity.
}
```

Invalid follow-up example:

```json
{ "action": "status", "context_id": "ctx-123" }
```

That is invalid because `status`, `watch`, and `cancel` require task continuity, not just conversation continuity.

### status

Poll the current state of a delegated task.

```json
{ "action": "status", "continuation": { "target": { "target_url": "https://my-agent.example/", "card_path": "/.well-known/agent-card.json", "preferred_transports": ["JSONRPC", "HTTP+JSON"], "target_alias": "my-agent" }, "task": { "task_handle": "rah_abc123", "task_id": "task-123" } } }
```

### watch

Subscribe to live updates from a running task.

```json
{ "action": "watch", "continuation": { "target": { "target_url": "https://my-agent.example/", "card_path": "/.well-known/agent-card.json", "preferred_transports": ["JSONRPC", "HTTP+JSON"], "target_alias": "my-agent" }, "task": { "task_handle": "rah_abc123", "task_id": "task-123" } } }
```

### cancel

Cancel a running task.

```json
{ "action": "cancel", "continuation": { "target": { "target_url": "https://my-agent.example/", "card_path": "/.well-known/agent-card.json", "preferred_transports": ["JSONRPC", "HTTP+JSON"], "target_alias": "my-agent" }, "task": { "task_handle": "rah_abc123", "task_id": "task-123" } } }
```

## Task handles

After a successful `send`, the result usually includes `summary.continuation.task.task_handle` (prefixed `rah_`) when the remote peer exposes task continuity. `task_handle` is returned only when the peer actually created a task. Persist `summary.continuation` verbatim and pass it back directly for follow-up `send`/`watch`/`status`/`cancel` actions. Handles are process-local and expire after restart or TTL, but nested `continuation` still round-trips safely because it also carries durable `summary.continuation.target` plus `summary.continuation.task.task_id`. Treat flat `send.task_id`, `send.context_id`, and `target_alias` as manual compatibility inputs, not as a replacement for nested continuation round-tripping. If the result includes only `summary.continuation.conversation`, there is no task lifecycle to poll, watch, or cancel.

## watch vs status

Use `watch` when the remote agent supports streaming and you want live incremental updates. Use `status` to poll a snapshot of the current task state. If you are unsure whether the target supports streaming, start with `status`.

## Errors

- `UNKNOWN_TASK_HANDLE` — the handle is expired or invalid. Retry with the same nested `continuation`, or re-send. Manual callers may fall back to flat `task_id` plus target routing only when they do not have a persisted `continuation`.
- `TARGET_RESOLUTION_ERROR` — the alias or URL did not resolve. Call `list_targets` to check available targets.
- `VALIDATION_ERROR` — invalid parameters. Check required fields for the action.
