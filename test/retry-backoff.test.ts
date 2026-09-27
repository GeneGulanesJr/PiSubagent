import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { runWithRetries, type RetryOptions } from '../src/dispatch/internal.js';
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
function timeoutFailResult(agent = 'a'): SingleResult {
  return {
    ...failResult(agent),
    timedOut: true,
    stopReason: 'timeout' as const,
    errorMessage: 'run timeout after 5ms',
  };
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
/**
 * Stub runner whose run() pops the next scripted result per call and records
 * a Date.now() timestamp for each invocation (real timers — no fake clocks).
 */
function scriptRunner(
  script: Array<() => SingleResult>,
  calls: AgentRunInput[] = [],
  stamps: number[] = [],
): AgentRunner {
  let i = 0;
  return {
    id: 'subprocess',
    run: vi.fn(async (input: AgentRunInput) => {
      calls.push(input);
      stamps.push(Date.now());
      return script[Math.min(i++, script.length - 1)]();
    }),
  };
}

describe('runWithRetries backoff + retryOn', () => {
  it('backoff delays grow exponentially across retries', async () => {
    const calls: AgentRunInput[] = [];
    const stamps: number[] = [];
    const runner = scriptRunner([() => failResult()], calls, stamps);
    await runWithRetries(runner, baseInput, ctxWith(), 2, undefined, { backoffMs: 40 });
    expect(calls).toHaveLength(3);
    const gap2 = stamps[1] - stamps[0]; // first retry waits the base (~40ms)
    const gap3 = stamps[2] - stamps[1]; // second retry waits 2× (~80ms)
    expect(gap2).toBeGreaterThanOrEqual(35);
    expect(gap3).toBeGreaterThanOrEqual(70);
  });

  it('no backoff retries immediately', async () => {
    const calls: AgentRunInput[] = [];
    const runner = scriptRunner([() => failResult()], calls);
    const start = Date.now();
    await runWithRetries(runner, baseInput, ctxWith(), 2, undefined, { backoffMs: undefined });
    const elapsed = Date.now() - start;
    expect(calls).toHaveLength(3);
    expect(elapsed).toBeLessThan(50);
  });

  it("retryOn ['timeout'] skips error-class failures", async () => {
    const calls: AgentRunInput[] = [];
    const runner = scriptRunner([() => failResult()], calls);
    const result = await runWithRetries(runner, baseInput, ctxWith(), 3, undefined, {
      retryOn: ['timeout'],
    });
    expect(calls).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  it("retryOn ['timeout'] retries timed-out failures", async () => {
    const calls: AgentRunInput[] = [];
    const runner = scriptRunner([() => timeoutFailResult()], calls);
    await runWithRetries(runner, baseInput, ctxWith(), 2, undefined, { retryOn: ['timeout'] });
    expect(calls).toHaveLength(3);
  });

  it('retryOn undefined (default) retries any failure class', async () => {
    const calls: AgentRunInput[] = [];
    const runner = scriptRunner([() => failResult()], calls);
    await runWithRetries(runner, baseInput, ctxWith(), 1, undefined, { retryOn: undefined });
    expect(calls).toHaveLength(2);
  });

  it("retryOn filter breaks before sleeping (error result + backoffMs + retryOn ['timeout'])", async () => {
    const calls: AgentRunInput[] = [];
    const runner = scriptRunner([() => failResult()], calls);
    const start = Date.now();
    const opts: RetryOptions = { backoffMs: 500, retryOn: ['timeout'] };
    await runWithRetries(runner, baseInput, ctxWith(), 3, undefined, opts);
    expect(calls).toHaveLength(1);
    // Filter short-circuits before the 500ms sleep — well under half of it.
    expect(Date.now() - start).toBeLessThan(250);
  });
});
