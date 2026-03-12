---
name: remote-agent
description: Delegate work to external A2A agents using the remote_agent tool.
metadata: {"openclaw": {"requires": {"config": ["plugins.entries.openclaw-a2a-outbound.enabled", "plugins.entries.openclaw-a2a-outbound.config.enabled"]}}}
---

# Remote Agent Delegation

If the plugin is not installed or configured yet, use the `a2a-delegation-setup` skill first.

Use the `remote_agent` tool to delegate work to external A2A-compatible agents and manage delegated tasks.

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

Send a request to a remote agent.

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
- `task_id`: optional continuation id for `send`; for follow-up actions it identifies the remote task when no `task_handle` is available.
- `follow_updates`: when `true`, streams updates and returns the full event log.
- `blocking`: only for non-stream `send`; do not combine it with `follow_updates=true`.

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

After a successful `send`, the result includes a `task_handle` (prefixed `rah_`). Always prefer `task_handle` over `target_alias + task_id` for follow-up actions — the handle encodes the target and task identity in one opaque token. Handles are process-local and expire after restart or TTL. If a handle expires, fall back to `target_alias` + `task_id`. Treat `send.task_id` as a continuation id for the remote peer, not as a follow-up handle.

## watch vs status

Use `watch` when the remote agent supports streaming and you want live incremental updates. Use `status` to poll a snapshot of the current task state. If you are unsure whether the target supports streaming, start with `status`.

## Errors

- `UNKNOWN_TASK_HANDLE` — the handle is expired or invalid. Retry with `target_alias` + `task_id`, or re-send.
- `TARGET_RESOLUTION_ERROR` — the alias or URL did not resolve. Call `list_targets` to check available targets.
- `VALIDATION_ERROR` — invalid parameters. Check required fields for the action.
