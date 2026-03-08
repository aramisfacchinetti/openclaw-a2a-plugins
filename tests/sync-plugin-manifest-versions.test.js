const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  syncPluginManifestVersions,
} = require("../scripts/sync-plugin-manifest-versions.cjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("syncPluginManifestVersions aligns manifest versions with package versions", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sync-test-"));

  writeJson(path.join(repoRoot, "packages", "plugin-a", "package.json"), {
    name: "@scope/plugin-a",
    version: "1.2.3",
  });
  writeJson(path.join(repoRoot, "packages", "plugin-a", "openclaw.plugin.json"), {
    id: "plugin-a",
    version: "0.0.1",
  });
  writeJson(path.join(repoRoot, "packages", "plugin-b", "package.json"), {
    name: "@scope/plugin-b",
    version: "4.5.6",
  });
  writeJson(path.join(repoRoot, "packages", "plugin-b", "openclaw.plugin.json"), {
    id: "plugin-b",
    version: "4.5.6",
  });
  writeJson(path.join(repoRoot, "packages", "library-only", "package.json"), {
    name: "@scope/library-only",
    version: "9.9.9",
  });

  const updatedFiles = syncPluginManifestVersions(repoRoot);
  const pluginAManifest = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "packages", "plugin-a", "openclaw.plugin.json"),
      "utf8",
    ),
  );
  const pluginBManifest = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "packages", "plugin-b", "openclaw.plugin.json"),
      "utf8",
    ),
  );

  assert.equal(updatedFiles.length, 1);
  assert.equal(pluginAManifest.version, "1.2.3");
  assert.equal(pluginBManifest.version, "4.5.6");
});
