import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { execute } from '../src/dispatch.js';
import type { AgentRunner, AgentRunInput } from '../src/runner/runner.js';
import type { AgentConfig, SingleResult } from '../src/types.js';
import type { DispatchContext } from '../src/dispatch/types.js';

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

function resultFor(text: string): (input: AgentRunInput) => SingleResult {
  return (input) => ({
    agent: input.agent.name,
    agentSource: 'user',
    task: input.task,
    exitCode: 0,
    messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] as unknown as Message[],
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
  });
}

function recordingRunner(texts: string[], seen: AgentRunInput[]): AgentRunner {
  return {
    id: 'subprocess',
    run: vi.fn((input: AgentRunInput) => {
      seen.push(input);
      // Last text repeats once the scripted list is exhausted.
      const text = texts[Math.min(seen.length - 1, texts.length - 1)];
      return Promise.resolve(resultFor(text)(input));
    }),
  };
}

describe('per-item outputSchema (parallel)', () => {
  it('appends the instruction to the child task and lands data on the result', async () => {
    const seen: AgentRunInput[] = [];
    const runner = recordingRunner(['"ok"'], seen);
    const out = await execute(
      { tasks: [{ agent: 'a', task: 't1', outputSchema: { type: 'string' } }] },
      ctx,
      [agent],
      runner,
    );
    expect(out.isError).toBe(false);
    expect(out.details.results[0].data).toBe('ok');
    // Original task text is restored on the result (not the instructed one).
    expect(out.details.results[0].task).toBe('t1');
    // The child actually received the structured-output instruction.
    expect(seen[0].task).toContain('structured output contract');
  });

  it('leaves results untouched when an item has no outputSchema', async () => {
    const seen: AgentRunInput[] = [];
    const runner = recordingRunner(['plain'], seen);
    const out = await execute({ tasks: [{ agent: 'a', task: 't2' }] }, ctx, [agent], runner);
    expect(out.isError).toBe(false);
    expect(out.details.results[0]).not.toHaveProperty('data');
    expect(out.details.results[0]).not.toHaveProperty('structuredError');
    expect(seen[0].task).toBe('t2');
  });
});

describe('per-item outputSchema (chain)', () => {
  it('appends the instruction after {previous} substitution and lands data per step', async () => {
    const seen: AgentRunInput[] = [];
    const runner = recordingRunner(['"step1"', '"step2"'], seen);
    const out = await execute(
      {
        chain: [
          { agent: 'a', task: 's1', outputSchema: { type: 'string' } },
          { agent: 'a', task: 's2 use {previous}', outputSchema: { type: 'string' } },
        ],
      },
      ctx,
      [agent],
      runner,
    );
    expect(out.isError).toBe(false);
    expect(out.details.results[0].data).toBe('step1');
    expect(out.details.results[1].data).toBe('step2');
    expect(out.details.results[0].task).toBe('s1');
    expect(out.details.results[1].task).toBe('s2 use {previous}');
    // Second call: {previous} substituted AND instruction appended after it.
    expect(seen[1].resolvedTask).toContain('step1');
    expect(seen[1].resolvedTask).toContain('structured output contract');
  });

  it('treats a structured failure as non-fatal and keeps chaining', async () => {
    const seen: AgentRunInput[] = [];
    const runner = recordingRunner(['not json', '"fine"'], seen);
    const out = await execute(
      {
        chain: [
          { agent: 'a', task: 's1', outputSchema: { type: 'string' } },
          { agent: 'a', task: 's2', outputSchema: { type: 'string' } },
        ],
      },
      ctx,
      [agent],
      runner,
    );
    expect(out.isError).toBe(false);
    expect(out.details.results[0].structuredError).toBeDefined();
    // structuredError never flips dispatch isError; the chain continued.
    expect(out.details.results).toHaveLength(2);
    expect(out.details.results[1].data).toBe('fine');
  });
});

describe('top-level outputSchema guard', () => {
  it('rejects top-level outputSchema on parallel dispatch with the updated message', async () => {
    const out = await execute(
      { tasks: [{ agent: 'a', task: 't' }], outputSchema: { type: 'object' } },
      ctx,
      [agent],
    );
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('per item in tasks/chain');
  });
});
