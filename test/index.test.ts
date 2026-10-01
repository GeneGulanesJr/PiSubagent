import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import * as subagentMod from '../src/index.js';
import type { SubagentExtensionDeps } from '../src/index.js';

const registerTool = vi.fn();
const pi = { registerTool } as unknown as ExtensionAPI;

beforeAll(() => {
  subagentMod.default(pi);
});

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  renderCall: (args: unknown, theme: unknown) => unknown;
  renderResult: (result: unknown, opts: unknown, theme: unknown) => unknown;
  execute: (
    id: string,
    params: unknown,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: { action: string; filePath?: string };
    isError?: boolean;
  }>;
}

function registeredTools(): RegisteredTool[] {
  return registerTool.mock.calls.map((c) => c[0]) as RegisteredTool[];
}

function findTool(name: string): RegisteredTool {
  const tool = registeredTools().find((t) => t.name === name);
  if (!tool) throw new Error(`tool '${name}' was not registered`);
  return tool;
}

describe('tool registration', () => {
  it("registers exactly two tools: 'subagent' and 'subagent_save'", () => {
    expect(registerTool).toHaveBeenCalledTimes(2);
    expect(
      registeredTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['subagent', 'subagent_save']);
  });

  it("registers 'subagent' with label 'Subagent'", () => {
    const tool = findTool('subagent');
    expect(tool.label).toBe('Subagent');
  });

  it('subagent description covers all three modes and agentScope', () => {
    const tool = findTool('subagent');
    expect(typeof tool.description).toBe('string');
    expect(tool.description).toContain('single');
    expect(tool.description).toContain('parallel');
    expect(tool.description).toContain('chain');
    expect(tool.description).toContain('agentScope');
  });

  it("registers 'subagent_save' with label and an overwrite-policy description", () => {
    const tool = findTool('subagent_save');
    expect(tool.label).toBe('Subagent Save');
    expect(tool.description).toContain('overwrite');
    expect(tool.description).toContain('blocked');
  });

  it('both tools expose a parameters schema object', () => {
    for (const name of ['subagent', 'subagent_save']) {
      const tool = findTool(name);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.parameters).toBe('object');
    }
  });

  it('subagent exposes renderCall and renderResult hooks', () => {
    const tool = findTool('subagent');
    expect(typeof tool.renderCall).toBe('function');
    expect(typeof tool.renderResult).toBe('function');
  });

  it('renderCall delegates with theme pass-through (returns pi-tui Text)', () => {
    const tool = findTool('subagent');
    const theme = { bold: (s: string) => `b(${s})`, fg: (c: string, t: string) => `f(${c},${t})` };
    const out = tool.renderCall({ agent: 'scout', task: 'x' }, theme) as { text: string };
    expect(out.text).toContain('b(subagent )');
    expect(out.text).toContain('f(accent,scout)');
  });

  it('renderResult delegates collapsed output for empty results (returns pi-tui Text)', () => {
    const tool = findTool('subagent');
    const theme = { bold: (s: string) => s, fg: (_c: string, t: string) => t };
    const out = tool.renderResult(
      {
        content: [{ type: 'text', text: 'plain' }],
        details: { mode: 'single', agentScope: 'user', projectAgentsDir: null, results: [] },
      },
      { expanded: false },
      theme,
    ) as { text: string };
    expect(out.text).toBe('plain');
  });
});

/* --- subagent_save execute --- */

describe('subagent_save execute', () => {
  let tmpRoot: string;
  let saveTool: RegisteredTool;
  let syncSpy: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pisubagent-save-'));
    const pi2 = { registerTool: vi.fn() } as unknown as ExtensionAPI;
    syncSpy = vi.fn(async () => []);
    subagentMod.default(pi2, {
      syncBundledShadows: syncSpy as unknown as SubagentExtensionDeps['syncBundledShadows'],
      dirs: {
        userAgentsDir: path.join(tmpRoot, 'agents'),
        basesDir: path.join(tmpRoot, 'bases'),
      },
    });
    const tools = (pi2.registerTool as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    ) as RegisteredTool[];
    saveTool = tools.find((t) => t.name === 'subagent_save')!;
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const ctx = (cwd: string, trusted = true) => ({
    cwd,
    hasUI: false,
    isProjectTrusted: () => trusted,
    ui: { confirm: async () => true },
  });

  it('creates a user-scope agent file and runs sync before saving', async () => {
    syncSpy.mockClear();
    const out = await saveTool.execute(
      'id',
      { name: 'zz-test-agent', description: 'test agent', systemPrompt: 'Do test things.' },
      undefined,
      undefined,
      ctx(tmpRoot),
    );
    expect(out.isError).toBeFalsy();
    expect(out.details.action).toBe('created');
    expect(fs.existsSync(path.join(tmpRoot, 'agents', 'zz-test-agent.md'))).toBe(true);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    const syncOpts = syncSpy.mock.calls[0][0];
    expect(syncOpts.userDir).toBe(path.join(tmpRoot, 'agents'));
    expect(syncOpts.basesDir).toBe(path.join(tmpRoot, 'bases'));
  });

  it('blocks shadowing a bundled agent without overwrite', async () => {
    syncSpy.mockClear();
    const out = await saveTool.execute(
      'id',
      { name: 'scout', description: 'd', systemPrompt: 'p' },
      undefined,
      undefined,
      ctx(tmpRoot),
    );
    expect(out.isError).toBe(true);
    expect(out.details.action).toBe('blocked');
    expect(out.content[0].text).toContain('bundled');
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks untrusted project-scope writes', async () => {
    syncSpy.mockClear();
    const out = await saveTool.execute(
      'id',
      { name: 'zz-untrusted', description: 'd', systemPrompt: 'p', scope: 'project' },
      undefined,
      undefined,
      ctx(tmpRoot, false),
    );
    expect(out.isError).toBe(true);
    expect(out.details.action).toBe('blocked');
    expect(out.content[0].text).toContain('trusted');
    expect(syncSpy).not.toHaveBeenCalled(); // project scope skips sync
  });

  it('project scope writes to the nearest existing .pi/agents (never a blind subdir)', async () => {
    syncSpy.mockClear();
    const repo = path.join(tmpRoot, 'repo');
    const agentsDir = path.join(repo, '.pi', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const cwd = path.join(repo, 'sub');
    fs.mkdirSync(cwd, { recursive: true });

    const out = await saveTool.execute(
      'id',
      { name: 'zz-proj-agent', description: 'd', systemPrompt: 'p', scope: 'project' },
      undefined,
      undefined,
      ctx(cwd),
    );
    expect(out.isError).toBeFalsy();
    expect(fs.existsSync(path.join(agentsDir, 'zz-proj-agent.md'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.pi'))).toBe(false);
    expect(syncSpy).not.toHaveBeenCalled();
  });
});
