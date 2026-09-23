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

function makeResultWithText(agentName: string, text: string): SingleResult {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text }] },
  ] as unknown as Message[];
  return { ...makeFakeResult(agentName), messages };
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

/* ====================================================================
 * Triage tests for surviving Stryker mutants in dispatch/*.ts.
 *
 * Strategy: each test asserts on observable output that the mutant
 * would change. Pairs with `excludedMutations` in stryker.config.mjs
 * for the mutants we can prove equivalent by code reading.
 * ==================================================================== */

/* -------------------------------------------------- detect-mode.ts */

/** detect-mode.ts: ConditionalExpression / ArithmeticOperator on the
 *  parallel/chain `> 0` boundary. Mutant `(...) > 0` → `(...) >= 0`
 *  distinguishes at length === 0 (true vs false). perTest coverage has
 *  repeatedly failed to attribute the existing test — assert directly
 *  on mode resolution for `tasks: []` and `chain: []`. */
describe('detectMode boundary (length === 0)', () => {
  it("treats empty tasks[] as 'invalid' (not 'parallel')", () => {
    // Tasks is present but empty AND chain is empty AND agent/task absent.
    // Original: parallel = 0 > 0 = false → 'invalid'.
    // Mutant:   parallel = 0 >= 0 = true → 'parallel'.
    expect(detectMode({ tasks: [] })).toBe('invalid');
  });

  it("treats empty chain[] as 'invalid' (not 'chain')", () => {
    expect(detectMode({ chain: [] })).toBe('invalid');
  });

  it('agent + task wins over empty chain[] (single mode)', () => {
    expect(detectMode({ agent: 'x', task: 'y', chain: [] })).toBe('single');
  });
});

/** detect-mode.ts ConditionalExpression swaps. Mutant `parallel = false`
 *  (always-false constant) would mean detectMode({tasks:[{...}]}) returns
 *  'invalid', not 'parallel'. */
describe('detectMode ConditionalExpression coverage', () => {
  it("truthy tasks[] resolves to 'parallel' even with all other flags absent", () => {
    expect(detectMode({ tasks: [{ agent: 'a', task: 'b' }] })).toBe('parallel');
  });

  it("truthy chain[] resolves to 'chain' even with all other flags absent", () => {
    expect(detectMode({ chain: [{ agent: 'a', task: 'b' }] })).toBe('chain');
  });

  it("agent + task with empty tasks[] still resolves to 'single'", () => {
    expect(detectMode({ agent: 'x', task: 'y', tasks: [] })).toBe('single');
  });
});

/* ------------------------------------------------------ execute.ts */

/** execute.ts `mode` switch. Each mode must dispatch to its runner.
 *  Mutant `if (false) return runSingle(...)` means parallel calls
 *  never reach runSingle, fine — but `if (true) return runSingle(...)`
 *  means every mode runs as single, which a mode-tagged assertion
 *  catches. */
describe('execute() mode dispatch (detected mode wins)', () => {
  it('single mode → results[0].agent set to single agent', async () => {
    const seen: string[] = [];
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        seen.push(input.agent.name);
        return makeFakeResult(input.agent.name);
      },
    };
    const out = await execute(
      { agent: 'single-agent', task: 'go' },
      trustyCtx(),
      makeAgents(['single-agent']),
      runner,
    );
    expect(out.details.mode).toBe('single');
    expect(seen).toEqual(['single-agent']);
    expect(out.details.results).toHaveLength(1);
  });

  it('parallel mode → all task agents dispatched', async () => {
    const seen: string[] = [];
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        seen.push(input.agent.name);
        return makeFakeResult(input.agent.name);
      },
    };
    const out = await execute(
      {
        tasks: [
          { agent: 'a', task: 't0' },
          { agent: 'b', task: 't1' },
        ],
      },
      trustyCtx(),
      makeAgents(['a', 'b']),
      runner,
    );
    expect(out.details.mode).toBe('parallel');
    expect(seen.sort()).toEqual(['a', 'b']);
    expect(out.details.results).toHaveLength(2);
  });

  it('chain mode → steps dispatched in order, each with resolvedTask', async () => {
    const seen: Array<{ name: string; task: string | undefined; resolved: string | undefined }> =
      [];
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        seen.push({ name: input.agent.name, task: input.task, resolved: input.resolvedTask });
        return makeResultWithText(input.agent.name, `done-${input.agent.name}`);
      },
    };
    const out = await execute(
      {
        chain: [
          { agent: 'a', task: 'step1' },
          { agent: 'b', task: 'step2' },
        ],
      },
      trustyCtx(),
      makeAgents(['a', 'b']),
      runner,
    );
    expect(out.details.mode).toBe('chain');
    expect(seen.map((s) => s.name)).toEqual(['a', 'b']);
    // Step 2 has no {previous} placeholder, so resolvedTask should match task.
    expect(seen[0].resolved).toBe('step1');
    expect(seen[1].resolved).toBe('step2');
    expect(out.details.results).toHaveLength(2);
  });
});

/** execute.ts lookup fallback: `agents.find(...) ?? { stub }` — the
 *  fallback must preserve the requested `name` and produce a stub config
 *  with empty description/systemPrompt/source 'bundled'. */
describe('execute() lookup: stub for unknown agent', () => {
  it('stub carries the queried name verbatim', async () => {
    const seen: AgentConfig[] = [];
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        seen.push(input.agent);
        return makeFakeResult(input.agent.name);
      },
    };
    await execute(
      { agent: 'ghost-agent', task: 'x' },
      trustyCtx(),
      makeAgents(['real-agent']),
      runner,
    );
    expect(seen[0].name).toBe('ghost-agent');
  });

  it("stub has empty description/systemPrompt, source 'bundled'", async () => {
    const seen: AgentConfig[] = [];
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        seen.push(input.agent);
        return makeFakeResult(input.agent.name);
      },
    };
    await execute(
      { agent: 'ghost-agent', task: 'x' },
      trustyCtx(),
      makeAgents(['real-agent']),
      runner,
    );
    expect(seen[0].description).toBe('');
    expect(seen[0].systemPrompt).toBe('');
    expect(seen[0].source).toBe('bundled');
    expect(seen[0].filePath).toBe('');
  });
});

/* ------------------------------------------ run-parallel.ts */

/** run-parallel.ts boundary. Mutant `tasks.length > MAX_PARALLEL_TASKS`
 *  → `>= MAX_PARALLEL_TASKS` is observable at the boundary. */
describe('runParallel boundary at MAX_PARALLEL_TASKS', () => {
  it(`accepts exactly ${MAX_PARALLEL_TASKS} tasks (boundary)`, async () => {
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => makeFakeResult(input.agent.name),
    };
    const tasks = Array.from({ length: MAX_PARALLEL_TASKS }, (_, i) => ({
      agent: 'a',
      task: `t${i}`,
    }));
    const out = await execute({ tasks }, trustyCtx(), makeAgents(['a']), runner);
    expect(out.isError).toBe(false);
    expect(out.details.results).toHaveLength(MAX_PARALLEL_TASKS);
  });

  it(`rejects ${MAX_PARALLEL_TASKS + 1} tasks (boundary + 1)`, async () => {
    const runner: AgentRunner = {
      id: 'subprocess',
      run: vi.fn(async () => makeFakeResult('a')),
    };
    const tasks = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, i) => ({
      agent: 'a',
      task: `t${i}`,
    }));
    const out = await execute({ tasks }, trustyCtx(), makeAgents(['a']), runner);
    expect(out.isError).toBe(true);
    expect(runner.run).not.toHaveBeenCalled();
    const text = out.content[0].type === 'text' ? out.content[0].text : '';
    expect(text).toContain('Too many parallel tasks');
  });
});

/** Per-batch cap must hold: with 8 tasks and MAX_CONCURRENCY=4, peak in-flight
 *  must equal MAX_CONCURRENCY. */
describe('runParallel concurrency cap (issue #1 Bug 1 — defended)', () => {
  it(`cap of ${MAX_CONCURRENCY} holds at batch transition`, async () => {
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight--;
        return makeFakeResult(input.agent.name);
      },
    };

    // 8 tasks → exactly 2 batches of 4.
    const tasks = Array.from({ length: 8 }, (_, i) => ({ agent: 'a', task: `t${i}` }));
    const executePromise = execute({ tasks }, trustyCtx(), makeAgents(['a']), runner);

    // Wait for the first batch to fill to MAX_CONCURRENCY.
    for (let i = 0; i < 200 && peak < MAX_CONCURRENCY; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(peak).toBe(MAX_CONCURRENCY);

    release();
    await executePromise;
    expect(peak).toBe(MAX_CONCURRENCY);
  });
});

/* ---------------------------------------------- run-single.ts */

describe('runSingle content === runner final assistant text', () => {
  it('content[0].text equals assistant content when present', async () => {
    const runner: AgentRunner = {
      id: 'subprocess',
      run: async () => makeResultWithText('a', 'hello world'),
    };
    const out = await execute(
      { agent: 'a', task: 'say hi' },
      trustyCtx(),
      makeAgents(['a']),
      runner,
    );
    const text = out.content[0].type === 'text' ? out.content[0].text : '';
    expect(text).toBe('hello world');
  });
});
