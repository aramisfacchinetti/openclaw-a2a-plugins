import { Ajv } from "ajv";
import type { ErrorObject } from "ajv";
import _addFormats from "ajv-formats";
import { A2AOutboundError, ERROR_CODES } from "./errors.js";

export type { ErrorObject } from "ajv";

export function createA2AOutboundAjv(): InstanceType<typeof Ajv> {
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    strictSchema: true,
    strictTypes: true,
    strictTuples: true,
    strictRequired: false,
    strictNumbers: true,
    allowUnionTypes: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });

  (_addFormats as unknown as (ajv: InstanceType<typeof Ajv>) => void)(ajv);

  return ajv;
}

export function toValidationError(
  toolName: string,
  errors: ErrorObject[],
): never {
  throw new A2AOutboundError(
    ERROR_CODES.VALIDATION_ERROR,
    `${toolName} input validation failed`,
    {
      source: "ajv",
      tool: toolName,
      errors,
    },
  );
}
