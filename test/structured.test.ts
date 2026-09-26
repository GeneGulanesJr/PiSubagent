import { describe, it, expect } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { execute } from '../src/dispatch.js';
import {
  buildStructuredInstruction,
  extractStructured,
  applyStructured,
  validateAgainstSchema,
} from '../src/structured.js';
import type { AgentRunner } from '../src/runner/runner.js';
import type { AgentConfig, SingleResult } from '../src/types.js';
import type { DispatchContext } from '../src/dispatch/types.js';

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
} as const;

function msgs(text: string): Message[] {
  return [{ role: 'assistant', content: [{ type: 'text', text }] }] as unknown as Message[];
}
function baseResult(text: string): SingleResult {
  return {
    agent: 'a',
    agentSource: 'user',
    task: 't',
    exitCode: 0,
    messages: msgs(text),
    stderr: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 1,
    },
  };
}
const agent: AgentConfig = {
  name: 'a',
  description: '',
  systemPrompt: '',
  source: 'bundled',
  filePath: '',
};
const ctx = {
  cwd: '/tmp',
  hasUI: false,
  isProjectTrusted: () => true,
  ui: { confirm: async () => true },
} as DispatchContext;
function textRunner(text: string): AgentRunner {
  return { id: 'subprocess', run: async () => baseResult(text) };
}

describe('buildStructuredInstruction', () => {
  it('includes the stringified schema and the words JSON and ONLY', () => {
    const instruction = buildStructuredInstruction(schema);
    expect(instruction).toContain(JSON.stringify(schema));
    expect(instruction).toContain('JSON');
    expect(instruction).toContain('ONLY');
  });
});

describe('extractStructured', () => {
  it('passes plain JSON', () => {
    const r = extractStructured(msgs('{"answer":"yes"}'), schema);
    expect(r.data).toEqual({ answer: 'yes' });
    expect(r.structuredError).toBeUndefined();
  });

  it('strips ```json fences', () => {
    const r = extractStructured(msgs('```json\n{"answer":"yes"}\n```'), schema);
    expect(r.data).toEqual({ answer: 'yes' });
    expect(r.structuredError).toBeUndefined();
  });

  it('strips plain ``` fences', () => {
    const r = extractStructured(msgs('```\n{"answer":"yes"}\n```'), schema);
    expect(r.data).toEqual({ answer: 'yes' });
    expect(r.structuredError).toBeUndefined();
  });

  it('reports JSON parse failure for invalid JSON', () => {
    const r = extractStructured(msgs('totally not json'), schema);
    expect(r.structuredError).toContain('JSON parse failed');
  });

  it('reports missing final assistant text when empty', () => {
    const r = extractStructured(msgs(''), schema);
    expect(r.structuredError).toContain('no final assistant text');
  });

  it('reports top-level type mismatch', () => {
    const r = extractStructured(msgs('[]'), { type: 'object' });
    expect(r.structuredError).toContain('type mismatch: expected object');
  });

  it('reports missing required property', () => {
    const r = extractStructured(msgs('{"wrong":1}'), schema);
    expect(r.structuredError).toContain('missing required property: answer');
  });

  it('reports property type mismatch', () => {
    const r = extractStructured(msgs('{"answer":42}'), schema);
    expect(r.structuredError).toContain('property answer: expected string');
  });
});

describe('validateAgainstSchema', () => {
  it('returns null for valid values and permissive schemas', () => {
    expect(validateAgainstSchema({ answer: 'yes' }, schema)).toBeNull();
    expect(validateAgainstSchema({}, {})).toBeNull();
  });
});

describe('applyStructured', () => {
  it('returns a copy with data set, original untouched', () => {
    const original = baseResult('{"answer":"yes"}');
    const copy = applyStructured(original, schema);
    expect(copy).not.toBe(original);
    expect(copy.data).toEqual({ answer: 'yes' });
    expect(copy.structuredError).toBeUndefined();
    expect(original).not.toHaveProperty('data');
  });
});

describe('dispatch wiring — outputSchema', () => {
  it('populates data and restores the original task on success', async () => {
    const out = await execute(
      { agent: 'a', task: 't', outputSchema: schema },
      ctx,
      [agent],
      textRunner('{"answer":"yes"}'),
    );
    expect(out.isError).toBe(false);
    expect(out.details.results[0].data).toEqual({ answer: 'yes' });
    expect(out.details.results[0].task).toBe('t');
  });

  it('surfaces structuredError without failing dispatch', async () => {
    const out = await execute(
      { agent: 'a', task: 't', outputSchema: schema },
      ctx,
      [agent],
      textRunner('totally not json'),
    );
    expect(out.details.results[0].structuredError).toBeDefined();
    expect(out.isError).toBe(false);
    expect(out.details.results[0].data).toBeUndefined();
  });

  it('leaves data and structuredError absent when outputSchema is omitted', async () => {
    const out = await execute(
      { agent: 'a', task: 't' },
      ctx,
      [agent],
      textRunner('{"answer":"yes"}'),
    );
    const r = out.details.results[0];
    expect('data' in r).toBe(false);
    expect('structuredError' in r).toBe(false);
  });
});
