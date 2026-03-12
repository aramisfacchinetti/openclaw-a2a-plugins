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
- `task_handle`: preferred continuation key for `send`, `watch`, `status`, and `cancel`.
- `task_id`: optional continuation id for `send`; for follow-up actions it identifies the remote task when no `task_handle` is available.
- `context_id`: optional conversation continuation id for `send`. Use it with `task_id`, or by itself to start a new task in the same conversation.
- `follow_updates`: when `true`, streams updates and returns the full event log.
- `blocking`: only for non-stream `send`; do not combine it with `follow_updates=true`.

Preferred continuation forms:

```json
{ "action": "send", "task_handle": "rah_abc123", "parts": [{ "kind": "text", "text": "Approved. Continue." }] }
```

```json
{ "action": "send", "target_alias": "my-agent", "task_id": "task-123", "parts": [{ "kind": "text", "text": "Continue the task." }] }
```

```json
{ "action": "send", "target_alias": "my-agent", "context_id": "ctx-123", "parts": [{ "kind": "text", "text": "Start a new task in the same conversation." }] }
```

## Continuation safety

Interpret follow-up capability from `result.summary.continuation`, not from prompt text, message text, or other inferred context.

- `summary.continuation.task`: trackable task continuity. Use it for follow-up `send`, `watch`, `status`, and `cancel`.
- `summary.continuation.conversation`: conversation continuity only. Use it only with `send` to start a new task in the same conversation.
- Branch on `summary.continuation.task` vs `summary.continuation.conversation` before choosing the next action.
- Never infer or synthesize `summary.continuation.task` from `summary.continuation.conversation`, session ids, run ids, prior prompts, or summary text.
- Do not call `watch`, `status`, or `cancel` from a result that has only `summary.continuation.conversation`.
- If lifecycle tracking is required, fail fast when the peer returns only `summary.continuation.conversation`.

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
{ "action": "status", "task_handle": "rah_abc123" }
```

### watch

Subscribe to live updates from a running task.

```json
{ "action": "watch", "task_handle": "rah_abc123" }
```

### cancel

Cancel a running task.

```json
{ "action": "cancel", "task_handle": "rah_abc123" }
```

## Task handles

After a successful `send`, the result usually includes `summary.continuation.task.task_handle` (prefixed `rah_`) when the remote peer exposes task continuity. Always prefer `summary.continuation.task.task_handle` over `target_alias + summary.continuation.task.task_id` for follow-up `send`/`watch`/`status`/`cancel` actions. Handles are process-local and expire after restart or TTL. If a handle expires, fall back to `target_alias` + `summary.continuation.task.task_id`. Treat `send.task_id` as a continuation id for the remote peer, not as a replacement for `summary.continuation.task.task_handle`. If the result includes only `summary.continuation.conversation`, there is no task lifecycle to poll, watch, or cancel.

## watch vs status

Use `watch` when the remote agent supports streaming and you want live incremental updates. Use `status` to poll a snapshot of the current task state. If you are unsure whether the target supports streaming, start with `status`.

## Errors

- `UNKNOWN_TASK_HANDLE` — the handle is expired or invalid. Retry with `target_alias` + `task_id`, or re-send.
- `TARGET_RESOLUTION_ERROR` — the alias or URL did not resolve. Call `list_targets` to check available targets.
- `VALIDATION_ERROR` — invalid parameters. Check required fields for the action.
