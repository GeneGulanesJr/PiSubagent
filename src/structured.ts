import type { Message } from '@earendil-works/pi-ai';
// Named import: under NodeNext + "type": "module", ajv (a CJS package)
// resolves a default import to the module namespace, which isn't
// constructable — but its bundle also exports the class as `Ajv`.
import { Ajv } from 'ajv';
import { getFinalOutput } from './output.js';
import type { SingleResult } from './types.js';

/**
 * Structured output (v1): prompt-side contract + post-run extraction.
 *
 * The child model is instructed to reply with pure JSON matching the
 * caller's JSON Schema. After the run, the final assistant text is
 * fence-stripped, parsed, and validated against the full JSON Schema
 * via ajv (strict: false).
 */

/** Prompt suffix instructing the child to emit pure JSON. */
export function buildStructuredInstruction(schema: object): string {
  return [
    '',
    'IMPORTANT — structured output contract:',
    'Respond with ONLY a single JSON value that satisfies this JSON Schema.',
    'No prose, no markdown fences, no commentary — the reply must be machine-parseable.',
    'Schema:',
    JSON.stringify(schema),
  ].join('\n');
}

/** Append the structured-output instruction when a schema is present. */
export function withStructuredInstruction(task: string, schema?: Record<string, unknown>): string {
  return schema ? `${task}\n\n${buildStructuredInstruction(schema)}` : task;
}

/** Strip optional markdown fences (```json ... ``` or ``` ... ```). */
function stripFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const body = trimmed.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '').replace(/```\s*$/, '');
  return body.trim();
}

/**
 * Full JSON-Schema validation via ajv. Returns the first violation as
 * `<instancePath> <message>` (empty instancePath → just the message),
 * or null when the value passes. `ownProperties` keeps prototype-chain
 * keys (e.g. 'toString') from satisfying `required` — Object.hasOwn
 * semantics. Malformed schemas (invalid keyword values, wrong shapes)
 * degrade to a schema-error string — never a thrown exception, so a bad
 * `outputSchema` cannot crash a dispatch after the child already ran.
 * `strict: 'log'` warns on unknown keywords (typo protection) without
 * rejecting schemas that use dialect extensions.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
): string | null {
  const ajv = new Ajv({ strict: 'log', allErrors: false, ownProperties: true });
  let validate: Ajv.ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    return `invalid schema: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (validate(value)) return null;
  const err = validate.errors?.[0];
  if (!err?.message) return 'validation failed';
  return err.instancePath ? `${err.instancePath} ${err.message}` : err.message;
}

export interface StructuredExtraction {
  data?: unknown;
  structuredError?: string;
}

/** Extract + validate the structured value from final assistant text. */
export function extractStructured(
  messages: Message[],
  schema: Record<string, unknown>,
): StructuredExtraction {
  const text = getFinalOutput(messages);
  if (!text || !text.trim()) {
    return { structuredError: 'structured output: no final assistant text' };
  }
  let value: unknown;
  try {
    value = JSON.parse(stripFences(text));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { structuredError: `structured output: JSON parse failed: ${msg}` };
  }
  const violation = validateAgainstSchema(value, schema);
  if (violation) return { structuredError: `structured output: schema violation: ${violation}` };
  return { data: value };
}

/** Return a copy of result with data/structuredError populated. */
export function applyStructured(
  result: SingleResult,
  schema: Record<string, unknown>,
): SingleResult {
  return { ...result, ...extractStructured(result.messages, schema) };
}
