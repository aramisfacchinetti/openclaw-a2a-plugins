# AGENTS.md

- This project is greenfield with no external users. Backward compatibility is not required. Breaking changes to APIs, schemas, interfaces, and assumptions are acceptable while we iterate on structure.
- Do not assume non trivial or non obvious things. Ask the developer/user/human working with you for which assumptions hold. If anything is ambiguous or you have questions, ask.
- Code and official documentation are the primary sources of truth.
- If you make a mistake, detect an ambiguous instruction, or find a recurring failure mode, update `AGENTS.md` in the same change so future agents do not repeat it. Add only concrete, repository-specific guidance that cannot be deduced in this repository. Keep it concise and direct.
- Repository-internal design and RFC documents live under root `.design/`.
- Git commit messages must be one-line, one-sentence statements of the code change. They must not contain footers, co-author mentions, or additional description lines.
- For OpenClaw plugin packages in this repo, keep the unscoped npm package name identical to `openclaw.plugin.json.id` to avoid plugin discovery id-mismatch warnings.
- For OpenClaw plugin packages in this repo, keep `openclaw.plugin.json.version` synced with the package version before publishing.
- In `packages/openclaw-a2a-inbound`, keep the plugin/package/manifest id as `openclaw-a2a-inbound`, but keep the OpenClaw channel id separate as `a2a`.
- Keep both `@aramisfa/openclaw-a2a-inbound` and `@aramisfa/openclaw-a2a-outbound` public and release-managed through Changesets plus `.github/workflows/release.yml`.
- Real npm publishes and GitHub Releases in this repo must come from `.github/workflows/release.yml`; local `pnpm release` and direct `npm publish` are for `--dry-run` verification only.
- Standalone skills for this repo live under root `skills/` and are published manually, separately from npm package releases and Changesets.
- In `packages/openclaw-a2a-outbound`, downstream callers must use `summary.continuation.task` for trackable tasks and must never treat `summary.continuation.conversation` as task continuity; conversation continuity authorizes only `send` with `context_id`.
- In `packages/openclaw-a2a-inbound`, treat A2A `taskId`/`contextId`, OpenClaw `SessionKey`, and OpenClaw `runId` as independent identifiers; never derive `runId` from session ids or rely on current OpenClaw fallback behavior.
- In `packages/openclaw-a2a-inbound`, decide `tasks/resubscribe` live-tail eligibility before the first `yield`; checking `liveExecutions.has(taskId)` after yielding the snapshot can close a subscription that already buffered final committed events.
- Changes in this project/codebase shall always be the most ideal and best solution in terms of structure, style, conventions, best practices, maintainability, SOLID, DRY, KISS, etc. If you are told to do something with is not ideal, stop and ask for clarification.
