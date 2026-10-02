import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execute, MAX_CONCURRENCY, runWithCaps, type DispatchContext } from '../src/dispatch.js';
import { resetProviderLimitsCache } from '../src/provider-limits.js';
import type { AgentRunner } from '../src/runner/runner.js';
import type { AgentConfig, SingleResult } from '../src/types.js';

/**
 * Provider-scoped concurrency caps (ADR-0005): provider plans limit how many
 * concurrent model requests an account may run (z.ai 2, MiniMax 3). These
 * tests pin the caps end-to-end through runParallel via a fake runner that
 * records start order and peak in-flight per provider.
 *
 * Isolation: each test points PI_CODING_AGENT_DIR at a fresh tmp dir so
 * loadProviderLimits() sees the built-in defaults (or an explicit test
 * config file), never the real user config on this machine.
 */

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function makeFakeResult(agentName: string): SingleResult {
  return {
    agent: agentName,
    agentSource: 'user',
    task: 't',
    exitCode: 0,
    messages: [],
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

const agent = (name: string): AgentConfig => ({
  name,
  description: '',
  systemPrompt: '',
  source: 'bundled',
  filePath: '',
});

const ctx = (): DispatchContext => ({
  cwd: '/tmp',
  hasUI: false,
  isProjectTrusted: () => true,
  ui: { confirm: async () => true },
});

let tmpDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-caps-'));
  savedEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  resetProviderLimitsCache();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedEnv;
  resetProviderLimitsCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runParallel provider caps (ADR-0005)', () => {
  it('z.ai cap of 2: five same-provider tasks run two at a time, in order', async () => {
    let inFlight = 0;
    let peak = 0;
    const started: string[] = [];
    const twoStarted = deferred<undefined>();
    const release = deferred<undefined>();

    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        started.push(input.task);
        if (started.length === 2) twoStarted.resolve(undefined);
        await release.promise;
        inFlight -= 1;
        return makeFakeResult(input.agent.name);
      },
    };

    const tasks = Array.from({ length: 5 }, (_, i) => ({
      agent: 'a',
      task: `t${i}`,
      model: 'zai/glm-5.3-flash',
    }));
    const out = execute({ tasks }, ctx(), [agent('a')], runner);

    // Only two z.ai runs may be in flight; the rest wait for a free slot.
    await twoStarted.promise;
    expect(started).toEqual(['t0', 't1']);
    expect(inFlight).toBe(2);
    expect(peak).toBe(2);

    release.resolve(undefined);
    const result = await out;
    expect(peak).toBe(2); // a third z.ai run never overlapped the pair
    expect(started).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(result.isError).toBe(false);
    expect(result.details.results).toHaveLength(5);
  });

  it('a full provider slot does not block other providers (no head-of-line)', async () => {
    const started: string[] = [];
    const threeStarted = deferred<undefined>();
    const release = deferred<undefined>();

    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        started.push(input.task);
        if (started.length === 3) threeStarted.resolve(undefined);
        await release.promise;
        return makeFakeResult(input.agent.name);
      },
    };

    // Two z.ai tasks fill the z.ai cap; the third z.ai task must NOT stop
    // the uncapped task from taking the free total slot.
    const tasks = [
      { agent: 'a', task: 'z0', model: 'zai/glm-5.3-flash' },
      { agent: 'a', task: 'z1', model: 'zai/glm-5.3-flash' },
      { agent: 'a', task: 'z2', model: 'zai/glm-5.3-flash' },
      { agent: 'a', task: 'u3' },
    ];
    const out = execute({ tasks }, ctx(), [agent('a')], runner);

    await threeStarted.promise;
    expect(started).toContain('u3');
    expect(started).not.toContain('z2');

    release.resolve(undefined);
    const result = await out;
    expect(started).toEqual(['z0', 'z1', 'u3', 'z2']);
    expect(result.isError).toBe(false);
    expect(result.details.results).toHaveLength(4);
  });

  it(`providers without a configured limit are uncapped (up to MAX_CONCURRENCY=${MAX_CONCURRENCY})`, async () => {
    let inFlight = 0;
    let peak = 0;
    let startedCount = 0;
    const allStarted = deferred<undefined>();
    const release = deferred<undefined>();

    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        startedCount += 1;
        if (startedCount === MAX_CONCURRENCY) allStarted.resolve(undefined);
        await release.promise;
        inFlight -= 1;
        return makeFakeResult(input.agent.name);
      },
    };

    const tasks = Array.from({ length: 6 }, (_, i) => ({
      agent: 'a',
      task: `t${i}`,
      model: 'anthropic/claude-sonnet-4-5',
    }));
    const out = execute({ tasks }, ctx(), [agent('a')], runner);

    await allStarted.promise;
    expect(peak).toBe(MAX_CONCURRENCY);
    release.resolve(undefined);
    const result = await out;
    expect(peak).toBe(MAX_CONCURRENCY);
    expect(result.details.results).toHaveLength(6);
  });

  it('caps are overridable via pisubagent.limits.json in the agent dir', async () => {
    fs.writeFileSync(path.join(tmpDir, 'pisubagent.limits.json'), JSON.stringify({ zai: 1 }));
    resetProviderLimitsCache();

    let inFlight = 0;
    let peak = 0;
    const started: string[] = [];
    const oneStarted = deferred<undefined>();
    const release = deferred<undefined>();

    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        started.push(input.task);
        if (started.length === 1) oneStarted.resolve(undefined);
        await release.promise;
        inFlight -= 1;
        return makeFakeResult(input.agent.name);
      },
    };

    const tasks = Array.from({ length: 3 }, (_, i) => ({
      agent: 'a',
      task: `t${i}`,
      model: 'zai/glm-5.3-flash',
    }));
    const out = execute({ tasks }, ctx(), [agent('a')], runner);

    await oneStarted.promise;
    expect(started).toEqual(['t0']);
    release.resolve(undefined);
    const result = await out;
    expect(peak).toBe(1); // override tightened z.ai to strictly serial
    expect(started).toEqual(['t0', 't1', 't2']);
    expect(result.isError).toBe(false);
  });

  it('parent-model inheritance attributes runs to the parent provider', async () => {
    let inFlight = 0;
    let peak = 0;
    const started: string[] = [];
    const twoStarted = deferred<undefined>();
    const release = deferred<undefined>();

    const runner: AgentRunner = {
      id: 'subprocess',
      run: async (input) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        started.push(input.task);
        if (started.length === 2) twoStarted.resolve(undefined);
        await release.promise;
        inFlight -= 1;
        return makeFakeResult(input.agent.name);
      },
    };

    // Agents have no model pin; the parent session runs on z.ai → the runs
    // count against the z.ai cap even though no per-task model was given.
    const tasks = Array.from({ length: 4 }, (_, i) => ({ agent: 'a', task: `t${i}` }));
    const parentCtx = { ...ctx(), model: { provider: 'zai', id: 'glm-5.3-flash' } };
    const out = execute({ tasks }, parentCtx, [agent('a')], runner);

    await twoStarted.promise;
    expect(started).toEqual(['t0', 't1']);
    expect(peak).toBe(2);
    release.resolve(undefined);
    const result = await out;
    expect(peak).toBe(2);
    expect(result.isError).toBe(false);
  });
});

describe('runWithCaps', () => {
  it('rethrows the first start() rejection only after all in-flight tasks settle', async () => {
    let settledSecond = false;
    const start = async (i: number): Promise<void> => {
      if (i === 0) throw new Error('boom');
      await new Promise((r) => setTimeout(r, 5));
      settledSecond = true;
    };
    await expect(runWithCaps([undefined, undefined], start)).rejects.toThrow('boom');
    // No orphaned task: the sibling ran to completion before the throw.
    expect(settledSecond).toBe(true);
  });

  it('honors injected limits (test seam, no config file involved)', async () => {
    let inFlight = 0;
    let peak = 0;
    const start = async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    };
    await runWithCaps(['zai', 'zai', 'zai'], start, { maxTotal: 4, limits: { zai: 1 } });
    expect(peak).toBe(1);
  });
});
