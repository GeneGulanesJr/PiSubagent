import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { Message } from '@earendil-works/pi-ai';
import { SubprocessRunner } from '../src/runner/subprocess.js';
import { runWithRetries } from '../src/dispatch/internal.js';
import { extractStructured } from '../src/structured.js';
import type { AgentRunner, AgentRunInput } from '../src/runner/runner.js';
import type { AgentConfig, SingleResult } from '../src/types.js';

const agent: AgentConfig = {
  name: 'a',
  description: '',
  systemPrompt: '',
  source: 'bundled',
  filePath: '',
};
const input: AgentRunInput = { agent, task: 't', cwd: '/tmp' };

function makeFakeProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  // EventEmitter has no kill — install the mock the type cast promises.
  (proc as unknown as { kill: ReturnType<typeof vi.fn> }).kill = vi.fn();
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
function msgs(text: string): Message[] {
  return [{ role: 'assistant', content: [{ type: 'text', text }] }] as unknown as Message[];
}
function resultWithUsage(u: { input: number }, fail = false): SingleResult {
  return {
    agent: 'a',
    agentSource: 'user',
    task: 't',
    exitCode: fail ? 1 : 0,
    messages: msgs('ok'),
    stderr: '',
    usage: {
      input: u.input,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 1,
    },
    ...(fail ? { stopReason: 'error' as const, errorMessage: 'boom' } : {}),
  };
}

describe('review fixes', () => {
  it('prototype keys do not satisfy required properties (Object.hasOwn)', () => {
    const { structuredError } = extractStructured(msgs('{}'), {
      type: 'object',
      required: ['toString'],
    });
    expect(structuredError).toContain('missing required property: toString');
  });

  it('runWithRetries accumulates usage across retries', async () => {
    const script = [
      resultWithUsage({ input: 10 }, true),
      resultWithUsage({ input: 20 }, true),
      resultWithUsage({ input: 30 }),
    ];
    let call = 0;
    const runner: AgentRunner = {
      id: 'subprocess',
      run: vi.fn(async () => {
        const next = script[Math.min(call, script.length - 1)];
        call += 1;
        return next;
      }),
    };
    const result = await runWithRetries(
      runner,
      input,
      {
        cwd: '/tmp',
        hasUI: false,
        isProjectTrusted: () => true,
        ui: { confirm: async () => true },
      } as never,
      2,
    );
    expect(result.attempts).toBe(3);
    expect(result.usage.input).toBe(60);
  });

  it('single-attempt results keep their usage untouched (no attempts field)', async () => {
    const runner: AgentRunner = {
      id: 'subprocess',
      run: vi.fn(async () => resultWithUsage({ input: 30 })),
    };
    const result = await runWithRetries(
      runner,
      input,
      {
        cwd: '/tmp',
        hasUI: false,
        isProjectTrusted: () => true,
        ui: { confirm: async () => true },
      } as never,
      3,
    );
    expect(result.usage.input).toBe(30);
    expect('attempts' in result).toBe(false);
  });

  it('non-positive timeoutMs still arms the kill switch (floor of 1ms)', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });
    const p = runner.run({ ...input, timeoutMs: 0 });
    await waitForCloseListener(fake);
    // Let the 1ms timeout fire before closing the fake process.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.proc.kill).toHaveBeenCalledWith('SIGTERM');
    fake.finish(143);
    const result = await p;
    expect(result.timedOut).toBe(true);
  });
});
