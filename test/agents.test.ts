import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseToolList, loadAgentsFromDir, findNearestProjectAgentsDir } from '../src/agents.js';
import {
  parseThinkingLevel,
  resolveThinkingLevel,
  DEFAULT_SUBAGENT_THINKING,
} from '../src/thinking.js';

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

describe('parseThinkingLevel', () => {
  it.each(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'accepts valid level %s',
    (level) => {
      expect(parseThinkingLevel(level)).toBe(level);
    },
  );

  it('normalizes case and whitespace', () => {
    expect(parseThinkingLevel('  HIGH ')).toBe('high');
  });

  it('returns undefined for invalid or absent values', () => {
    expect(parseThinkingLevel('ultra')).toBeUndefined();
    expect(parseThinkingLevel(42)).toBeUndefined();
    expect(parseThinkingLevel(undefined)).toBeUndefined();
  });
});

describe('resolveThinkingLevel', () => {
  const pinned = { model: 'claude-sonnet-4-5' };

  it('ladder: override > frontmatter > parent-inherit > default', () => {
    expect(
      resolveThinkingLevel(
        { ...pinned, thinkingLevel: 'high' },
        {
          thinkingLevelOverride: 'off',
          parentThinkingLevel: 'max',
        },
      ),
    ).toBe('off');
    expect(
      resolveThinkingLevel({ ...pinned, thinkingLevel: 'high' }, { parentThinkingLevel: 'max' }),
    ).toBe('high');
    expect(resolveThinkingLevel(pinned, { parentThinkingLevel: 'low' })).toBe('medium');
    expect(resolveThinkingLevel({}, { parentThinkingLevel: 'low' })).toBe('low');
  });

  it('no model anywhere and no parent level → undefined (child pi decides)', () => {
    expect(resolveThinkingLevel({}, {})).toBeUndefined();
  });

  it('model pinned with no other signal → DEFAULT_SUBAGENT_THINKING', () => {
    expect(resolveThinkingLevel(pinned, {})).toBe(DEFAULT_SUBAGENT_THINKING);
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

  it('parses thinkingLevel frontmatter; invalid values are ignored', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'deep.md'),
      '---\nname: deep\ndescription: d\nmodel: claude-sonnet-4-5\nthinkingLevel: high\n---\nbody',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'broken.md'),
      '---\nname: broken\ndescription: d\nthinkingLevel: ultra\n---\nbody',
    );
    const agents = loadAgentsFromDir(tmpDir, 'user');
    expect(agents.find((a) => a.name === 'deep')?.thinkingLevel).toBe('high');
    expect(agents.find((a) => a.name === 'broken')?.thinkingLevel).toBeUndefined();
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
