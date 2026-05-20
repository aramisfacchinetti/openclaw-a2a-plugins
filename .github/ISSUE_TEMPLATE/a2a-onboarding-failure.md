---
name: A2A onboarding failure
about: Report a first-run failure with the OpenClaw A2A outbound demo or diagnostics
title: "a2a onboarding failure: "
labels: ["a2a", "onboarding"]
assignees: ""
---

## Command

```bash
openclaw a2a demo run
```

or:

```bash
openclaw a2a doctor --alias local-demo
```

## Paste one diagnostic output

Prefer:

```bash
openclaw a2a doctor --alias local-demo --json
```

If the failure is in the zero-config demo path, paste:

```bash
openclaw a2a demo run --json
```

## Environment

- OpenClaw version:
- Node.js version:
- OS:
- Package version:

## Notes

Do not paste secrets, private prompts, or private endpoint URLs unless you have redacted them.
