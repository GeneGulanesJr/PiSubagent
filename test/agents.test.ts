import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseToolList, loadAgentsFromDir, findNearestProjectAgentsDir } from '../src/agents.js';

describe('parseToolList', () => {
  it('splits comma-string', () => {
    expect(parseToolList('read, bash, ls')).toEqual(['read', 'bash', 'ls']);
  });
  it('accepts array', () => {
    expect(parseToolList(['read', 'grep'])).toEqual(['read', 'grep']);
  });
  it('returns undefined for invalid shapes', () => {
    expect(parseToolList(42)).toBeUndefined();
    expect(parseToolList({})).toBeUndefined();
  });
  it('returns undefined for empty input', () => {
    expect(parseToolList('')).toBeUndefined();
    expect(parseToolList([])).toBeUndefined();
  });
});

describe('loadAgentsFromDir', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisubagent-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns [] when dir does not exist', () => {
    expect(loadAgentsFromDir(path.join(tmpDir, 'missing'), 'user')).toEqual([]);
  });

  it('loads valid .md files', () => {
    fs.copyFileSync(path.resolve('test/fixtures/minimal-agent.md'), path.join(tmpDir, 'agent.md'));
    const agents = loadAgentsFromDir(tmpDir, 'user');
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('fixture-agent');
    expect(agents[0].tools).toEqual(['read', 'bash']);
    expect(agents[0].model).toBe('claude-haiku-4-5');
    expect(agents[0].source).toBe('user');
    expect(agents[0].systemPrompt).toContain('fixture agent');
  });

  it('skips files with missing name (defensive)', () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.md'), '---\ndescription: no name\n---\nbody');
    expect(loadAgentsFromDir(tmpDir, 'user')).toEqual([]);
  });

  it('skips non-md files', () => {
    fs.writeFileSync(path.join(tmpDir, 'skip.txt'), 'ignored');
    expect(loadAgentsFromDir(tmpDir, 'user')).toEqual([]);
  });
});

describe('findNearestProjectAgentsDir', () => {
  it('finds .pi/agents walking up from cwd', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pisubagent-proj-'));
    const projectDir = path.join(tmp, '.pi', 'agents');
    fs.mkdirSync(projectDir, { recursive: true });
    expect(findNearestProjectAgentsDir(tmp)).toBe(projectDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  it('returns null when no ancestor has .pi/agents', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pisubagent-noproj-'));
    expect(findNearestProjectAgentsDir(tmp)).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
