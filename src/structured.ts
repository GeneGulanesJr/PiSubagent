import type { Message } from '@earendil-works/pi-ai';
import { getFinalOutput } from './output.js';
import type { SingleResult } from './types.js';

/**
 * Structured output (v1): prompt-side contract + post-run extraction.
 *
 * The child model is instructed to reply with pure JSON matching the
 * caller's JSON Schema. After the run, the final assistant text is
 * fence-stripped, parsed, and lightly validated (top-level `type`,
 * `required` keys, per-property `type` when declared). Full JSON-Schema
 * validation is deliberately out of scope for v1 — no new dependency,
 * no TypeBox-Value assumptions about unkinded schemas.
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

/** Strip optional markdown fences (```json ... ``` or ``` ... ```). */
function stripFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const body = trimmed.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '').replace(/```\s*$/, '');
  return body.trim();
}

/** Minimal type check: does `value` satisfy a JSON-Schema `type` string? */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true; // unknown/unrepresented keywords pass in v1
  }
}

/**
 * Light validation against the caller's schema. Returns an error string on
 * the first violation, or null when the value passes. Only checks the
 * schema's `type`, `required`, and per-property `type` — everything else
 * is v2 territory (full JSON-Schema validation).
 */
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
): string | null {
  if (typeof schema.type === 'string' && !matchesType(value, schema.type)) {
    return `type mismatch: expected ${schema.type}`;
  }
  if (schema.type === 'object' || typeof value === 'object') {
    const required = Array.isArray(schema.required) ? schema.required : [];
    const props =
      typeof schema.properties === 'object' && schema.properties !== null
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {};
    const obj = (value ?? {}) as Record<string, unknown>;
    for (const key of required) {
      // Object.hasOwn: `key in obj` would match Object.prototype props
      // ('toString', 'constructor'), letting required keys pass vacuously.
      if (!Object.hasOwn(obj, key) || obj[key] === undefined) {
        return `missing required property: ${key}`;
      }
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (
        obj[key] !== undefined &&
        typeof propSchema?.type === 'string' &&
        !matchesType(obj[key], propSchema.type)
      ) {
        return `property ${key}: expected ${propSchema.type}`;
      }
    }
  }
  return null;
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
