/**
 * Is a connected tool's input schema valid JSON Schema?
 *
 * AI clients ask this question themselves, and when the answer is no they drop
 * the tool WITHOUT SAYING SO: the tool is simply missing for the agent, with
 * nothing in Hexis to look at. So Hexis asks it first, when a server's tools
 * are loaded, and keeps such a tool off every agent surface with a marker the
 * server's owner can read.
 *
 * The check is the JSON Schema META-SCHEMA (2020-12, the draft the MCP
 * specification names), run by `ajv` — the same validator the MCP SDK and the
 * clients use, so a tool is hidden on exactly the violations a client would
 * also refuse, and the reason is quoted in the words the client reports. The
 * three refusals this started from reproduce to the character:
 *
 *   /properties/…/socialLinks/items/anyOf  must be an array
 *   /properties/…/value/anyOf/0/required/0 must be a string
 *   /properties/…/value/properties/table/type  must be equal to one of the allowed values
 *
 * NOT a repair. Nothing here rewrites a schema — the proxy passes a connected
 * server's schema through as sent, and an invalid one is reported, never fixed.
 */

import Ajv2020 from 'ajv/dist/2020.js';

/** Where a schema is not valid JSON Schema, and why. */
export interface SchemaDefect {
  /** JSON Pointer into the schema, e.g. `/properties/value/required/0`. */
  path: string;
  /** The violation in the validator's own words, e.g. `must be a string`. */
  reason: string;
}

/**
 * One validator for the process. `strict: false` keeps this to the
 * meta-schema: ajv's strict mode objects to things no client refuses (an
 * unknown keyword, a `required` naming an undeclared property), and hiding a
 * tool that works is worse than listing one whose schema is merely unusual.
 */
const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });

/**
 * The first place `schema` is not valid JSON Schema, or `null` when it is.
 *
 * FAIL-OPEN: a schema the validator itself cannot process (an unknown
 * `$schema` dialect, say) is reported as having no defect. A validator fault
 * is not evidence against the tool, and the cost of being wrong here is one
 * tool hidden from every agent.
 */
export function inputSchemaDefect(schema: unknown): SchemaDefect | null {
  // MCP requires an OBJECT input schema. `true`/`false` are legal JSON Schema
  // but not legal here, and an array or a string is neither.
  if (schema === undefined || schema === null) return null; // absent: `toListedTool` supplies `{}`
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    return { path: '/', reason: 'must be an object' };
  }
  let valid: boolean;
  try {
    valid = ajv.validateSchema(schema) as boolean;
  } catch {
    return null;
  }
  if (valid) return null;
  const first = ajv.errors?.[0];
  if (!first) return null;
  return {
    path: first.instancePath || '/',
    reason: withArticle(first.message ?? 'is not valid JSON Schema'),
  };
}

/**
 * The sentence the tool's owner reads, wherever the marker is shown — the tool
 * setup page and `list_tool_setup` say the same thing in the same words,
 * because they are the same finding.
 */
export function schemaDefectMarker(defect: SchemaDefect): string {
  return `Hidden from agents: its schema is invalid at ${defect.path} (${defect.reason}).`;
}

/** ajv says `must be string`; a sentence a person reads says `must be a string`. */
function withArticle(message: string): string {
  return message.replace(
    /^must be (array|boolean|integer|null|number|object|string)$/,
    (_full, type: string) => `must be a${/^[aeiou]/.test(type) ? 'n' : ''} ${type}`,
  );
}
