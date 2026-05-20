# Durable Task Plus Continuation

Use durable task delegation when the remote peer returns a task or when your caller needs later `watch`, `status`, `cancel`, or resumed `send`.

## Create A Task

```json
{
  "action": "send",
  "target_alias": "local-demo",
  "task_requirement": "required",
  "parts": [
    {
      "kind": "text",
      "text": "Create a durable demo task."
    }
  ]
}
```

Persist this subtree from the result:

```text
summary.continuation
```

Persist it verbatim. Downstream callers that store follow-up state should atomically replace their stored state from one result envelope and keep the full `summary.continuation` subtree.

## Follow Up

Status:

```json
{
  "action": "status",
  "continuation": "<persisted summary.continuation>"
}
```

Watch:

```json
{
  "action": "watch",
  "continuation": "<persisted summary.continuation>"
}
```

Resume:

```json
{
  "action": "send",
  "continuation": "<persisted summary.continuation>",
  "parts": [
    {
      "kind": "text",
      "text": "Continue from the persisted continuation."
    }
  ]
}
```

Cancel:

```json
{
  "action": "cancel",
  "continuation": "<persisted summary.continuation>"
}
```

## Rules

- `summary.continuation.task` is the task lifecycle authority.
- `summary.continuation.conversation` is send-only conversation continuity.
- `summary.continuation.target` is the durable routing authority.
- Do not flatten persisted continuation state back into prompt text.
- Do not route outbound follow-ups through the inbound `a2a` channel.
