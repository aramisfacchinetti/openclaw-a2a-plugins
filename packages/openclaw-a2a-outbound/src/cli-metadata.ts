import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerA2ACli } from "./cli.js";
import {
  A2A_OUTBOUND_OPENCLAW_CONFIG_SCHEMA,
  type A2AOutboundPluginConfig,
} from "./config.js";
import { PLUGIN_ID } from "./constants.js";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "External A2A Delegation CLI Metadata",
  description: "Registers the OpenClaw a2a CLI during command discovery.",
  configSchema: A2A_OUTBOUND_OPENCLAW_CONFIG_SCHEMA,
  register(api) {
    const config = A2A_OUTBOUND_OPENCLAW_CONFIG_SCHEMA.parse?.(
      api.pluginConfig ?? {},
    ) as A2AOutboundPluginConfig;

    api.registerCli?.(
      ({ program }: { program: unknown }) => {
        registerA2ACli(program as Parameters<typeof registerA2ACli>[0], {
          pluginConfig: config,
          rootConfig: api.config,
        });
      },
      {
        commands: ["a2a"],
        descriptors: [
          {
            name: "a2a",
            description: "A2A outbound demo and diagnostics",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
