# Pair Two OpenClaw Instances Later

Do this only after the outbound local demo works. The first-success path is still:

```bash
openclaw plugins install @aramisfa/openclaw-a2a-outbound
openclaw a2a demo run
```

## Instance A: Caller

Install outbound:

```bash
openclaw plugins install @aramisfa/openclaw-a2a-outbound
```

Configure a target whose `baseUrl` points at the other instance's inbound A2A endpoint.

## Instance B: Receiver

Install inbound:

```bash
openclaw plugins install @aramisfa/openclaw-a2a-inbound
```

Inbound is an externally reachable HTTP surface. Before traffic can arrive, configure:

- `channels.a2a.accounts.<account>.publicBaseUrl`
- gateway binding appropriate for your network
- any reverse proxy, LAN, Tailscale Serve, or Tailscale Funnel setup

## Boundary

Inbound lets other peers call your OpenClaw instance. It does not replace outbound continuation handling.

For delegated follow-ups from Instance A, keep using:

```json
{
  "action": "send",
  "continuation": "<persisted summary.continuation>",
  "parts": [
    {
      "kind": "text",
      "text": "Continue the delegated work."
    }
  ]
}
```

The only supported outbound A2A continuation contract in this repo is `remote_agent` plus persisted `summary.continuation`.
