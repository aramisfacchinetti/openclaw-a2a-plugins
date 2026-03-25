# RFC: First-Class A2A File Attachment Interoperability Across Inbound And Outbound

Status: Proposed

Date: 2026-03-12

Last Updated: 2026-03-12

## Summary

`openclaw-a2a-outbound` currently accepts file attachments on `remote_agent.send` and serializes them into A2A `message.parts[].kind = "file"`.

`openclaw-a2a-inbound` currently rejects any inbound A2A `file` part with `invalidParams` before execution.

That split contract is not acceptable as a steady state because:

- the repository's own outbound package can originate a request shape that the repository's own inbound package always rejects
- the failure occurs after network dispatch instead of at a truthful capability boundary
- the inbound bridge has no first-class attachment model, so the current reject path is hiding a missing architectural layer rather than representing a deliberate long-term product boundary

This RFC defines the long-term fix:

- implement first-class A2A file attachment support end-to-end
- keep file attachments as real A2A `file` parts, not prompt text or metadata tunnels
- add explicit capability negotiation for accepted part kinds and attachment behavior
- land the work as one coordinated program with dependency-ordered tasks

## Decision

The long-term contract for this repository should be:

- outbound continues to expose file attachments as first-class `remote_agent.send` input
- inbound accepts A2A `text`, `data`, and `file` request parts
- the OpenClaw bridge receives attachments as structured input, separate from user text
- task storage and response mapping gain explicit attachment semantics instead of implicit text-only behavior
- agent cards advertise attachment support explicitly enough for outbound to preflight locally
- outbound must reject locally when the target does not support file parts

This is a breaking change program and may change config shape, internal storage shape, and agent-card extension behavior as needed.

## Current Problem Statement

Today:

- outbound accepts `attachments` with both `kind = "file"` and `kind = "data"`
- inbound accepts `data` parts but rejects all `file` parts
- inbound also omits `/a2a/files` and strips file output from direct replies

The current contract is therefore internally inconsistent in two directions:

- request-side file input is not interoperable
- response-side file output is intentionally filtered away or rejected

Fixing only request validation is insufficient. The attachment model must be made explicit across:

- request normalization
- OpenClaw execution input
- persisted task state
- response mapping
- agent-card capability advertisement
- outbound preflight validation
- cross-package integration testing

## End-State Contract

The target contract after this RFC is implemented is:

- inbound request parts support:
  - `text`
  - `data`
  - `file`
- inbound no longer rejects `file.bytes` or `file.uri` at the protocol boundary when the account advertises attachment support
- OpenClaw receives:
  - normalized user text
  - normalized structured data notes
  - normalized attachment objects
- outbound validates target attachment support before calling `sendMessage` or `sendMessageStream`
- request-side attachment capability is advertised through:
  - MIME-oriented input modes
  - an explicit extension describing accepted part kinds and attachment behavior
- response-side file artifacts are representable without synthetic undocumented URLs
- repository self-interop succeeds for:
  - `file.uri`
  - `file.bytes`
  - mixed `text + file`
  - mixed `data + file`

## Non-Goals

This RFC does not require:

- transparent server-side fetching of remote `file.uri` content
- binary de-duplication or content-addressable storage in the first implementation
- backward-compatible retention of the current text/data-only inbound contract
- support for unrelated transports in the same change

## Canonical Attachment Model

Inbound and outbound should converge on one canonical internal attachment shape for request handling:

```ts
type NormalizedAttachment =
  | {
      kind: "file";
      source: {
        kind: "bytes";
        bytesBase64: string;
      };
      name?: string;
      mimeType?: string;
      metadata?: Record<string, unknown>;
      attachmentId: string;
    }
  | {
      kind: "file";
      source: {
        kind: "uri";
        uri: string;
      };
      name?: string;
      mimeType?: string;
      metadata?: Record<string, unknown>;
      attachmentId: string;
    };
```

Key rules:

- `attachmentId` is assigned by inbound normalization and is stable within task history and persistence
- `file.bytes` remains base64 and is not silently decoded into arbitrary strings
- `file.uri` remains a URI reference unless a later explicit fetch policy is added
- user text, structured data, and attachments stay as separate channels in the execution context

## Capability Contract

The repository should not use `defaultInputModes` alone to communicate file-part support because MIME types do not fully express accepted A2A part kinds.

The contract should use both:

- `defaultInputModes` and per-skill input modes for MIME-level compatibility
- an explicit A2A extension for part-kind and attachment capability advertisement

The extension should minimally advertise:

- accepted request part kinds
- whether `file.bytes` is accepted
- whether `file.uri` is accepted
- maximum inline bytes size
- allowed URI schemes
- whether response-side file artifacts are exposed

Outbound should treat the explicit extension as authoritative when present and use conservative failure when attachment support cannot be proven.

## Delivery Model

This work should be executed as one program with dependency-ordered tasks.

It may be implemented in one branch and merged atomically, or as stacked changes hidden behind a final integration gate. It should not be considered complete until all tasks and end-to-end interop tests are green together.

## Tasks

### Task 1: Finalize The Attachment Domain Model

Define and implement the canonical internal attachment model shared by inbound request normalization, executor input, and persistence.

Scope:

- add normalized attachment types under inbound
- define attachment ids and validation rules
- define size and URI policy fields needed for later capability advertisement
- define how attachments are represented in persisted task state and intermediate execution state

Acceptance criteria:

- one canonical attachment type exists and is used by inbound normalization rather than ad hoc file-part handling
- `file.bytes` and `file.uri` normalize into the same top-level model with different `source.kind`
- the model preserves `name`, `mimeType`, metadata, and stable attachment ids
- no inbound code path treats file payloads as plain text
- tests cover normalization of:
  - `file.bytes`
  - `file.uri`
  - missing name
  - missing mime type
  - metadata passthrough
  - malformed inputs rejected with deterministic errors

### Task 2: Extend The Inbound Execution Contract

Teach the inbound bridge to pass attachments to OpenClaw as first-class execution input instead of rejecting them at the protocol boundary.

Scope:

- replace the hard reject-only request validation path for supported file parts
- extend the route context or a successor input object to include normalized attachments
- update the OpenClaw executor bridge to carry text, data notes, and attachments separately
- define how attachments are exposed to the downstream execution layer without being collapsed into `BodyForAgent`

Acceptance criteria:

- inbound no longer throws `invalidParams` for supported `file.bytes` and `file.uri` requests
- execution receives attachments as structured input separate from the agent body string
- mixed `text + file` requests preserve both channels
- mixed `data + file` requests preserve both channels
- file-only requests are routable when attachments are otherwise valid
- tests prove execution was invoked for supported file input rather than rejected before execution

### Task 3: Add Attachment Persistence And Storage Semantics

Persist request-side attachment state and define storage rules for inline bytes and URI references.

Scope:

- extend task persistence schema as needed
- decide whether inline bytes are stored inline, externalized, or bounded by configured size limits
- preserve attachment identity in task history or companion persisted state
- ensure memory and json-file backends behave consistently

Acceptance criteria:

- persisted task state can round-trip normalized attachments without lossy conversion to text
- schema upgrades are defined for existing task records
- json-file persistence remains atomic and deterministic
- request follow-ups do not duplicate previously stored attachment payloads unintentionally
- tests cover:
  - memory backend round-trip
  - json-file backend round-trip
  - restart persistence
  - schema upgrade behavior

### Task 4: Define Public File Capability Advertisement

Expose attachment support honestly on the agent card through an explicit extension and aligned input modes.

Scope:

- define one repo-owned agent-card extension for attachment capability advertisement
- include accepted part kinds and attachment behavior
- align account config and skill metadata with the advertised capability
- document exact attachment support in package README and agent-card tests

Acceptance criteria:

- agent card exposes an explicit machine-readable attachment capability contract
- advertised request part kinds match actual inbound validation behavior
- `defaultInputModes` and any per-skill input modes remain consistent with attachment MIME rules
- outbound can discover attachment capability from hydrated card metadata without guessing from prose
- tests fail if the advertised capability and runtime behavior diverge

### Task 5: Implement Outbound Capability-Aware Preflight

Prevent outbound from sending file attachments to targets that do not advertise support.

Scope:

- extend target catalog hydration to read and cache attachment capability metadata
- add send-time validation for attachment-bearing requests
- fail locally before network dispatch when the target does not support requested attachment forms
- surface a precise tool error instead of a generic remote SDK failure

Acceptance criteria:

- outbound send with `attachments.kind = "file"` fails locally when target capability is absent or incompatible
- outbound send succeeds locally when target advertises compatible attachment support
- capability checks distinguish:
  - `file.bytes`
  - `file.uri`
  - MIME restrictions
  - inline size limits
- the failure code and message clearly explain why the target is incompatible
- tests prove that incompatible targets are rejected before `client.sendMessage` is called

### Task 6: Restore Response-Side File Artifact Semantics

Add a supported contract for A2A file artifacts and direct file responses instead of filtering them away.

Scope:

- define how OpenClaw media outputs become A2A file artifacts or file message parts
- define whether `/a2a/files` or another documented file-serving surface is required
- stop relying on silent output filtering as the normal representation strategy
- ensure output modes and artifact serialization remain truthful

Acceptance criteria:

- direct replies and task artifacts can represent supported file outputs without undocumented synthetic URLs
- response-side file representation is documented and tested
- file-only direct replies no longer fail solely because the runtime lacks a representable file contract
- `text/plain` filtering still behaves correctly when the caller explicitly disallows file output
- tests cover:
  - direct message with file output
  - task artifact with file output
  - output-mode filtering
  - absence of undocumented transport URLs

### Task 7: Add Cross-Package Interop Coverage

Prove that the repository's outbound and inbound packages interoperate correctly for file attachments.

Scope:

- add live interop tests between outbound and inbound in the same workspace
- cover blocking and streaming send paths
- cover request-side file forms and capability mismatch cases
- make the interop suite part of normal CI for these packages

Acceptance criteria:

- one end-to-end test sends `file.uri` from outbound to inbound and reaches execution successfully
- one end-to-end test sends `file.bytes` from outbound to inbound and reaches execution successfully
- one end-to-end test sends mixed `text + file` successfully
- one end-to-end test proves outbound rejects a file attachment before network dispatch when the target lacks capability
- no package-level unit tests remain as the only proof of attachment compatibility

## Cross-Cutting Constraints

The following rules apply to every Task:

- no prompt-text or metadata tunneling may be introduced as a permanent representation for file attachments
- no hidden fallback behavior may make unsupported targets appear compatible
- repo-owned capability advertisement must stay in sync with actual validation and runtime behavior
- request-side and response-side attachment behavior must both be documented
- all new behavior must work with both memory and json-file task stores

## Suggested Sequencing

The dependency order should be:

1. Task 1: attachment domain model
2. Task 2: inbound execution contract
3. Task 3: persistence
4. Task 4: capability advertisement
5. Task 5: outbound preflight
6. Task 6: response-side file artifacts
7. Task 7: cross-package interop coverage

tasks 4 and 5 should not be considered done independently of each other, because outbound preflight depends on the final public capability contract.

Task 6 may share implementation work with tasks 2 and 3, but it must still have separate acceptance because the current repository is broken on both request-side and response-side file semantics.

## Final Acceptance Criteria

This RFC is complete only when all of the following are true together:

- outbound and inbound self-interop succeeds for A2A file attachments
- inbound accepts supported file parts and passes them into execution as structured input
- outbound rejects incompatible file attachment requests locally before network dispatch
- agent cards advertise attachment capability explicitly and truthfully
- persisted task state preserves attachment semantics without text coercion
- response-side file outputs are represented through a documented supported contract
- end-to-end integration tests cover the attachment contract across package boundaries
