import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentRunner, AgentRunInput } from '../src/runner/runner.js';
import type { AgentConfig, SingleResult } from '../src/types.js';
import type { DispatchContext } from '../src/dispatch/types.js';
import {
  parseTier,
  resolveRunModel,
  readTierModelsFile,
  DEFAULT_TIER_MODELS,
} from '../src/tier.js';
import { resolveThinkingLevel } from '../src/thinking.js';
import { SubprocessRunner } from '../src/runner/subprocess/runner.js';
import { runWithRetries } from '../src/dispatch/internal.js';

/* ------------------------------------------------------------------ parseTier */

describe('parseTier', () => {
  it('accepts valid tiers (case-insensitive, trimmed)', () => {
    expect(parseTier('cheap')).toBe('cheap');
    expect(parseTier(' thinking ')).toBe('thinking');
    expect(parseTier('CHEAP')).toBe('cheap');
  });

  it('rejects invalid and absent values', () => {
    expect(parseTier('fast')).toBeUndefined();
    expect(parseTier('')).toBeUndefined();
    expect(parseTier(undefined)).toBeUndefined();
    expect(parseTier(42)).toBeUndefined();
    expect(parseTier(null)).toBeUndefined();
  });
});

/* ------------------------------------------------------------- readTierModelsFile */

describe('readTierModelsFile', () => {
  it('returns defaults when the file is missing', () => {
    const result = readTierModelsFile(path.join(os.tmpdir(), 'definitely-missing-tiers.json'));
    expect(result).toEqual(DEFAULT_TIER_MODELS);
  });

  it('overrides valid entries and keeps defaults for invalid ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiers-'));
    const file = path.join(dir, 'tiers.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ cheap: 'acme/budget-model', thinking: 'no-slash', bogus: 'x/y' }),
    );
    const result = readTierModelsFile(file);
    expect(result.cheap).toBe('acme/budget-model');
    expect(result.thinking).toBe(DEFAULT_TIER_MODELS.thinking);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('degrades to defaults on malformed JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiers-'));
    const file = path.join(dir, 'tiers.json');
    fs.writeFileSync(file, '{not json');
    expect(readTierModelsFile(file)).toEqual(DEFAULT_TIER_MODELS);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* -------------------------------------------------------------- resolveRunModel */

describe('resolveRunModel', () => {
  const agent = (over: Partial<AgentConfig> = {}): AgentConfig => ({
    name: 'a',
    description: '',
    systemPrompt: '',
    source: 'bundled',
    filePath: '',
    ...over,
  });

  it('per-dispatch model override beats everything', () => {
    const r = resolveRunModel(agent({ model: 'zai/glm-5.3', tier: 'cheap' }), {
      modelOverride: 'acme/one-off',
      tierOverride: 'thinking',
    });
    expect(r).toEqual({ model: 'acme/one-off', tier: undefined });
  });

  it('per-dispatch tier beats agent frontmatter', () => {
    const r = resolveRunModel(agent({ model: 'zai/glm-5.3', tier: 'cheap' }), {
      tierOverride: 'thinking',
    });
    expect(r.model).toBe(DEFAULT_TIER_MODELS.thinking);
    expect(r.tier).toBe('thinking');
  });

  it('agent frontmatter model pin wins over frontmatter tier', () => {
    const r = resolveRunModel(agent({ model: 'zai/glm-5.3', tier: 'cheap' }));
    expect(r).toEqual({ model: 'zai/glm-5.3', tier: undefined });
  });

  it('agent frontmatter tier resolves via the tier map', () => {
    const r = resolveRunModel(agent({ tier: 'cheap' }));
    expect(r.model).toBe(DEFAULT_TIER_MODELS.cheap);
    expect(r.tier).toBe('cheap');
  });

  it('undefined everywhere → parent inheritance', () => {
    expect(resolveRunModel(agent())).toEqual({ model: undefined, tier: undefined });
  });
});

/* -------------------------------------------------- resolveThinkingLevel + tier */

describe('resolveThinkingLevel with tiers', () => {
  it('tier-routed runs default to the tier thinking level', () => {
    expect(resolveThinkingLevel({}, { tier: 'cheap' })).toBe('medium');
    expect(resolveThinkingLevel({}, { tier: 'thinking' })).toBe('high');
  });

  it('per-dispatch override still beats the tier default', () => {
    expect(resolveThinkingLevel({}, { tier: 'thinking', thinkingLevelOverride: 'off' })).toBe(
      'off',
    );
  });

  it('parent inheritance is skipped for tier-routed runs', () => {
    expect(resolveThinkingLevel({}, { tier: 'cheap', parentThinkingLevel: 'max' })).toBe('medium');
  });
});

/* ------------------------------------------------------------------- buildArgs */

describe('SubprocessRunner.buildArgs with tiers', () => {
  const runner = new SubprocessRunner();
  const agent = (over: Partial<AgentConfig> = {}): AgentConfig => ({
    name: 'a',
    description: '',
    systemPrompt: '',
    source: 'bundled',
    filePath: '',
    ...over,
  });

  it('emits --model with the tier model and --thinking with the tier default', () => {
    const args = runner.buildArgs(
      { agent: agent({ tier: 'thinking' }), task: 't', cwd: '/tmp', tierOverride: 'thinking' },
      { parentModel: 'zai/glm-5.3', parentThinkingLevel: 'low' },
    );
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe(DEFAULT_TIER_MODELS.thinking);
    const thinkingIdx = args.indexOf('--thinking');
    expect(args[thinkingIdx + 1]).toBe('high');
  });

  it('explicit model override beats tier in --model', () => {
    const args = runner.buildArgs(
      {
        agent: agent(),
        task: 't',
        cwd: '/tmp',
        modelOverride: 'acme/pinned',
        tierOverride: 'cheap',
      },
      { parentModel: 'zai/glm-5.3' },
    );
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('acme/pinned');
  });

  it('no tier, no pin → parent model inheritance (existing contract)', () => {
    const args = runner.buildArgs(
      { agent: agent(), task: 't', cwd: '/tmp' },
      { parentModel: 'zai/glm-5.3' },
    );
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('zai/glm-5.3');
  });
});

/* ------------------------------------------------- runWithRetries tier fallback */

function makeResult(agentName: string, over: Partial<SingleResult> = {}): SingleResult {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ] as unknown as Message[];
  return {
    agent: agentName,
    agentSource: 'user',
    task: 't',
    exitCode: 0,
    messages,
    stderr: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    ...over,
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

describe('runWithRetries tier fallback', () => {
  const tierAgent: AgentConfig = {
    name: 'a',
    description: '',
    systemPrompt: '',
    source: 'bundled',
    filePath: '',
    tier: 'cheap',
  };
  const baseInput: AgentRunInput = {
    agent: tierAgent,
    task: 't',
    cwd: '/tmp',
    parentModel: 'zai/glm-5.3',
  };

  it('falls back to the parent model once when the tier-routed run fails', async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
      id: 'subprocess',
      async run(input) {
        const r = resolveRunModel(input.agent, {
          modelOverride: input.modelOverride,
          tierOverride: input.tierOverride,
        });
        calls.push(r.model ?? '(inherit)');
        if (r.tier) {
          return makeResult(input.agent.name, {
            exitCode: 1,
            stopReason: 'error',
            errorMessage: 'minimax quota exhausted',
          });
        }
        return makeResult(input.agent.name);
      },
    };
    const result = await runWithRetries(runner, baseInput, trustyCtx(), 0);
    expect(calls).toEqual([DEFAULT_TIER_MODELS.cheap, 'zai/glm-5.3']);
    expect(result.exitCode).toBe(0);
    expect(result.fellBackToParent).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.stderr).toContain('tier fallback');
  });

  it('does not fall back for explicit model pins', async () => {
    let calls = 0;
    const runner: AgentRunner = {
      id: 'subprocess',
      async run() {
        calls += 1;
        return makeResult('a', { exitCode: 1, stopReason: 'error', errorMessage: 'boom' });
      },
    };
    const result = await runWithRetries(
      runner,
      { ...baseInput, agent: { ...tierAgent, tier: undefined, model: 'acme/pinned' } },
      trustyCtx(),
      0,
    );
    expect(calls).toBe(1);
    expect(result.fellBackToParent).toBeUndefined();
    expect(result.exitCode).toBe(1);
  });

  it('returns the fallback result when the fallback also fails', async () => {
    let calls = 0;
    const runner: AgentRunner = {
      id: 'subprocess',
      async run() {
        calls += 1;
        return makeResult('a', {
          exitCode: 1,
          stopReason: 'error',
          errorMessage: `failure #${calls}`,
        });
      },
    };
    const result = await runWithRetries(runner, baseInput, trustyCtx(), 0);
    expect(calls).toBe(2);
    expect(result.fellBackToParent).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('successful tier-routed runs never fall back', async () => {
    let calls = 0;
    const runner: AgentRunner = {
      id: 'subprocess',
      async run(input) {
        calls += 1;
        return makeResult(input.agent.name, { model: DEFAULT_TIER_MODELS.cheap, tier: 'cheap' });
      },
    };
    const result = await runWithRetries(runner, baseInput, trustyCtx(), 0);
    expect(calls).toBe(1);
    expect(result.fellBackToParent).toBeUndefined();
    expect(result.tier).toBe('cheap');
  });
});
