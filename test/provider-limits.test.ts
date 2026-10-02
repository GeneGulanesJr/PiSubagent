import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_PROVIDER_CONCURRENCY,
  providerOfModel,
  readProviderLimitsFile,
  loadProviderLimits,
  resetProviderLimitsCache,
} from '../src/provider-limits.js';

describe('providerOfModel', () => {
  it('extracts the lowercased provider prefix', () => {
    expect(providerOfModel('zai/glm-5.3-flash')).toBe('zai');
    expect(providerOfModel('  minimax/minimax-m2.5 ')).toBe('minimax');
    expect(providerOfModel('ZAI/glm')).toBe('zai');
  });

  it('returns undefined for bare ids and absent models', () => {
    expect(providerOfModel('claude-haiku-4-5')).toBeUndefined();
    expect(providerOfModel('/no-provider')).toBeUndefined();
    expect(providerOfModel('')).toBeUndefined();
    expect(providerOfModel(undefined)).toBeUndefined();
  });
});

describe('readProviderLimitsFile', () => {
  it('returns defaults when the file is missing', () => {
    const result = readProviderLimitsFile(path.join(os.tmpdir(), 'definitely-missing-limits.json'));
    expect(result).toEqual(DEFAULT_PROVIDER_CONCURRENCY);
  });

  it('degrades to defaults on malformed JSON or non-object payloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-'));
    const cases = ['not json{', 'null', '[1, 2]', '"zai"', '42'].map((body) => {
      const file = path.join(dir, `case-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(file, body);
      return readProviderLimitsFile(file);
    });
    for (const result of cases) expect(result).toEqual(DEFAULT_PROVIDER_CONCURRENCY);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('overrides valid entries, ignores invalid ones (cap must be a positive integer)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-'));
    const file = path.join(dir, 'limits.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        zai: 5,
        minimax: 0, // zero would deadlock the scheduler — ignored
        anthropic: -1, // negative — ignored
        openai: 2.5, // fractional — ignored
        google: '3', // non-number — ignored
        ' ZAI ': 7, // duplicate key after normalization — last valid wins
      }),
    );
    const result = readProviderLimitsFile(file);
    expect(result.zai).toBe(7);
    expect(result.minimax).toBe(DEFAULT_PROVIDER_CONCURRENCY.minimax);
    expect(result.anthropic).toBeUndefined();
    expect(result.openai).toBeUndefined();
    expect(result.google).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('loadProviderLimits', () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-agent-dir-'));
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

  it('reads pisubagent.limits.json from the agent dir and caches it', () => {
    const file = path.join(tmpDir, 'pisubagent.limits.json');
    fs.writeFileSync(file, JSON.stringify({ zai: 5 }));
    expect(loadProviderLimits().zai).toBe(5);
    // Cache holds even if the file changes afterwards.
    fs.writeFileSync(file, JSON.stringify({ zai: 1 }));
    expect(loadProviderLimits().zai).toBe(5);
    resetProviderLimitsCache();
    expect(loadProviderLimits().zai).toBe(1);
  });

  it('falls back to defaults when the agent dir has no limits file', () => {
    expect(loadProviderLimits()).toEqual(DEFAULT_PROVIDER_CONCURRENCY);
  });
});
