#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { enforceReleaseCommand } = require("./publish-guard.cjs");

function main(argv = process.argv.slice(2), env = process.env) {
  const dryRun = argv.includes("--dry-run");

  try {
    enforceReleaseCommand(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }

  if (dryRun) {
    console.log("Release guard passed.");
    return;
  }

  const command = process.platform === "win32" ? "changeset.cmd" : "changeset";
  const result = spawnSync(command, ["publish"], {
    env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

if (require.main === module) {
  main();
}

module.exports = { main };
