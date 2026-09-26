import { describe, it, expect } from 'vitest';
import type { vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { Message } from '@earendil-works/pi-ai';
import { SubprocessRunner } from '../src/runner/subprocess.js';
import { execute } from '../src/dispatch.js';
import type { DispatchContext } from '../src/dispatch/types.js';
import type { AgentRunner, AgentRunInput } from '../src/runner/runner.js';
import type { AgentConfig } from '../src/types.js';

const baseAgent: AgentConfig = {
  name: 'scout',
  description: '',
  systemPrompt: '',
  source: 'bundled',
  filePath: '',
};
const baseInput = { agent: baseAgent, task: 'do work', cwd: '/tmp' };

function makeFakeProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  (proc as unknown as { stdout: Readable }).stdout = stdout;
  (proc as unknown as { stderr: Readable }).stderr = stderr;
  const finish = (code: number | null = 0) => {
    stdout.push(null);
    stderr.push(null);
    proc.emit('close', code);
  };
  return { proc, finish };
}

async function waitForCloseListener(p: ReturnType<typeof makeFakeProc>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (p.proc.listenerCount('close') >= 1) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeRecordingRunner() {
  const seen: AgentRunInput[] = [];
  const runner = {
    run: async (input: AgentRunInput) => {
      seen.push(input);
      return {
        agent: input.agent.name,
        agentSource: 'user',
        task: input.task,
        exitCode: 0,
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        ] as unknown as Message[],
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
    },
  } as unknown as AgentRunner;
  return { seen, runner };
}

const ctx = {
  cwd: '/tmp',
  hasUI: false,
  isProjectTrusted: () => true,
  ui: { confirm: async () => true },
} as unknown as DispatchContext;

describe('buildArgs — session flag composition', () => {
  it('defaults to --no-session', () => {
    const args = new SubprocessRunner().buildArgs({ ...baseInput }, {});
    expect(args).toContain('--no-session');
    expect(args).not.toContain('--session');
    expect(args).not.toContain('--session-id');
  });

  it('emits --session <resume> when input.resume is set', () => {
    const args = new SubprocessRunner().buildArgs({ ...baseInput, resume: 'abc123' }, {});
    const i = args.indexOf('--session');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('abc123');
    expect(args).not.toContain('--no-session');
    expect(args).not.toContain('--session-id');
  });

  it('emits --session-id <id> when only input.sessionId is set', () => {
    const args = new SubprocessRunner().buildArgs({ ...baseInput, sessionId: 'fixed-id' }, {});
    const i = args.indexOf('--session-id');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('fixed-id');
    expect(args).not.toContain('--no-session');
    expect(args).not.toContain('--session');
  });

  it('resume wins when both resume and sessionId are set', () => {
    const args = new SubprocessRunner().buildArgs(
      { ...baseInput, resume: 'abc123', sessionId: 'fixed-id' },
      {},
    );
    expect(args).toContain('--session');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--no-session');
  });

  it('places session flags before model flags', () => {
    const args = new SubprocessRunner().buildArgs(
      { ...baseInput, agent: { ...baseAgent, model: 'm1' }, resume: 'r' },
      {},
    );
    expect(args.indexOf('--session')).toBeGreaterThan(-1);
    expect(args.indexOf('--model')).toBeGreaterThan(-1);
    expect(args.indexOf('--session')).toBeLessThan(args.indexOf('--model'));
  });
});

describe('run — sessionId reporting', () => {
  it('generates a uuid when session: true', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });
    const p = runner.run({ ...baseInput, session: true });
    await waitForCloseListener(fake);
    fake.finish(0);
    const r = await p;
    expect(r.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('reports the provided sessionId', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });
    const p = runner.run({ ...baseInput, sessionId: 'fixed-id' });
    await waitForCloseListener(fake);
    fake.finish(0);
    const r = await p;
    expect(r.sessionId).toBe('fixed-id');
  });

  it('reports the resume id', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });
    const p = runner.run({ ...baseInput, resume: 'r1' });
    await waitForCloseListener(fake);
    fake.finish(0);
    const r = await p;
    expect(r.sessionId).toBe('r1');
  });

  it('reports no sessionId by default', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });
    const p = runner.run({ ...baseInput });
    await waitForCloseListener(fake);
    fake.finish(0);
    const r = await p;
    expect(r.sessionId).toBeUndefined();
  });
});

describe('dispatch pass-through — session/resume', () => {
  it('forwards session from params into the runner input', async () => {
    const { seen, runner } = makeRecordingRunner();
    await execute({ agent: 'a', task: 't', session: true }, ctx, [baseAgent], runner);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.session).toBe(true);
  });

  it('forwards resume from tasks[] item into the runner input', async () => {
    const { seen, runner } = makeRecordingRunner();
    await execute({ tasks: [{ agent: 'a', task: 't', resume: 'r9' }] }, ctx, [baseAgent], runner);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.resume).toBe('r9');
  });

  it('forwards session from chain[] item into the runner input', async () => {
    const { seen, runner } = makeRecordingRunner();
    await execute({ chain: [{ agent: 'a', task: 't', session: true }] }, ctx, [baseAgent], runner);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.session).toBe(true);
  });
});
