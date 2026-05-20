# Hosted Sandbox

No hosted public sandbox URL is published from this repository yet.

The local demo remains the primary onboarding path:

```bash
openclaw a2a demo run
openclaw a2a demo serve
```

## Rollout Gate

A hosted sandbox should be exposed only after the packaged local demo peer, docs, examples, and diagnostics are green. The sandbox must use the same demo-peer module that powers `demo run` and `demo serve`; it must not define a separate behavior contract.

## Required Limits

When published, the sandbox must be:

- deterministic scripted responses only
- no external tools
- no outbound network
- no filesystem or secret access
- request-size limited
- rate limited
- abuse logged with redaction
- clearly labeled best-effort and public

## Privacy

Do not send sensitive prompts to a public sandbox. The local demo is the recommended private path because it runs on your machine and uses no external service.

## Failure Modes

Expected public-sandbox failures should include:

- rate limited
- request too large
- sandbox unavailable
- version temporarily behind the latest npm package

Docs and README content must never require the hosted sandbox for first success.
