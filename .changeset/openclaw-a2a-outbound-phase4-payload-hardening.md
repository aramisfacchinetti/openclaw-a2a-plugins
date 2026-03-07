---
'@aramisfa/openclaw-a2a-outbound': minor
---

Harden delegate payload typing and runtime validation in `@aramisfa/openclaw-a2a-outbound`.

- Switched delegate request typing to SDK-native `Message` and `MessageSendParams["metadata"]`.
- Added strict runtime validation for `request.message` and part variants (`text`, `file`, `data`) with deterministic validation paths.
- Removed unsafe delegate message cast in service flow and aligned delegate/status/cancel parameter typing with SDK request types.
- Typed success envelope `raw` payloads by operation (`SendMessageResult`/`Task`) without changing envelope keys.
- Tightened delegate tool JSON schema to explicit message and part structures.
- Malformed delegate message objects that may have been accepted before are now rejected with `VALIDATION_ERROR`.
