import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import {
  detectMode,
  execute,
  MAX_CONCURRENCY,
  MAX_PARALLEL_TASKS,
  type DispatchContext,
} from '../src/dispatch.js';
import type { AgentRunner } from '../src/runner/runner.js';
import type { AgentConfig, SingleResult } from '../src/types.js';

/** Minimal successful SingleResult. */
function makeFakeResult(agentName: string): SingleResult {
  return {
    agent: agentName,
    agentSource: 'user',
    task: 't',
    exitCode: 0,
    messages: [] as unknown as Message[],
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
    model: 'fake',
  };
}

/** SingleResult whose `messages[0].content[0].text` is `text` and whose
 *  `errorMessage` reflects a failure. exitCode non-zero. */
function makeFailedResult(agentName: string, text: string): SingleResult {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text }] },
  ] as unknown as Message[];
  return {
    ...makeFakeResult(agentName),
    messages,
    exitCode: 1,
    errorMessage: text,
    stopReason: 'error',
  };
}

/** SingleResult with a final assistant text. */
function makeResultWithText(agentName: string, text: string): SingleResult {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text }] },
  ] as unknown as Message[];
  return {
    ...makeFakeResult(agentName),
    messages,
  };
}

function trustyCtx(): DispatchContext {
  return {
    cwd: '/tmp',
    hasUI: false,
    isProjectTrusted: () => true,
    ui: { confirm: async () => true },
  };
}

function makeAgents(names: string[]): AgentConfig[] {
  return names.map((name) => ({
    name,
    description: '',
    systemPrompt: '',
    source: 'bundled',
    filePath: '',
  }));
}

/* ---------------------------------------------------------------- runChain */

/** Regression: any failed step in a chain must short-circuit subsequent steps
 *  with a "Chain stopped at step N" error. Without the early-return guard a
 *  failing step 1 would still run step 2 silently. */
describe('runChain short-circuits on step failure', () => {
  it('stops at step 1 when step 1 fails and never runs step 2', async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        calls.push(input.agent.name);
        // Step 1 fails; step 2 would have succeeded.
        return calls.length === 1
          ? makeFailedResult(input.agent.name, 'step 1 blew up')
          : makeFakeResult(input.agent.name);
      },
    };
    const out = await execute(
      {
        chain: [
          { agent: 'a', task: 'first' },
          { agent: 'b', task: 'second' },
        ],
      },
      trustyCtx(),
      makeAgents(['a', 'b']),
      runner,
    );

    expect(out.isError).toBe(true);
    expect(calls).toEqual(['a']); // 'b' never invoked
    const text = out.content[0].type === 'text' ? out.content[0].text : '';
    expect(text).toContain('Chain stopped at step 1');
    expect(text).toContain('a');
    expect(text).toContain('step 1 blew up');
    expect(out.details.mode).toBe('chain');
    expect(out.details.results).toHaveLength(1);
  });

  it('stops at step N (not step 1) when an early step fails', async () => {
    let stepIndex = 0;
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        stepIndex++;
        // Steps 1, 2 succeed; step 3 fails.
        return stepIndex < 3
          ? makeResultWithText(input.agent.name, `ok ${stepIndex}`)
          : makeFailedResult(input.agent.name, 'step 3 kaput');
      },
    };
    const out = await execute(
      {
        chain: [
          { agent: 'a', task: 's1' },
          { agent: 'a', task: 's2' },
          { agent: 'b', task: 's3' },
          { agent: 'b', task: 's4' },
        ],
      },
      trustyCtx(),
      makeAgents(['a', 'b']),
      runner,
    );

    expect(out.isError).toBe(true);
    expect(stepIndex).toBe(3); // step 4 never invoked
    const text = out.content[0].type === 'text' ? out.content[0].text : '';
    expect(text).toContain('Chain stopped at step 3');
    expect(out.details.results).toHaveLength(3);
  });
});

/** runChain's final text must come from the LAST step's messages, regardless
 *  of intermediate success. Spec: chain's content is the terminal agent's
 *  final assistant message, or '(no output)' if empty. */
describe('runChain final output', () => {
  it("uses the last step's final text as content", async () => {
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => makeResultWithText(input.agent.name, `from-${input.agent.name}`),
    };
    const out = await execute(
      {
        chain: [
          { agent: 'a', task: 't1' },
          { agent: 'b', task: 't2' },
        ],
      },
      trustyCtx(),
      makeAgents(['a', 'b']),
      runner,
    );
    expect(out.isError).toBe(false);
    const text = out.content[0].type === 'text' ? out.content[0].text : '';
    expect(text).toBe('from-b');
    expect(out.details.results).toHaveLength(2);
  });

  it("falls back to '(no output)' when the final step emits nothing", async () => {
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => makeFakeResult(input.agent.name),
    };
    const out = await execute(
      { chain: [{ agent: 'a', task: 'say nothing' }] },
      trustyCtx(),
      makeAgents(['a']),
      runner,
    );
    expect(out.isError).toBe(false);
    const text = out.content[0].type === 'text' ? out.content[0].text : '';
    expect(text).toBe('(no output)');
  });
});

/* -------------------------------------------------------------- runParallel */

/** MAX_PARALLEL_TASKS is a HARD limit (>) — 9 must fail closed, 8 must run. */
describe('runParallel MAX_PARALLEL_TASKS guard', () => {
  it(`rejects ${MAX_PARALLEL_TASKS + 1} tasks without invoking runner`, async () => {
    const runner: AgentRunner = {
      id: 'subprocess',
      run: vi.fn(async (input) => makeFakeResult(input.agent.name)),
    };
    const tasks = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, i) => ({
      agent: 'a',
      task: `t${i}`,
    }));
    const out = await execute({ tasks }, trustyCtx(), makeAgents(['a']), runner);
    expect(out.isError).toBe(true);
    expect(out.details.mode).toBe('parallel');
    expect(out.details.results).toEqual([]);
    expect(runner.run).not.toHaveBeenCalled();
    const text = out.content[0].type === 'text' ? out.content[0].text : '';
    expect(text).toContain(`Too many parallel tasks (${MAX_PARALLEL_TASKS + 1})`);
    expect(text).toContain(String(MAX_PARALLEL_TASKS));
  });

  it(`accepts exactly ${MAX_PARALLEL_TASKS} tasks at the boundary`, async () => {
    let invocations = 0;
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        invocations++;
        return makeFakeResult(input.agent.name);
      },
    };
    const tasks = Array.from({ length: MAX_PARALLEL_TASKS }, (_, i) => ({
      agent: 'a',
      task: `t${i}`,
    }));
    const out = await execute({ tasks }, trustyCtx(), makeAgents(['a']), runner);
    expect(out.isError).toBe(false);
    expect(invocations).toBe(MAX_PARALLEL_TASKS);
    expect(out.details.results).toHaveLength(MAX_PARALLEL_TASKS);
  });
});

/** Partial failure in parallel mode must mark isError and produce a per-task
 *  "failed" / "completed" summary that names the failing agent. */
describe('runParallel partial failure surfaces as isError', () => {
  it('marks isError and labels failed agents when at least one task fails', async () => {
    let n = 0;
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        n++;
        // Every other task fails.
        return n % 2 === 1
          ? makeFakeResult(input.agent.name)
          : makeFailedResult(input.agent.name, `bad-${n}`);
      },
    };
    const tasks = Array.from({ length: 4 }, (_, i) => ({ agent: 'a', task: `t${i}` }));
    const out = await execute({ tasks }, trustyCtx(), makeAgents(['a']), runner);
    expect(out.isError).toBe(true);
    expect(out.details.results).toHaveLength(4);
    const text = out.content[0].type === 'text' ? out.content[0].text : '';
    // 2 succeed, 2 fail → "2/4 succeeded"
    expect(text).toMatch(/Parallel: 2\/4 succeeded/);
    // At least one summary carries "### [a] failed"
    expect(text).toContain('### [a] failed');
    // At least one summary carries "### [a] completed"
    expect(text).toContain('### [a] completed');
  });

  it('reports 0/N when every task fails', async () => {
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => makeFailedResult(input.agent.name, 'boom'),
    };
    const tasks = Array.from({ length: 3 }, (_, i) => ({ agent: 'a', task: `t${i}` }));
    const out = await execute({ tasks }, trustyCtx(), makeAgents(['a']), runner);
    expect(out.isError).toBe(true);
    const text = out.content[0].type === 'text' ? out.content[0].text : '';
    expect(text).toMatch(/Parallel: 0\/3 succeeded/);
  });
});

/** Per-task `cwd` overrides the ctx default. The `??` operator matters here
 *  — a `||` would treat empty string as missing. */
describe('runParallel per-task cwd override', () => {
  it('uses t.cwd when set, falls back to ctx.cwd when not', async () => {
    const seenCwds: Array<string | undefined> = [];
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        seenCwds.push(input.cwd);
        return makeFakeResult(input.agent.name);
      },
    };
    const tasks = [
      { agent: 'a', task: 't0', cwd: '/repo/a' },
      { agent: 'a', task: 't1' },
    ];
    await execute({ tasks }, trustyCtx(), makeAgents(['a']), runner);
    expect(seenCwds).toEqual(['/repo/a', '/tmp']);
  });
});

/** Per-batch cap must hold when batchCount is a clean multiple of cap. The
 *  same shared-gate pattern as `dispatch.test.ts` (concurrent cap) is used
 *  here for 8 tasks = 2 full batches of 4. */
describe('runParallel per-batch concurrency on clean-multiple sizes', () => {
  it(`never exceeds MAX_CONCURRENCY (=${MAX_CONCURRENCY}) across multiple full batches`, async () => {
    let inFlight = 0;
    let peak = 0;
    let startedCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const firstBatchSettled = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        startedCount++;
        await gate;
        inFlight--;
        return makeFakeResult(input.agent.name);
      },
    };

    // 8 tasks = exactly 2 full batches of 4.
    const tasks = Array.from({ length: 8 }, (_, i) => ({ agent: 'a', task: `t${i}` }));
    const executePromise = execute({ tasks }, trustyCtx(), makeAgents(['a']), runner);

    // First batch fills up to MAX_CONCURRENCY, then blocks on Promise.all.
    for (let i = 0; i < 50 && startedCount < MAX_CONCURRENCY; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(startedCount).toBe(MAX_CONCURRENCY);
    expect(peak).toBe(MAX_CONCURRENCY);

    // Release the gate; batch 1 settles, batch 2 starts (also up to MAX_CONCURRENCY).
    release();
    await firstBatchSettled();
    // After release: batch 1 settled → inFlight is 0; batch 2 started → inFlight ≤ 4.
    // Peak across BOTH batches remains MAX_CONCURRENCY — cap is per-batch window.
    expect(peak).toBe(MAX_CONCURRENCY);
    expect(startedCount).toBe(8);

    await executePromise;
  });
});

/* --------------------------------------------------------------- runSingle */

/** Single-mode failure must bubble up as isError with the failed result
 *  preserved in details.results. */
describe('runSingle failure surfacing', () => {
  it('sets isError and preserves the failed result when runner returns failure', async () => {
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async () => makeFailedResult('a', 'agent crashed'),
    };
    const out = await execute(
      { agent: 'a', task: 'do thing' },
      trustyCtx(),
      makeAgents(['a']),
      runner,
    );
    expect(out.isError).toBe(true);
    expect(out.details.mode).toBe('single');
    expect(out.details.results).toHaveLength(1);
    expect(out.details.results[0].errorMessage).toBe('agent crashed');
    expect(out.details.results[0].exitCode).toBe(1);
    const text = out.content[0].type === 'text' ? out.content[0].text : '';
    expect(text).toBe('agent crashed');
  });

  it("falls back to '(no output)' for success with empty messages", async () => {
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async () => makeFakeResult('a'),
    };
    const out = await execute(
      { agent: 'a', task: 'silent' },
      trustyCtx(),
      makeAgents(['a']),
      runner,
    );
    expect(out.isError).toBe(false);
    const text = out.content[0].type === 'text' ? out.content[0].text : '';
    expect(text).toBe('(no output)');
  });
});

/* -------------------------------------------------------------------- execute */

/** execute() builds a stub AgentConfig from `{name, description:'', systemPrompt:'',
 *  source:'bundled', filePath:''}` when `lookup(name)` doesn't find a match.
 *  Without this fallback, a typo in the agent name would either crash or
 *  silently dispatch to the wrong config — the stub is a defensive fallback. */
describe('execute() lookup fallback for unknown agent names', () => {
  it('dispatches to runner with a stub AgentConfig when name is not in agents[]', async () => {
    const seenAgent: AgentConfig[] = [];
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        seenAgent.push(input.agent);
        return makeFakeResult(input.agent.name);
      },
    };
    // agents[] deliberately omits 'missing'.
    const out = await execute(
      { agent: 'missing', task: 'go' },
      trustyCtx(),
      makeAgents(['other']),
      runner,
    );
    expect(out.isError).toBe(false);
    expect(seenAgent).toHaveLength(1);
    expect(seenAgent[0]).toEqual({
      name: 'missing',
      description: '',
      systemPrompt: '',
      source: 'bundled',
      filePath: '',
    });
    expect(out.details.results[0].agent).toBe('missing');
  });
});

/** Parallel lookup fallback: tasks reference agents not in agents[]. The stub
 *  must be passed per-task, not crash on first lookup miss. */
describe('execute() parallel lookup fallback', () => {
  it('falls back to stub per-task when some task agents are unknown', async () => {
    const seenAgents: AgentConfig[] = [];
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        seenAgents.push(input.agent);
        return makeFakeResult(input.agent.name);
      },
    };
    await execute(
      {
        tasks: [
          { agent: 'known', task: 't0' },
          { agent: 'ghost', task: 't1' },
        ],
      },
      trustyCtx(),
      makeAgents(['known']),
      runner,
    );
    expect(seenAgents.map((a) => a.name)).toEqual(['known', 'ghost']);
    expect(seenAgents[1]).toEqual({
      name: 'ghost',
      description: '',
      systemPrompt: '',
      source: 'bundled',
      filePath: '',
    });
  });
});

/* ------------------------------------------------------------ detectMode corner */

/** Single mode must require BOTH agent AND task — agent alone or task alone
 *  is invalid. Edge cases for the `&&` short-circuit operator. */
describe('detectMode single-mode `&&` requirement', () => {
  it("returns 'invalid' when only agent is present (no task)", () => {
    expect(detectMode({ agent: 'x' })).toBe('invalid');
  });

  it("returns 'invalid' when only task is present (no agent)", () => {
    expect(detectMode({ task: 'y' })).toBe('invalid');
  });

  it("returns 'invalid' on empty string agent (falsy)", () => {
    expect(detectMode({ agent: '', task: 'y' })).toBe('invalid');
  });

  it("returns 'invalid' on empty string task (falsy)", () => {
    expect(detectMode({ agent: 'x', task: '' })).toBe('invalid');
  });

  it("returns 'single' when both agent and task are present", () => {
    expect(detectMode({ agent: 'x', task: 'y' })).toBe('single');
  });
});
