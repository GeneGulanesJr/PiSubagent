import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { SubprocessRunner } from '../src/runner/subprocess.js';
import { execute } from '../src/dispatch.js';
import type { AgentConfig } from '../src/types.js';

/**
 * Build a fake ChildProcess whose stdout emits one JSONL burst and which
 * exits on the next tick (mirrors how pi --mode json streams then closes).
 */
function makeFakeProc(events: object[], stderr = '', exitCode = 0): ChildProcess {
  const stdout = new Readable({ read() {} });
  const stderrStream = new Readable({ read() {} });
  const state = { killed: false, exitCode: null as number | null };
  const proc = {
    stdout,
    stderr: stderrStream,
    get killed() {
      return state.killed;
    },
    get exitCode() {
      return state.exitCode;
    },
    kill: vi.fn(() => {
      state.killed = true;
      return true;
    }),
    on(ev: string, fn: (...args: unknown[]) => void) {
      if (ev === 'close') {
        setImmediate(() => {
          if (stderr) {
            stderrStream.push(Buffer.from(stderr));
            stderrStream.push(null);
          }
          stdout.push(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'));
          stdout.push(null);
          state.exitCode = exitCode;
          fn(exitCode);
        });
      }
    },
  } as unknown as ChildProcess;
  return proc;
}

const scoutAgent: AgentConfig = {
  name: 'scout',
  description: '',
  systemPrompt: '',
  source: 'bundled',
  filePath: '',
};

describe('integration smoke — JSONL through SubprocessRunner', () => {
  it('populates SingleResult from message_end events (usage, turns, model)', async () => {
    const events = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'found three files' }],
          usage: {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 0,
            cost: 0.001,
            totalTokens: 150,
          },
        },
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          usage: {
            input: 20,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.0002,
            totalTokens: 25,
          },
          model: 'claude-haiku-4-5',
        },
      },
    ];
    const proc = makeFakeProc(events, '', 0);
    const fakeSpawn = vi
      .fn()
      .mockReturnValue(proc) as unknown as typeof import('node:child_process').spawn;
    const runner = new SubprocessRunner({ spawnFn: fakeSpawn });

    const result = await runner.run({ agent: scoutAgent, task: 'find auth', cwd: '/tmp' });

    expect(result.exitCode).toBe(0);
    expect(result.messages).toHaveLength(2);
    expect(result.usage.turns).toBe(2);
    expect(result.usage.input).toBe(120); // 100 + 20
    expect(result.usage.output).toBe(55); // 50 + 5
    expect(result.usage.cost).toBeCloseTo(0.0012, 6);
    expect(result.model).toBe('claude-haiku-4-5');
    expect(result.stopReason).toBeUndefined();
  });

  it("flags stopReason 'error' + collects stderr on non-zero exit", async () => {
    const proc = makeFakeProc([], 'boom: bad model', 1);
    const fakeSpawn = vi
      .fn()
      .mockReturnValue(proc) as unknown as typeof import('node:child_process').spawn;
    const runner = new SubprocessRunner({ spawnFn: fakeSpawn });

    const result = await runner.run({ agent: scoutAgent, task: 'x', cwd: '/tmp' });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('boom');
    expect(result.stopReason).toBe('error');
  });

  it('full dispatch path: execute() single mode returns model output as content', async () => {
    const events = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '## Files Retrieved\n- src/auth.ts' }],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 15 },
        },
      },
    ];
    const proc = makeFakeProc(events, '', 0);
    const fakeSpawn = vi
      .fn()
      .mockReturnValue(proc) as unknown as typeof import('node:child_process').spawn;
    const runner = new SubprocessRunner({ spawnFn: fakeSpawn });

    const ctx = {
      cwd: '/tmp',
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { confirm: vi.fn().mockResolvedValue(true) },
    };
    const out = await execute(
      { agent: 'scout', task: 'find auth' },
      ctx as never,
      [scoutAgent],
      runner,
    );
    expect(out.isError).toBeFalsy();
    expect(out.content[0].type === 'text' && out.content[0].text).toContain('src/auth.ts');
    expect(out.details.results).toHaveLength(1);
    expect(out.details.mode).toBe('single');
  });
});
