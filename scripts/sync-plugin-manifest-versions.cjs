#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function listPackageDirectories(repoRoot) {
  const packagesRoot = path.join(repoRoot, "packages");
  if (!fs.existsSync(packagesRoot)) {
    return [];
  }

  return fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesRoot, entry.name));
}

function syncPluginManifestVersions(repoRoot = process.cwd()) {
  const updatedFiles = [];

  for (const packageDir of listPackageDirectories(repoRoot)) {
    const packageJsonPath = path.join(packageDir, "package.json");
    const manifestPath = path.join(packageDir, "openclaw.plugin.json");

    if (!fs.existsSync(packageJsonPath) || !fs.existsSync(manifestPath)) {
      continue;
    }

    const packageJson = readJson(packageJsonPath);
    const manifest = readJson(manifestPath);

    if (typeof packageJson.version !== "string") {
      continue;
    }

    if (manifest.version === packageJson.version) {
      continue;
    }

    manifest.version = packageJson.version;
    writeJson(manifestPath, manifest);
    updatedFiles.push(manifestPath);
  }

  return updatedFiles;
}

function main() {
  const updatedFiles = syncPluginManifestVersions();

  if (updatedFiles.length === 0) {
    console.log("Plugin manifest versions already match package versions.");
    return;
  }

  for (const filePath of updatedFiles) {
    console.log(`Synced ${path.relative(process.cwd(), filePath)}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  listPackageDirectories,
  syncPluginManifestVersions,
};
