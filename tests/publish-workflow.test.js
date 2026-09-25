const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const workflow = fs.readFileSync(
  path.join(repoRoot, ".github", "workflows", "publish.yml"),
  "utf8",
);
const expectedRepository = "aramisfacchinetti/openclaw-a2a-plugins";
const expectedCondition = `github.event_name == 'workflow_dispatch' || (
  github.event_name == 'pull_request' &&
  github.event.action == 'closed' &&
  github.event.pull_request.merged == true &&
  github.event.pull_request.base.ref == 'master' &&
  github.event.pull_request.head.ref == 'changeset-release/master' &&
  github.event.pull_request.head.repo.full_name == github.repository
)`;

function normalizeExpression(expression) {
  return expression.replace(/\s+/g, " ").trim();
}

function extractPublishCondition() {
  const match = workflow.match(/^    if: >-\r?\n((?: {6,}.*(?:\r?\n|$))+)/m);
  assert.ok(match, "publish job should have a folded if condition");
  return normalizeExpression(match[1]);
}

function releasePullRequestEvent({
  merged = true,
  action = "closed",
  headRef = "changeset-release/master",
  headRepository = expectedRepository,
  baseRef = "master",
  mergeCommitMessage,
  mergeCommitSha = "merged-commit-sha",
} = {}) {
  return {
    event_name: "pull_request",
    action,
    repository: expectedRepository,
    head_commit: mergeCommitMessage
      ? { message: mergeCommitMessage }
      : undefined,
    pull_request: {
      merged,
      base: { ref: baseRef },
      head: {
        ref: headRef,
        repo: { full_name: headRepository },
      },
      merge_commit_sha: mergeCommitSha,
    },
  };
}

function conditionAllowsPublish(event) {
  return (
    event.event_name === "workflow_dispatch" ||
    (event.event_name === "pull_request" &&
      event.action === "closed" &&
      event.pull_request.merged === true &&
      event.pull_request.base.ref === "master" &&
      event.pull_request.head.ref === "changeset-release/master" &&
      event.pull_request.head.repo.full_name === event.repository)
  );
}

test("publish workflow runs for a closed pull request targeting master", () => {
  assert.match(workflow, /^  pull_request:\r?\n/m);
  assert.match(workflow, /^    types:\r?\n      - closed\r?\n/m);
  assert.match(workflow, /^    branches:\r?\n      - master\r?\n/m);
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
});

test("publish job is limited to a merged Changesets release PR or manual dispatch", () => {
  assert.equal(
    extractPublishCondition(),
    normalizeExpression(expectedCondition),
  );
  assert.doesNotMatch(workflow, /github\.event\.head_commit\.message/);
  assert.doesNotMatch(workflow, /Merge pull request #/);
  assert.doesNotMatch(workflow, /contains\([^\n]*changeset-release\/master/);
});

test("a merged same-repository Changesets release PR qualifies", () => {
  assert.equal(conditionAllowsPublish(releasePullRequestEvent()), true);
});

test("a closed but unmerged Changesets release PR does not qualify", () => {
  assert.equal(
    conditionAllowsPublish(releasePullRequestEvent({ merged: false })),
    false,
  );
});

test("an ordinary merged pull request does not qualify", () => {
  assert.equal(
    conditionAllowsPublish(
      releasePullRequestEvent({ headRef: "fix/ordinary-change" }),
    ),
    false,
  );
});

test("a release-named pull request from a fork does not qualify", () => {
  assert.equal(
    conditionAllowsPublish(
      releasePullRequestEvent({
        headRepository: "contributor/openclaw-a2a-plugins",
      }),
    ),
    false,
  );
});

test("release PR qualification does not depend on merge commit message format", () => {
  for (const mergeCommitMessage of [
    "Version Packages (#12)",
    "rebased release commit",
    "Merge pull request #12 from aramisfacchinetti/changeset-release/master",
  ]) {
    assert.equal(
      conditionAllowsPublish(releasePullRequestEvent({ mergeCommitMessage })),
      true,
      mergeCommitMessage,
    );
  }

  assert.match(
    workflow,
    /ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.merge_commit_sha \|\| github\.sha \}\}/,
  );
});

test("workflow dispatch remains an explicit publishing path", () => {
  assert.equal(
    conditionAllowsPublish({ event_name: "workflow_dispatch" }),
    true,
  );
});
