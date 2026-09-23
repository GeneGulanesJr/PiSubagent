import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import type { ChildProcess } from 'node:child_process';
import {
  execute,
  createProgressEmitter,
  PROGRESS_THROTTLE_MS,
  type DispatchContext,
} from '../src/dispatch.js';
import type { AgentRunner, AgentRunInput, OnUpdatePartial } from '../src/runner/runner.js';
import type { AgentConfig, SingleResult, SubagentDetails } from '../src/types.js';

const theme = {
  bold: (s: string) => `**${s}**`,
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
};

function agent(name: string): AgentConfig {
  return { name, description: '', systemPrompt: '', source: 'bundled', filePath: '' };
}

function makeResult(
  agentName: string,
  text: string,
  extra: Partial<SingleResult> = {},
): SingleResult {
  return {
    agent: agentName,
    agentSource: 'user',
    task: 't',
    exitCode: 0,
    messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] as unknown as Message[],
    stderr: '',
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 30,
      turns: 1,
    },
    ...extra,
  };
}

function baseCtx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    cwd: '/tmp',
    hasUI: false,
    isProjectTrusted: () => true,
    ui: { confirm: async () => true },
    ...over,
  };
}

const AGENTS = [agent('a'), agent('b')];

interface RunCall {
  input: AgentRunInput;
  signal: AbortSignal | undefined;
  onUpdate: OnUpdatePartial | undefined;
}

/** Fake runner: records calls, delegates behavior to the per-test script. */
function makeRunner(behavior: (call: RunCall) => Promise<SingleResult>) {
  const calls: RunCall[] = [];
  const runner: AgentRunner = {
    id: 'subprocess',
    run: (input, signal, onUpdate) => {
      const call: RunCall = { input, signal, onUpdate };
      calls.push(call);
      return behavior(call);
    },
  };
  return { runner, calls };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createProgressEmitter', () => {
  it('returns undefined when onUpdate is undefined (noop path)', () => {
    expect(createProgressEmitter(undefined, 0)).toBeUndefined();
  });

  it('passes the first call through immediately', () => {
    const spy = vi.fn();
    const emit = createProgressEmitter(spy, 250)!;
    emit({ content: [], details: {} as SubagentDetails });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('throttles rapid calls to leading + trailing', async () => {
    const spy = vi.fn();
    const emit = createProgressEmitter(spy, 60)!;
    for (let i = 0; i < 10; i++) {
      emit({ content: [{ type: 'text', text: `u${i}` }], details: {} as SubagentDetails });
    }
    expect(spy).toHaveBeenCalledTimes(1); // leading only
    await sleep(120); // trailing fires within the window
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
    // trailing carries the LATEST payload
    const last = spy.mock.calls[spy.mock.calls.length - 1][0];
    expect(last.content[0]).toMatchObject({ text: 'u9' });
  });
});

describe('live progress through execute()', () => {
  it('single mode: emits running snapshots during flight, clears running on completion', async () => {
    const { runner } = makeRunner(async (call) => {
      call.onUpdate?.(makeResult('a', 'partial one'));
      call.onUpdate?.(makeResult('a', 'partial two'));
      return makeResult('a', 'final');
    });
    const spy = vi.fn();
    const out = await execute(
      { agent: 'a', task: 'do it' },
      baseCtx({ onUpdate: spy, progressIntervalMs: 0 }),
      AGENTS,
      runner,
    );

    expect(out.isError).toBe(false);
    // with coalescing disabled: initial stub + 2 runner updates = exactly 3
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);

    const firstSnapshot = spy.mock.calls[0][0] as { details: SubagentDetails };
    expect(firstSnapshot.details.results).toHaveLength(1);
    expect(firstSnapshot.details.results[0].running).toBe(true);
    expect(firstSnapshot.details.results[0].agent).toBe('a');

    const midSnapshot = spy.mock.calls[1][0] as { details: SubagentDetails };
    expect(midSnapshot.details.results[0].running).toBe(true);
    expect(midSnapshot.details.results[0].messages).toHaveLength(1);

    // final result: running cleared, content is final output
    expect(out.details.results[0].running).toBe(false);
    expect(out.content[0].type === 'text' && out.content[0].text).toContain('final');
  });

  it('single mode: threads the abort signal to the runner', async () => {
    const { runner, calls } = makeRunner(async () => makeResult('a', 'ok'));
    const controller = new AbortController();
    await execute(
      { agent: 'a', task: 'x' },
      baseCtx({ signal: controller.signal }),
      AGENTS,
      runner,
    );
    expect(calls[0].signal).toBe(controller.signal);
  });

  it('parallel mode: merges per-agent updates into the right slots regardless of completion order', async () => {
    const gateB = deferred<SingleResult>();
    const { runner } = makeRunner(async (call) => {
      if (call.input.agent.name === 'a') {
        // slow first task: emit, then wait until b has finished
        call.onUpdate?.(makeResult('a', 'a working'));
        const bFinal = await gateB.promise;
        void bFinal;
        call.onUpdate?.(makeResult('a', 'a resumed'));
        return makeResult('a', 'a final');
      }
      call.onUpdate?.(makeResult('b', 'b working'));
      const done = makeResult('b', 'b final');
      gateB.resolve(done);
      return done;
    });

    const spy = vi.fn();
    const out = await execute(
      {
        tasks: [
          { agent: 'a', task: 't1' },
          { agent: 'b', task: 't2' },
        ],
      },
      baseCtx({ onUpdate: spy, progressIntervalMs: 0 }),
      AGENTS,
      runner,
    );

    expect(out.isError).toBe(false);
    // final slots stay in task order even though b finished first
    expect(out.details.results[0]).toMatchObject({ agent: 'a', running: false });
    expect(out.details.results[1]).toMatchObject({ agent: 'b', running: false });

    // during flight there was a snapshot where a was still running but b was done
    const sawMixed = spy.mock.calls.some((call) => {
      const r = (call[0] as { details: SubagentDetails }).details.results;
      return r.length === 2 && r[0].running === true && r[1].running === false;
    });
    expect(sawMixed).toBe(true);
  });

  it('chain mode: snapshots grow step by step; final content is last step output', async () => {
    const { runner, calls } = makeRunner(async (call) => {
      call.onUpdate?.(makeResult(call.input.agent.name, 'working'));
      return makeResult(call.input.agent.name, `${call.input.agent.name} done`);
    });

    const spy = vi.fn();
    const out = await execute(
      {
        chain: [
          { agent: 'a', task: 'first {previous}' },
          { agent: 'b', task: 'second {previous}' },
        ],
      },
      baseCtx({ onUpdate: spy, progressIntervalMs: 0 }),
      AGENTS,
      runner,
    );

    expect(out.isError).toBe(false);
    expect(out.content[0].type === 'text' && out.content[0].text).toContain('b done');
    expect(out.details.results).toHaveLength(2);
    expect(out.details.results.every((r) => r.running === false)).toBe(true);

    // snapshots grew: some snapshot had exactly 1 (step 2 not started yet)
    const grewStepByStep = spy.mock.calls.some((call) => {
      const r = (call[0] as { details: SubagentDetails }).details.results;
      return r.length === 1 && r[0].agent === 'a' && r[0].running === true;
    });
    expect(grewStepByStep).toBe(true);

    // {previous} substitution still flows through resolvedTask
    expect(calls[1].input.resolvedTask).toContain('a done');
  });

  it('parallel mode: no crash and no emissions when onUpdate absent', async () => {
    const { runner } = makeRunner(async () => makeResult('a', 'ok'));
    const out = await execute({ tasks: [{ agent: 'a', task: 't' }] }, baseCtx(), AGENTS, runner);
    expect(out.details.results[0].running).toBe(false);
  });

  it('invalid params: returns error without touching onUpdate', async () => {
    const { runner } = makeRunner(async () => makeResult('a', 'never'));
    const spy = vi.fn();
    const out = await execute({}, baseCtx({ onUpdate: spy }), AGENTS, runner);
    expect(out.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('render: partial/running results', () => {
  it('single: running result shows an in-flight marker, not the success check', async () => {
    const { renderResult } = await import('../src/render.js');
    const r = makeResult('scout', 'working');
    const out = renderResult(
      {
        content: [],
        details: {
          mode: 'single',
          agentScope: 'user',
          projectAgentsDir: null,
          results: [{ ...r, running: true }],
        },
      },
      { isPartial: true },
      theme as never,
    );
    expect(out).toContain('scout');
    expect(out).not.toContain('✓');
  });

  it('multi: partial render shows per-agent running markers and done counts', async () => {
    const { renderResult } = await import('../src/render.js');
    const out = renderResult(
      {
        content: [],
        details: {
          mode: 'parallel',
          agentScope: 'user',
          projectAgentsDir: null,
          results: [
            { ...makeResult('a', 'done'), running: false },
            { ...makeResult('b', 'working'), running: true },
          ],
        },
      },
      { isPartial: true },
      theme as never,
    );
    expect(out).toContain('◐');
    expect(out).toContain('1/2');
  });

  it('final multi render keeps the success check (no regression)', async () => {
    const { renderResult } = await import('../src/render.js');
    const out = renderResult(
      {
        content: [],
        details: {
          mode: 'parallel',
          agentScope: 'user',
          projectAgentsDir: null,
          results: [makeResult('a', 'done'), makeResult('b', 'done')],
        },
      },
      {},
      theme as never,
    );
    expect(out).toContain('✓');
    expect(out).toContain('2/2');
  });
});
