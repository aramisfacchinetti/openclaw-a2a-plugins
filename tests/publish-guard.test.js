const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const publishGuardPath = path.join(repoRoot, "scripts", "publish-guard.cjs");
const runReleasePath = path.join(repoRoot, "scripts", "run-release.cjs");
const expectedRepository = "aramisfacchinetti/openclaw-a2a-plugins";

function runNodeScript(scriptPath, args, envOverrides) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...envOverrides,
    },
    encoding: "utf8",
  });
}

test("local package publish attempts are rejected", () => {
  const result = runNodeScript(
    publishGuardPath,
    ["package", "--package=@aramisfa/openclaw-a2a-outbound"],
    {
      npm_command: "publish",
      npm_lifecycle_event: "prepublishOnly",
      npm_config_dry_run: "",
      GITHUB_ACTIONS: "",
      GITHUB_REPOSITORY: "",
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /restricted to GitHub Actions/);
});

test("local npm publish dry-runs are allowed", () => {
  const result = runNodeScript(
    publishGuardPath,
    ["package", "--package=@aramisfa/openclaw-a2a-outbound"],
    {
      npm_command: "publish",
      npm_lifecycle_event: "prepublishOnly",
      npm_config_dry_run: "true",
      GITHUB_ACTIONS: "",
      GITHUB_REPOSITORY: "",
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("CI release wrapper allows the canonical repository", () => {
  const result = runNodeScript(runReleasePath, ["--dry-run"], {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: expectedRepository,
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Release guard passed/);
});

test("CI release wrapper rejects the wrong repository slug", () => {
  const result = runNodeScript(runReleasePath, ["--dry-run"], {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "example/openclaw-a2a-plugins",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /restricted to GitHub Actions/);
});
