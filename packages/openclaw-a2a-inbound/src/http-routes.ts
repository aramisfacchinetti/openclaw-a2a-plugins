import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { A2AInboundChannelConfig } from "./config.js";
import { deriveFilesBasePath } from "./file-delivery.js";
import type { A2AInboundPluginHost } from "./plugin-host.js";

export function registerA2AInboundHttpRoutes(
  api: OpenClawPluginApi,
  host: A2AInboundPluginHost,
  config: A2AInboundChannelConfig,
): number {
  let registered = 0;

  for (const account of Object.values(config.accounts)) {
    if (!account.enabled) {
      continue;
    }

    api.registerHttpRoute({
      path: account.agentCardPath,
      auth: "plugin",
      handler: (req, res) =>
        host.handleHttpRoute({ accountId: account.accountId, req, res }),
    });
    registered += 1;

    api.registerHttpRoute({
      path: account.jsonRpcPath,
      auth: "plugin",
      handler: (req, res) =>
        host.handleHttpRoute({ accountId: account.accountId, req, res }),
    });
    registered += 1;

    api.registerHttpRoute({
      path: deriveFilesBasePath(account.jsonRpcPath),
      auth: "plugin",
      match: "prefix",
      handler: (req, res) =>
        host.handleHttpRoute({ accountId: account.accountId, req, res }),
    });
    registered += 1;
  }

  return registered;
}
