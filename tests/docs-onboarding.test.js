const test = require("node:test");
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

async function read(path) {
  return readFile(join(__dirname, "..", path), "utf8");
}

test("onboarding docs keep the outbound demo as the first success path", async () => {
  const rootReadme = await read("README.md");
  const quickstart = await read("docs/quickstart.md");
  const outboundReadme = await read("packages/openclaw-a2a-outbound/README.md");

  for (const content of [rootReadme, quickstart, outboundReadme]) {
    assert.match(
      content,
      /openclaw plugins install @aramisfa\/openclaw-a2a-outbound/,
    );
    assert.match(content, /openclaw a2a demo run/);
    assert.match(content, /local-demo/);
  }
});

test("raw quickstart docs include strict config and continuation replay payloads", async () => {
  const quickstart = await read("docs/quickstart.md");

  assert.match(quickstart, /openclaw a2a demo serve --port 41234/);
  assert.match(quickstart, /--strict-json/);
  assert.match(quickstart, /"action": "list_targets"/);
  assert.match(quickstart, /"action": "watch"/);
  assert.match(quickstart, /"action": "status"/);
  assert.match(quickstart, /Continue from the persisted continuation/);
});

test("published demo assets are parseable", async () => {
  const cast = await read("docs/assets/openclaw-a2a-demo-run.cast");
  const lines = cast.trim().split("\n");

  for (const line of lines) {
    JSON.parse(line);
  }

  const continuation = JSON.parse(
    await read("docs/assets/continuation-round-trip.json"),
  );

  assert.equal(continuation.send.action, "send");
  assert.equal(continuation.replay.action, "send");
});
