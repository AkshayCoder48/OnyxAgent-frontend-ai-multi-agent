/**
 * Tool argument schema validation (PRD Issue 4 / Test A).
 *
 * WHY THIS EXISTS: tool definitions carry a `parameters` JSON-Schema the
 * MODEL uses to construct arguments — but nothing ever checked the args
 * the model ACTUALLY sent. Observed failures (the imagedescriber incident,
 * 2026-11-28): the model issued use_browser calls with an empty command
 * field, terminal calls with a missing command, and acknowledged the
 * malformed calls — then re-issued NEARLY identical ones, round after
 * round, each failing the same way inside the handler with an unstructured
 * `"error: ..."` string the model could not systematically correct.
 *
 * THE CONTRACT:
 *   1. Validation runs BEFORE dispatch — a call with invalid arguments is
 *      NEVER executed and NEVER counted as executed evidence.
 *   2. The refusal is a STRUCTURED tool result (the INVALID_ARGUMENTS
 *      shape from the PRD) through the normal tool-result protocol — a
 *      validation failure is a tool result, never a provider error.
 *   3. The error names the EXACT field and what is wrong, so the model
 *      can fix the call in one round instead of guessing.
 *
 * This is deliberately a JSON-schema-LITE validator: it checks the
 * keywords our tool definitions actually use (required / type / enum /
 * minLength / items / properties). It never throws on exotic keywords —
 * unknown keywords are ignored, a schema that can't be read validates
 * true (tools with hand-rolled `parameters` objects must keep working).
 */

export interface ArgValidationIssue {
  code: string;
  field: string;
  message: string;
}

export interface ArgValidationResult {
  valid: boolean;
  /** First issue only — the structured INVALID_ARGUMENTS payload carries
   *  one actionable error, not a wall of them. */
  issue?: ArgValidationIssue;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function expectedType(schema: unknown): string {
  const t = (schema as { type?: unknown }).type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.filter((x) => typeof x === "string").join(" | ");
  return "unknown";
}

function typeMatches(value: unknown, schemaType: string): boolean {
  const actual = typeOf(value);
  switch (schemaType) {
    case "string":
      return actual === "string";
    case "number":
      return actual === "number" || actual === "integer";
    case "integer":
      return actual === "integer";
    case "boolean":
      return actual === "boolean";
    case "array":
      return actual === "array";
    case "object":
      return actual === "object";
    case "null":
      return actual === "null";
    default:
      // Unknown/compound type keyword — not our business to enforce.
      return true;
  }
}

/** Validate one value against one property schema. Returns the first
 *  issue found, or undefined when the value passes. */
function checkProperty(
  field: string,
  value: unknown,
  schema: Record<string, unknown>,
): ArgValidationIssue | undefined {
  const declaredType = schema.type;
  if (typeof declaredType === "string" && !typeMatches(value, declaredType)) {
    return {
      code: "INVALID_TYPE",
      field,
      message: `Field '${field}' must be of type ${declaredType} (got ${typeOf(value)}).`,
    };
  }
  // Union types: ["string", "object"] — pass when ANY member matches.
  if (Array.isArray(declaredType)) {
    const ok = declaredType.some((t) => typeof t === "string" && typeMatches(value, t));
    if (!ok) {
      return {
        code: "INVALID_TYPE",
        field,
        message: `Field '${field}' must be one of types ${expectedType(schema)} (got ${typeOf(value)}).`,
      };
    }
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (!schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
      return {
        code: "INVALID_VALUE",
        field,
        message: `Field '${field}' must be one of: ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}.`,
      };
    }
  }
  if (typeof schema.minLength === "number" && typeof value === "string") {
    if (value.trim().length < schema.minLength) {
      return {
        code: "MISSING_REQUIRED_FIELD",
        field,
        message: `Field '${field}' must be a non-empty string (got whitespace/empty).`,
      };
    }
  }
  if (Array.isArray(schema.items) && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const itemSchema = schema.items[i];
      if (itemSchema && typeof itemSchema === "object") {
        const issue = checkProperty(`${field}[${i}]`, value[i], itemSchema as Record<string, unknown>);
        if (issue) return issue;
      }
    }
  } else if (
    schema.items &&
    typeof schema.items === "object" &&
    !Array.isArray(schema.items) &&
    Array.isArray(value)
  ) {
    // Uniform item type: { items: { type: "string" } }
    for (let i = 0; i < value.length; i++) {
      const issue = checkProperty(`${field}[${i}]`, value[i], schema.items as Record<string, unknown>);
      if (issue) return issue;
    }
  }
  return undefined;
}

/**
 * Validate tool-call arguments against the tool's `parameters` schema.
 * Returns `{ valid: true }` when the args pass, or the first issue. Args
 * that are not a plain object are rejected outright (the function-calling
 * protocol always sends an object).
 */
export function validateToolArgs(
  args: Record<string, unknown> | null | undefined,
  parameters: Record<string, unknown> | null | undefined,
): ArgValidationResult {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {
      valid: false,
      issue: {
        code: "MISSING_REQUIRED_FIELD",
        field: "arguments",
        message: "Tool arguments must be a JSON object.",
      },
    };
  }
  // No schema / unreadable schema — nothing to enforce (back-compat for
  // hand-rolled `parameters` objects in dynamic/MCP tools).
  if (!parameters || typeof parameters !== "object") return { valid: true };
  const props = (parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(parameters.required) ? parameters.required : [];

  // 1. Required fields must be present AND non-empty (an empty string /
  //    null / undefined command is the observed "empty command field"
  //    failure — present but useless must fail the same as missing).
  for (const rawName of required) {
    const name = String(rawName);
    const value = (args as Record<string, unknown>)[name];
    if (value === undefined || value === null || value === "") {
      return {
        valid: false,
        issue: {
          code: "MISSING_REQUIRED_FIELD",
          field: name,
          message: `The ${name} argument is required${value === "" ? " (it was sent as an empty string)" : ""}.`,
        },
      };
    }
    if (typeof value === "string" && value.trim() === "") {
      return {
        valid: false,
        issue: {
          code: "MISSING_REQUIRED_FIELD",
          field: name,
          message: `The ${name} argument is required (it was sent as whitespace only).`,
        },
      };
    }
  }
  // 2. Present fields must match their declared property schema.
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const schema = props[name];
    if (!schema || typeof schema !== "object") continue;
    const issue = checkProperty(name, value, schema);
    if (issue) return { valid: false, issue };
  }
  return { valid: true };
}

/** Build the structured INVALID_ARGUMENTS tool-result payload (the PRD
 *  §Issue-4 example shape). `example` carries a minimal corrected-args
 *  hint derived from the schema so the model can fix the call in one
 *  round. */
export function invalidArgumentsResult(
  toolName: string,
  issue: ArgValidationIssue,
  parameters: Record<string, unknown> | null | undefined,
): { error: { code: string; field: string; message: string; tool: string; hint: string } } {
  const props = (parameters?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const example: Record<string, unknown> = {};
  const required = Array.isArray(parameters?.required) ? parameters!.required.map(String) : [];
  for (const name of required) {
    const schema = props[name];
    if (!schema) continue;
    if (typeof schema.type === "string" && schema.type === "string") {
      if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        example[name] = schema.enum[0];
      } else {
        example[name] = `<${name}>`;
      }
    } else if (typeof schema.type === "string" && schema.type === "number") {
      example[name] = 1;
    } else if (typeof schema.type === "string" && schema.type === "integer") {
      example[name] = 1;
    } else if (typeof schema.type === "string" && schema.type === "boolean") {
      example[name] = true;
    } else if (Array.isArray(schema.type)) {
      example[name] = `<${name}>`;
    } else if (Array.isArray(schema.items)) {
      example[name] = [];
    }
  }
  return {
    error: {
      code: issue.code === "MISSING_REQUIRED_FIELD" ? "MISSING_REQUIRED_FIELD" : "INVALID_ARGUMENTS",
      field: issue.field,
      tool: toolName,
      message: issue.message + " The call was NOT executed. Re-issue the call with corrected arguments — do not repeat it unchanged.",
      hint:
        Object.keys(example).length > 0
          ? `Required arguments for ${toolName}: ${JSON.stringify(example)}`
          : `Check the tool's argument schema for ${toolName}.`,
    },
  };
}
