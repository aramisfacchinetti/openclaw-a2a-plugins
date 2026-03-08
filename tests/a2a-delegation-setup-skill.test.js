const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const skillPath = path.join(
  __dirname,
  "..",
  "skills",
  "a2a-delegation-setup",
  "SKILL.md",
);

function readSkill() {
  return fs.readFileSync(skillPath, "utf8");
}

function getFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]+?)\n---\n/);
  assert.ok(match, "must include valid frontmatter");
  return match[1];
}

test("a2a-delegation-setup SKILL.md exists", () => {
  assert.ok(fs.existsSync(skillPath));
});

test("a2a-delegation-setup SKILL.md has the required frontmatter", () => {
  const frontmatter = getFrontmatter(readSkill());

  assert.match(frontmatter, /^name:\s*a2a-delegation-setup$/m);
  assert.match(
    frontmatter,
    /^description:\s*.*@aramisfa\/openclaw-a2a-outbound.*$/m,
  );
  assert.match(frontmatter, /^homepage:\s*.*openclaw-a2a-outbound.*$/m);
  assert.match(frontmatter, /^user-invocable:\s*true$/m);
  assert.match(frontmatter, /^disable-model-invocation:\s*true$/m);
});

test("a2a-delegation-setup SKILL.md documents the required setup flow", () => {
  const content = readSkill();

  for (const needle of [
    "@aramisfa/openclaw-a2a-outbound",
    "openclaw-a2a-outbound",
    "plugins.entries.openclaw-a2a-outbound.enabled",
    "plugins.entries.openclaw-a2a-outbound.config.enabled",
    "openclaw plugins install",
    "openclaw plugins enable",
    "openclaw config set ... --strict-json",
    "openclaw config validate",
    "openclaw gateway restart",
    "remote-agent",
  ]) {
    assert.ok(content.includes(needle), `must include: ${needle}`);
  }

  assert.match(
    content,
    /remote_agent\s+\{\s*"action":\s*"list_targets"\s*\}/,
  );
  assert.doesNotMatch(content, /\bnpm install\b/);
});
