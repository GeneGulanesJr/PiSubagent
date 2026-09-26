import { describe, it, expect } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { execute } from '../src/dispatch.js';
import type { DispatchContext } from '../src/dispatch.js';
import { sumUsage } from '../src/dispatch/internal.js';
import type { AgentRunner } from '../src/runner/runner.js';
import type { AgentConfig, SingleResult, UsageStats } from '../src/types.js';

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

function usage(partial: Partial<UsageStats>): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
    ...partial,
  };
}
function result(u: UsageStats, text = 'ok'): SingleResult {
  return {
    agent: 'a',
    agentSource: 'user',
    task: 't',
    exitCode: 0,
    messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] as unknown as Message[],
    stderr: '',
    usage: u,
  };
}
function stubRunner(results: SingleResult[]): AgentRunner {
  let i = 0;
  return { id: 'subprocess', run: async () => results[Math.min(i++, results.length - 1)] };
}

describe('sumUsage', () => {
  it('sums counters and takes the max of contextTokens (gauge, not counter)', () => {
    const total = sumUsage([
      result(usage({ input: 10, output: 2, contextTokens: 500, turns: 1, cost: 0.5 })),
      result(usage({ input: 32, output: 5, contextTokens: 300, turns: 2, cost: 0.25 })),
    ]);
    expect(total.input).toBe(42);
    expect(total.output).toBe(7);
    expect(total.contextTokens).toBe(500);
    expect(total.turns).toBe(3);
    expect(total.cost).toBe(0.75);
    expect(total.cacheRead).toBe(0);
    expect(total.cacheWrite).toBe(0);
  });

  it('returns all zeros for an empty result list', () => {
    const total = sumUsage([]);
    expect(total).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    });
  });
});

describe('aggregate usage in SubagentDetails', () => {
  it('parallel dispatch rolls up usage across results', async () => {
    const runner = stubRunner([
      result(usage({ input: 10, turns: 1, contextTokens: 100 })),
      result(usage({ input: 20, turns: 1, contextTokens: 400 })),
    ]);
    const out = await execute(
      {
        tasks: [
          { agent: 'a', task: 't1' },
          { agent: 'a', task: 't2' },
        ],
      },
      ctx,
      [agent],
      runner,
    );
    expect(out.details?.usage).toBeDefined();
    expect(out.details?.usage?.input).toBe(30);
    expect(out.details?.usage?.contextTokens).toBe(400);
    expect(out.details?.usage?.turns).toBe(2);
  });

  it('chain dispatch rolls up usage on short-circuit failure', async () => {
    const failed: SingleResult = {
      ...result(usage({ input: 7, turns: 1 }), 'boom'),
      exitCode: 1,
      stopReason: 'error',
      errorMessage: 'boom',
    };
    const runner = stubRunner([failed]);
    const out = await execute(
      {
        chain: [
          { agent: 'a', task: 's1', retries: 0 },
          { agent: 'a', task: 's2' },
        ],
      },
      ctx,
      [agent],
      runner,
    );
    expect(out.isError).toBe(true);
    expect(out.details?.usage).toBeDefined();
    expect(out.details?.usage?.input).toBe(7);
  });

  it('chain dispatch rolls up usage across all steps on success', async () => {
    const runner = stubRunner([
      result(usage({ input: 5, turns: 1 })),
      result(usage({ input: 6, turns: 2 })),
    ]);
    const out = await execute(
      {
        chain: [
          { agent: 'a', task: 's1' },
          { agent: 'a', task: 's2' },
        ],
      },
      ctx,
      [agent],
      runner,
    );
    expect(out.details?.usage?.input).toBe(11);
  });

  it('single dispatch has no aggregate usage', async () => {
    const runner = stubRunner([result(usage({ input: 9 }))]);
    const out = await execute({ agent: 'a', task: 't' }, ctx, [agent], runner);
    expect(out.details?.usage).toBeUndefined();
  });
});
