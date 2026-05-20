# Minimal Outbound Consumer

This example pins the current package versions and configures one local demo target.

Start the demo peer:

```bash
openclaw a2a demo serve --port 41234
```

Install and configure outbound:

```bash
openclaw plugins install @aramisfa/openclaw-a2a-outbound
openclaw plugins enable openclaw-a2a-outbound
openclaw config set plugins.entries.openclaw-a2a-outbound.config "$(tr -d '\n' < openclaw-a2a-outbound.config.json)" --strict-json
```

Verify:

```bash
openclaw a2a doctor --alias local-demo
```

Then call `remote_agent` with:

```json
{ "action": "list_targets" }
```

and:

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
