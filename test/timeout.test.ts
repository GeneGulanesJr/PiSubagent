import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { Message } from '@earendil-works/pi-ai';
import { SubprocessRunner } from '../src/runner/subprocess.js';
import { execute } from '../src/dispatch.js';
import { isFailedResult } from '../src/output.js';
import type { AgentRunner, AgentRunInput } from '../src/runner/runner.js';
import type { AgentConfig, SingleResult } from '../src/types.js';

const baseAgent = { name: 'scout', description: '', systemPrompt: '', source: 'bundled' as const, filePath: '' };
const baseInput = { agent: baseAgent, task: 'do work', cwd: '/tmp' };

// FakeProc — EventEmitter satisfying the ChildProcess surface the runner uses.
function makeFakeProc(opts: { killFiresClose?: boolean } = {}) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  (proc as unknown as { stdout: Readable }).stdout = stdout;
  (proc as unknown as { stderr: Readable }).stderr = stderr;
  const state = { killed: false, exitCode: null as number | null };
  proc.kill = vi.fn(((_sig?: NodeJS.Signals) => {
    state.killed = true;
    if (opts.killFiresClose) setImmediate(() => proc.emit('close', null));
    return true;
  }) as unknown as typeof proc.kill);
  return {
    proc, stdout, stderr,
    get killed() { return state.killed; },
    get exitCode() { return state.exitCode; },
    finish(code: number | null = 0) {
      stdout.push(null); stderr.push(null);
      state.exitCode = code;
      proc.emit('close', code);
    },
  };
}

async function waitForCloseListener(proc: ReturnType<typeof makeFakeProc>, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (proc.proc.listenerCount('close') >= 1) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('SubprocessRunner.run — per-dispatch timeout', () => {
  it('fires and marks timedOut', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });
    const promise = runner.run({ ...baseInput, timeoutMs: 50 });
    await waitForCloseListener(fake);
    await new Promise((r) => setTimeout(r, 120));
    expect(fake.proc.kill).toHaveBeenCalledWith('SIGTERM');
    fake.finish(143);
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.stopReason).toBe('aborted');
    expect(result.errorMessage).toContain('run timeout after 50ms');
  });

  it('per-dispatch timeoutMs beats runner-level runTimeoutMs', async () => {
    const fake = makeFakeProc();
    const spawnFn = (() => fake.proc) as never;
    const runner = new SubprocessRunner({ spawnFn, runTimeoutMs: 10_000 });
    const promise = runner.run({ ...baseInput, timeoutMs: 50 });
    await waitForCloseListener(fake);
    await new Promise((r) => setTimeout(r, 120));
    expect(fake.proc.kill).toHaveBeenCalledTimes(1);
    expect(fake.proc.kill).toHaveBeenCalledWith('SIGTERM');
    fake.finish(143);
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toContain('after 50ms');
    expect(result.errorMessage).not.toContain('10000');
  });

  it('clean exit clears the timer (no kill, not aborted)', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never, runTimeoutMs: 10_000 });
    const promise = runner.run({ ...baseInput });
    await waitForCloseListener(fake);
    fake.finish(0);
    const result = await promise;
    expect(result.timedOut).toBeUndefined();
    expect(fake.proc.kill).not.toHaveBeenCalled();
    expect(result.stopReason).not.toBe('aborted');
  });
});

describe('isFailedResult — timedOut', () => {
  const base = {
    agent: 'a',
    agentSource: 'user',
    task: 't',
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
  };

  it('returns true for a timed-out result', () => {
    // The runner marks a timeout as timedOut + stopReason 'aborted'; isFailedResult
    // classifies it as failed via the aborted stopReason.
    const result = { ...base, timedOut: true, stopReason: 'aborted' } as unknown as SingleResult;
    expect(isFailedResult(result)).toBe(true);
  });

  it('returns false when timedOut is absent', () => {
    const result = { ...base } as unknown as SingleResult;
    expect(isFailedResult(result)).toBe(false);
  });
});

describe('dispatch pass-through — timeoutMs', () => {
  const agents = [{ name: 'a', description: '', systemPrompt: '', source: 'bundled', filePath: '' }] as AgentConfig[];
  const ctx = { cwd: '/tmp', hasUI: false, isProjectTrusted: () => true, ui: { confirm: async () => true } } as never;

  function recordingRunner(seen: Array<Partial<AgentRunInput>>): AgentRunner {
    return {
      id: 'subprocess',
      run: async (input) => {
        seen.push(input);
        return {
          agent: input.agent.name,
          agentSource: 'user',
          task: input.task,
          exitCode: 0,
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] as unknown as Message[],
          stderr: '',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
        };
      },
    };
  }

  it('forwards single timeoutMs into AgentRunInput', async () => {
    const seen: Array<Partial<AgentRunInput>> = [];
    await execute({ agent: 'a', task: 't', timeoutMs: 1234 }, ctx, agents, recordingRunner(seen));
    expect(seen[0]?.timeoutMs).toBe(1234);
  });

  it('forwards tasks[].timeoutMs into AgentRunInput', async () => {
    const seen: Array<Partial<AgentRunInput>> = [];
    await execute({ tasks: [{ agent: 'a', task: 't', timeoutMs: 2222 }] }, ctx, agents, recordingRunner(seen));
    expect(seen[0]?.timeoutMs).toBe(2222);
  });

  it('forwards chain[].timeoutMs into AgentRunInput', async () => {
    const seen: Array<Partial<AgentRunInput>> = [];
    await execute({ chain: [{ agent: 'a', task: 't', timeoutMs: 3333 }] }, ctx, agents, recordingRunner(seen));
    expect(seen[0]?.timeoutMs).toBe(3333);
  });
});
