import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { execute } from '../src/dispatch.js';
import { runWithRetries } from '../src/dispatch/internal.js';
import type { AgentRunner, AgentRunInput } from '../src/runner/runner.js';
import type { AgentConfig, SingleResult } from '../src/types.js';
import type { DispatchContext } from '../src/dispatch/types.js';

const baseAgent: AgentConfig = {
  name: 'a',
  description: '',
  systemPrompt: '',
  source: 'bundled',
  filePath: '',
};
const baseInput: AgentRunInput = { agent: baseAgent, task: 't', cwd: '/tmp' };

function okResult(agent = 'a', text = 'ok'): SingleResult {
  return {
    agent,
    agentSource: 'user',
    task: 't',
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
  };
}
function failResult(agent = 'a'): SingleResult {
  return { ...okResult(agent, 'boom'), exitCode: 1, stopReason: 'error', errorMessage: 'boom' };
}
function ctxWith(signal?: AbortSignal): DispatchContext {
  return {
    cwd: '/tmp',
    hasUI: false,
    isProjectTrusted: () => true,
    ui: { confirm: async () => true },
    signal,
  } as DispatchContext;
}
/** Stub runner whose run() pops the next scripted result per call. */
function scriptRunner(script: Array<() => SingleResult>, calls: AgentRunInput[] = []): AgentRunner {
  let i = 0;
  return {
    id: 'subprocess',
    run: vi.fn(async (input: AgentRunInput) => {
      calls.push(input);
      return script[Math.min(i++, script.length - 1)]();
    }),
  };
}
/** Read the runtime `attempts` annotation without depending on it being declared on SingleResult. */
function attemptsOf(result: SingleResult | undefined): number | undefined {
  return (result as { attempts?: number } | undefined)?.attempts;
}

describe('runWithRetries', () => {
  it('retries a failed run then succeeds', async () => {
    const calls: AgentRunInput[] = [];
    const runner = scriptRunner([() => failResult(), () => okResult()], calls);
    const result = await runWithRetries(runner, baseInput, ctxWith(), 2);
    expect(result.exitCode).toBe(0);
    expect(attemptsOf(result)).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('marks the result as failed after all attempts are exhausted', async () => {
    const calls: AgentRunInput[] = [];
    const runner = scriptRunner([() => failResult()], calls);
    const result = await runWithRetries(runner, baseInput, ctxWith(), 2);
    expect(calls).toHaveLength(3);
    expect(attemptsOf(result)).toBe(3);
    expect(result.exitCode).toBe(1);
  });

  it('runs exactly once and omits attempts when retries is undefined', async () => {
    const calls: AgentRunInput[] = [];
    const runner = scriptRunner([() => failResult(), () => okResult()], calls);
    const result = await runWithRetries(runner, baseInput, ctxWith(), undefined);
    expect(calls).toHaveLength(1);
    expect('attempts' in result).toBe(false);
  });

  it('clamps retries above the maximum to 3 retries (4 runs total)', async () => {
    const calls: AgentRunInput[] = [];
    const runner = scriptRunner([() => failResult()], calls);
    await runWithRetries(runner, baseInput, ctxWith(), 10);
    expect(calls).toHaveLength(4);
  });

  it('skips the retry when the signal is already aborted', async () => {
    const calls: AgentRunInput[] = [];
    const controller = new AbortController();
    controller.abort();
    const runner = scriptRunner([() => failResult()], calls);
    const result = await runWithRetries(runner, baseInput, ctxWith(controller.signal), 3);
    expect(calls).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  it('never retries a successful result', async () => {
    const calls: AgentRunInput[] = [];
    const runner = scriptRunner([() => okResult()], calls);
    const result = await runWithRetries(runner, baseInput, ctxWith(), 3);
    expect(calls).toHaveLength(1);
    expect('attempts' in result).toBe(false);
  });
});

describe('dispatch retries pass-through', () => {
  const agents = [baseAgent];

  it('single: retries a failed run and reports attempts', async () => {
    const calls: AgentRunInput[] = [];
    const runner = scriptRunner([() => failResult(), () => okResult()], calls);
    const out = await execute({ agent: 'a', task: 't', retries: 1 }, ctxWith(), agents, runner);
    expect(out.isError).toBe(false);
    expect(calls).toHaveLength(2);
    expect(attemptsOf(out.details.results[0])).toBe(2);
    expect(JSON.stringify(out.details.results[0].messages)).toContain('ok');
  });

  it('chain: recovers a failed step then continues to the next', async () => {
    const calls: AgentRunInput[] = [];
    const runner = scriptRunner(
      [() => failResult(), () => okResult('a', 's1 fixed'), () => okResult('a', 's2 done')],
      calls,
    );
    const out = await execute(
      {
        chain: [
          { agent: 'a', task: 's1', retries: 1 },
          { agent: 'a', task: 's2' },
        ],
      },
      ctxWith(),
      agents,
      runner,
    );
    expect(out.isError).toBe(false);
    expect(out.details.results).toHaveLength(2);
    expect(JSON.stringify(out.details.results[1].messages)).toContain('s2 done');
  });

  it('chain: exhausted retries short-circuit the remaining steps', async () => {
    const calls: AgentRunInput[] = [];
    const runner = scriptRunner([() => failResult()], calls);
    const out = await execute(
      {
        chain: [
          { agent: 'a', task: 's1', retries: 1 },
          { agent: 'a', task: 's2' },
        ],
      },
      ctxWith(),
      agents,
      runner,
    );
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).toContain('Chain stopped at step 1');
    expect(out.details.results).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('parallel: retries only the task that failed', async () => {
    const calls: AgentRunInput[] = [];
    let t2Runs = 0;
    const runner: AgentRunner = {
      id: 'subprocess',
      run: vi.fn(async (input: AgentRunInput) => {
        calls.push(input);
        if (input.task === 't2' && ++t2Runs === 1) return { ...failResult(), task: 't2' };
        return { ...okResult('a', `ok ${input.task}`), task: input.task };
      }),
    };
    const out = await execute(
      {
        tasks: [
          { agent: 'a', task: 't1' },
          { agent: 'a', task: 't2', retries: 2 },
        ],
      },
      ctxWith(),
      agents,
      runner,
    );
    expect(out.isError).toBe(false);
    expect(out.details.results).toHaveLength(2);
    expect(calls).toHaveLength(3);
    const t2 = out.details.results.find((r) => r.task === 't2');
    expect(t2?.exitCode).toBe(0);
    expect(attemptsOf(t2)).toBe(2);
  });
});
