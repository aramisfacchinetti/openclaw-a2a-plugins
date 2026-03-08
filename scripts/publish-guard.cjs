#!/usr/bin/env node

const EXPECTED_REPOSITORY = "aramisfacchinetti/openclaw-a2a-plugins";

function isTruthy(value) {
  return typeof value === "string" && /^(1|true)$/i.test(value);
}

function isDryRun(env = process.env) {
  return isTruthy(env.npm_config_dry_run);
}

function isAllowedCiPublish(env = process.env) {
  return (
    env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_REPOSITORY === EXPECTED_REPOSITORY
  );
}

function isPublishLifecycle(env = process.env) {
  const npmCommand = String(env.npm_command ?? "").toLowerCase();
  const lifecycleEvent = String(env.npm_lifecycle_event ?? "").toLowerCase();

  return npmCommand === "publish" || lifecycleEvent === "prepublishonly";
}

function enforcePackagePublish(env = process.env, packageName = "this package") {
  if (!isPublishLifecycle(env) || isDryRun(env) || isAllowedCiPublish(env)) {
    return;
  }

  throw new Error(
    `${packageName} publishes are restricted to GitHub Actions for ${EXPECTED_REPOSITORY}. ` +
      `Use "npm publish --dry-run" locally for verification and let .github/workflows/release.yml publish real releases.`,
  );
}

function enforceReleaseCommand(env = process.env) {
  if (isAllowedCiPublish(env)) {
    return;
  }

  throw new Error(
    `Publishing is restricted to GitHub Actions for ${EXPECTED_REPOSITORY}. ` +
      `Run "pnpm changeset" and "pnpm version-packages" locally, then merge to master so .github/workflows/release.yml can publish.`,
  );
}

function main(argv = process.argv.slice(2), env = process.env) {
  const [mode = "package"] = argv;
  const packageNameArg = argv.find((value) => value.startsWith("--package="));
  const packageName = packageNameArg
    ? packageNameArg.slice("--package=".length)
    : "this package";

  try {
    if (mode === "release") {
      enforceReleaseCommand(env);
      return;
    }

    if (mode === "package") {
      enforcePackagePublish(env, packageName);
      return;
    }

    throw new Error(`Unsupported publish guard mode: ${mode}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  EXPECTED_REPOSITORY,
  enforcePackagePublish,
  enforceReleaseCommand,
  isAllowedCiPublish,
  isDryRun,
  isPublishLifecycle,
  main,
};
