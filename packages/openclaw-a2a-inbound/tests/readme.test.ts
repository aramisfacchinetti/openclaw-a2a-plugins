import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readmePath = new URL("../README.md", import.meta.url);

test("README documents hybrid and task-generating agent styles", () => {
  const content = readFileSync(readmePath, "utf8");

  assert.ok(content.includes("`agentStyle`"));
  assert.ok(content.includes('`hybrid` (default)'));
  assert.ok(content.includes('`task-generating`'));
});
