---
'@aramisfa/openclaw-a2a-outbound': minor
---

Replace manual tool input validators with Ajv strict-mode compiled schemas in `@aramisfa/openclaw-a2a-outbound`.

- Added `ajv` and `ajv-formats` as direct dependencies.
- Introduced `ajv-validator.ts` with strict-mode Ajv factory and error helper.
- Replaced hand-written assertion/normalization functions in `schemas.ts` with Ajv-compiled validators.
- Added `format: "uri"` and `pattern: "^https?://"` constraints to `target.baseUrl` schema.
- Validation error `details` now carries `{ source: "ajv", tool, errors }` with native Ajv error objects instead of the previous `path`/`hint`/`expected`/`receivedType` shape.
