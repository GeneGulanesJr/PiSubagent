import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { execute } from '../src/dispatch.js';
import type { AgentRunner, AgentRunInput } from '../src/runner/runner.js';
import type { AgentConfig, SingleResult } from '../src/types.js';
import type { DispatchContext } from '../src/dispatch/types.js';

/**
 * Issue #2 part 1 — chain-mode circuit breaker: configurable consecutive-
 * failure threshold (default 1 = stop at the first failure), skipped steps
 * reported as skipped_due_to_open_circuit, tolerated failures never feed
 * {previous} into the next step.
 */

const baseAgent: AgentConfig = {
  name: 'a',
  description: '',
  systemPrompt: '',
  source: 'bundled',
  filePath: '',
};

function okResult(text: string, task = 't'): SingleResult {
  return {
    agent: 'a',
    agentSource: 'user',
    task,
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
function failResult(task = 't'): SingleResult {
  return { ...okResult('boom', task), exitCode: 1, stopReason: 'error', errorMessage: 'boom' };
}
function ctxWith(): DispatchContext {
  return {
    cwd: '/tmp',
    hasUI: false,
    isProjectTrusted: () => true,
    ui: { confirm: async () => true },
  } as DispatchContext;
}

/** Stub runner that maps a task to a scripted outcome, recording every call. */
function taskRunner(script: Record<string, () => SingleResult>, calls: AgentRunInput[] = []) {
  return {
    id: 'subprocess',
    run: vi.fn(async (input: AgentRunInput) => {
      calls.push(input);
      const scriptFn = script[input.task];
      return scriptFn ? scriptFn() : okResult('ok');
    }),
  } as unknown as AgentRunner;
}

describe('chain circuit breaker (issue #2)', () => {
  const agents = [baseAgent];

  it('default threshold 1: first failure stops the chain and reports skipped steps', async () => {
    const calls: AgentRunInput[] = [];
    const runner = taskRunner({ s1: () => failResult('s1') }, calls);
    const out = await execute(
      {
        chain: [
          { agent: 'a', task: 's1' },
          { agent: 'a', task: 's2' },
          { agent: 'a', task: 's3' },
        ],
      },
      ctxWith(),
      agents,
      runner,
    );

    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).toContain('Chain stopped at step 1');
    expect(JSON.stringify(out)).toContain('skipped_due_to_open_circuit');
    expect(out.details.results).toHaveLength(3);
    expect(out.details.results[1].stopReason).toBe('skipped_due_to_open_circuit');
    expect(out.details.results[2].stopReason).toBe('skipped_due_to_open_circuit');
    expect(out.details.circuitBreaker).toEqual({
      threshold: 1,
      consecutiveFailures: 1,
      stoppedAtStep: 1,
      skippedSteps: 2,
    });
    expect(calls).toHaveLength(1);
  });

  it('threshold 2: two consecutive failures stop the chain, rest skipped', async () => {
    const calls: AgentRunInput[] = [];
    const runner = taskRunner({ s1: () => failResult('s1'), s2: () => failResult('s2') }, calls);
    const out = await execute(
      {
        chainFailureThreshold: 2,
        chain: [
          { agent: 'a', task: 's1' },
          { agent: 'a', task: 's2' },
          { agent: 'a', task: 's3' },
          { agent: 'a', task: 's4' },
        ],
      },
      ctxWith(),
      agents,
      runner,
    );

    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).toContain('Chain stopped at step 2');
    expect(out.details.results).toHaveLength(4);
    expect(out.details.results[2].stopReason).toBe('skipped_due_to_open_circuit');
    expect(out.details.results[3].stopReason).toBe('skipped_due_to_open_circuit');
    expect(out.details.circuitBreaker).toEqual({
      threshold: 2,
      consecutiveFailures: 2,
      stoppedAtStep: 2,
      skippedSteps: 2,
    });
    expect(calls).toHaveLength(2);
  });

  it('threshold 2: an isolated failure followed by success does not trip', async () => {
    const calls: AgentRunInput[] = [];
    const runner = taskRunner(
      {
        s1: () => failResult('s1'),
        s2: () => okResult('recovered', 's2'),
        s3: () => okResult('done', 's3'),
      },
      calls,
    );
    const out = await execute(
      {
        chainFailureThreshold: 2,
        chain: [
          { agent: 'a', task: 's1' },
          { agent: 'a', task: 's2' },
          { agent: 'a', task: 's3' },
        ],
      },
      ctxWith(),
      agents,
      runner,
    );

    expect(out.isError).toBe(false);
    expect(out.details.results).toHaveLength(3);
    expect(out.details.circuitBreaker).toBeUndefined();
    expect(calls).toHaveLength(3);
  });

  it('a tolerated failure never feeds {previous} — the next step gets the last good output', async () => {
    const calls: AgentRunInput[] = [];
    const runner = taskRunner(
      {
        s1: () => okResult('good output', 's1'),
        's2 {previous}': () => failResult('s2'),
      },
      calls,
    );
    await execute(
      {
        chainFailureThreshold: 3,
        chain: [
          { agent: 'a', task: 's1' },
          { agent: 'a', task: 's2 {previous}' },
          { agent: 'a', task: 's3 {previous}' },
        ],
      },
      ctxWith(),
      agents,
      runner,
    );

    expect(calls).toHaveLength(3);
    // s3 continues from the last GOOD output, not the failed step's remnant.
    expect(calls[2].resolvedTask).toContain('good output');
    expect(calls[2].resolvedTask).not.toContain('boom');
  });
});
