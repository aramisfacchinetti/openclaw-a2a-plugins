---
name: a2a-delegation-setup
description: Guided setup and troubleshooting for installing, enabling, configuring, verifying, and updating @aramisfa/openclaw-a2a-outbound in OpenClaw.
homepage: "https://github.com/aramisfacchinetti/openclaw-a2a-plugins/tree/master/packages/openclaw-a2a-outbound#readme"
user-invocable: true
disable-model-invocation: true
---

# A2A Delegation Setup

Use this skill when `@aramisfa/openclaw-a2a-outbound` still needs installation, enablement, configuration, verification, updating, or troubleshooting on the OpenClaw Gateway host.

Do not use this skill for routine runtime delegation after setup is complete. Once the plugin is ready, switch to the bundled `remote-agent` skill and the `remote_agent` tool.

## Interaction rules

- Ask before any install, update, restart, or config edit.
- Run commands on the Gateway host that owns the OpenClaw config and plugin installation.
- If shell access is unavailable, provide the exact commands and expected verification steps instead of claiming success.

## Use when

- Install `@aramisfa/openclaw-a2a-outbound` for the first time.
- Enable `openclaw-a2a-outbound` in OpenClaw.
- Configure targets or policy settings.
- Verify whether the plugin is actually ready for runtime delegation.
- Update or troubleshoot an existing setup.

## Do not use when

- The plugin is already installed, enabled, configured, and verified, and the task is routine runtime delegation.

## Collect or confirm first

- The target alias to configure.
- The target base URL.
- Whether this target should be the default target.
- Whether direct URL overrides should be allowed through `plugins.entries.openclaw-a2a-outbound.config.policy.allowTargetUrlOverride`.

## Inspect current state

Run these first:

```bash
openclaw plugins list
openclaw plugins info openclaw-a2a-outbound
openclaw config get plugins.entries.openclaw-a2a-outbound
openclaw config validate
```

The bundled runtime skill is only eligible when both `plugins.entries.openclaw-a2a-outbound.enabled` and `plugins.entries.openclaw-a2a-outbound.config.enabled` are true.

## Install or update

For a first install:

```bash
openclaw plugins install @aramisfa/openclaw-a2a-outbound --pin
```

For an update:

```bash
openclaw plugins update openclaw-a2a-outbound
```

Then ensure the plugin entry itself is enabled:

```bash
openclaw plugins enable openclaw-a2a-outbound
```

## Configure readiness

Use `openclaw config set ... --strict-json` whenever you write booleans or arrays into the plugin config.

Required readiness paths:

- `plugins.entries.openclaw-a2a-outbound.config.enabled`
- `plugins.entries.openclaw-a2a-outbound.config.targets`
- `plugins.entries.openclaw-a2a-outbound.config.policy.allowTargetUrlOverride`

Example commands:

```bash
openclaw config set plugins.entries.openclaw-a2a-outbound.config.enabled --strict-json true
openclaw config set plugins.entries.openclaw-a2a-outbound.config.targets --strict-json '[{"alias":"support","baseUrl":"https://support.example","default":true}]'
openclaw config set plugins.entries.openclaw-a2a-outbound.config.policy.allowTargetUrlOverride --strict-json false
openclaw config validate
```

Replace the example alias, base URL, default-target choice, and URL-override policy with the values you confirmed earlier.

## Activate and verify

Use a Gateway restart as the deterministic activation step:

```bash
openclaw gateway restart
```

After the restart, start a new session and verify with:

```text
remote_agent { "action": "list_targets" }
```

If `list_targets` succeeds and the two enable flags remain true, setup is complete.

## Handoff

After setup is complete, stop using this setup skill for normal delegation work. Use the bundled `remote-agent` skill and the `remote_agent` tool instead.
