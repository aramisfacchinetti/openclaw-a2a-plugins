#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { syncPluginManifestVersions } = require("./sync-plugin-manifest-versions.cjs");

function main(env = process.env) {
  const command = process.platform === "win32" ? "changeset.cmd" : "changeset";
  const result = spawnSync(command, ["version"], {
    env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }

  syncPluginManifestVersions();
}

if (require.main === module) {
  main();
}

module.exports = { main };
