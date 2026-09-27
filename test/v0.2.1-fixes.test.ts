import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { Message } from '@earendil-works/pi-ai';
import { SubprocessRunner } from '../src/runner/subprocess.js';
import { execute } from '../src/dispatch.js';
import { isFailedResult } from '../src/output.js';
import type { DispatchContext } from '../src/dispatch.js';
import { extractStructured } from '../src/structured.js';
import type { AgentRunner, AgentRunInput } from '../src/runner/runner.js';
import type { AgentConfig, SingleResult } from '../src/types.js';
import { emitCloseSticky, waitForCloseListener } from './helpers/fake-close.js';

const agent: AgentConfig = {
  name: 'a',
  description: '',
  systemPrompt: '',
  source: 'bundled',
  filePath: '',
};
const ctx = {
  cwd: '/tmp',
  hasUI: false,
  isProjectTrusted: () => true,
  ui: { confirm: async () => true },
} as DispatchContext;

function makeFakeProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as unknown as ChildProcess;
  (proc as unknown as { stdout: Readable }).stdout = stdout;
  (proc as unknown as { stderr: Readable }).stderr = stderr;
  proc.kill = vi.fn(() => true) as never;
  const finish = (code: number | null = 0) => {
    stdout.push(null);
    stderr.push(null);
    emitCloseSticky(proc, code);
  };
  return { proc, finish };
}
function msgs(text: string): Message[] {
  return [{ role: 'assistant', content: [{ type: 'text', text }] }] as unknown as Message[];
}
function stubRunner(text = 'ok'): AgentRunner {
  const impl = async (input: AgentRunInput): Promise<SingleResult> => ({
    agent: input.agent.name,
    agentSource: 'user',
    task: input.task,
    exitCode: 0,
    messages: msgs(text),
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
  });
  return { id: 'subprocess', run: vi.fn(impl) };
}

describe('v0.2.1 fixes', () => {
  it('timeout produces stopReason "timeout" (not "aborted"), timedOut, and SIGTERM', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });
    const promise = runner.run({ agent, task: 't', cwd: '/tmp', timeoutMs: 50 });
    await waitForCloseListener(fake.proc);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fake.proc.kill).toHaveBeenCalledWith('SIGTERM');
    fake.finish(143);
    const result: SingleResult = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.stopReason).toBe('timeout');
    expect(result.errorMessage).toContain('run timeout after 50ms');
  });

  it('rejects outputSchema with tasks dispatch before invoking the runner', async () => {
    const runner = stubRunner();
    const out = await execute(
      { tasks: [{ agent: 'a', task: 't' }], outputSchema: { type: 'object' } },
      ctx,
      [agent],
      runner,
    );
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('single-mode only');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('rejects outputSchema with chain dispatch', async () => {
    const runner = stubRunner();
    const out = await execute(
      { chain: [{ agent: 'a', task: 't' }], outputSchema: { type: 'object' } },
      ctx,
      [agent],
      runner,
    );
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('single-mode only');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('null payload validates when the schema is silent about type', () => {
    const { data, structuredError } = extractStructured(msgs('null'), { required: ['a'] });
    expect(data).toBeNull();
    expect(structuredError).toBeUndefined();
  });

  it('type:object schema still rejects null payloads', () => {
    const { structuredError } = extractStructured(msgs('null'), { type: 'object' });
    expect(structuredError).toContain('must be object');
  });

  it('outputSchema still works in single mode', async () => {
    // The stub replies with the JSON string literal '"ok"' so structured
    // extraction parses it to the string 'ok' (JSON.parse('ok') would fail).
    const out = await execute(
      { agent: 'a', task: 't', outputSchema: { type: 'string' } },
      ctx,
      [agent],
      stubRunner('"ok"'),
    );
    expect(out.isError).toBe(false);
    expect(out.details.results[0].data).toBe('ok');
  });

  it('isFailedResult classifies stopReason timeout without timedOut', () => {
    // Defense-in-depth: a future runner setting 'timeout' alone must not
    // classify as success just because the timedOut flag is absent.
    const result = {
      agent: 'a',
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
      stopReason: 'timeout',
    } as unknown as SingleResult;
    expect(isFailedResult(result)).toBe(true);
  });
});
