import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  MINOR_DIFF_RATIO,
  extractUnknownFrontmatterBlocks,
  readBaseSnapshot,
  saveAgentDefinition,
  serializeAgentDefinition,
  writeAndVerify,
  type SaveDefinitionInput,
} from '../src/agent-store.js';
import { loadAgentsFromDir } from '../src/agents.js';
import { normalizeText } from '../src/text-diff.js';

const TEN_LINE_PROMPT = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

function makeInput(overrides: Partial<SaveDefinitionInput> = {}): SaveDefinitionInput {
  return {
    name: 'test-agent',
    description: 'A test agent',
    systemPrompt: TEN_LINE_PROMPT,
    ...overrides,
  };
}

describe('saveAgentDefinition — validation', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisubagent-store-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const opts = (dir: string) => ({
    targetDir: dir,
    sourceLabel: 'user' as const,
    otherSources: [],
    basesDir: path.join(dir, '..', 'bases'),
  });

  it.each([
    'UPPER',
    'has_underscore',
    '-starts-hyphen',
    'ends-',
    'has.dot',
    'has space',
    '',
    'a'.repeat(65),
  ])('rejects invalid name %j', async (name) => {
    const out = await saveAgentDefinition(makeInput({ name }), opts(tmpDir));
    expect(out.ok).toBe(false);
    expect(out.action).toBe('error');
    expect(fs.existsSync(path.join(tmpDir, `${name}.md`))).toBe(false);
  });

  it('rejects empty description and empty systemPrompt', async () => {
    const noDesc = await saveAgentDefinition(makeInput({ description: '   ' }), opts(tmpDir));
    expect(noDesc.action).toBe('error');
    const noPrompt = await saveAgentDefinition(makeInput({ systemPrompt: '' }), opts(tmpDir));
    expect(noPrompt.action).toBe('error');
  });

  it('warns when both model and tier are set (model pin wins, tier is dead)', async () => {
    const out = await saveAgentDefinition(
      makeInput({ model: 'openai/gpt-5', tier: 'cheap' }),
      opts(tmpDir),
    );
    expect(out.ok).toBe(true);
    expect(out.warnings.some((w) => w.includes('tier is ignored'))).toBe(true);
  });

  it('accepts valid kebab-case names', async () => {
    for (const name of ['a', 'a1', 'test-agent', 'x'.repeat(64)]) {
      const out = await saveAgentDefinition(
        makeInput({ name, description: `agent ${name}` }),
        opts(tmpDir),
      );
      expect(out.ok).toBe(true);
    }
  });
});

describe('saveAgentDefinition — outcome ladder', () => {
  let tmpDir: string;
  let agentsDir: string;
  let basesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisubagent-store-'));
    agentsDir = path.join(tmpDir, 'agents');
    basesDir = path.join(tmpDir, 'bases');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const opts = (
    otherSources: Parameters<typeof saveAgentDefinition>[1]['otherSources'] = [],
    sourceLabel: 'user' | 'project' = 'user',
  ) => ({
    targetDir: agentsDir,
    sourceLabel,
    otherSources,
    basesDir,
  });

  it('creates a new agent; file round-trips through loadAgentsFromDir', async () => {
    const out = await saveAgentDefinition(makeInput(), opts());
    expect(out.ok).toBe(true);
    expect(out.action).toBe('created');
    expect(out.filePath).toBe(path.join(agentsDir, 'test-agent.md'));

    const agents = loadAgentsFromDir(agentsDir, 'user');
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('test-agent');
    expect(agents[0].description).toBe('A test agent');
    expect(normalizeText(agents[0].systemPrompt)).toBe(normalizeText(TEN_LINE_PROMPT));
  });

  it('round-trips scalar-typed frontmatter traps without dropping the agent', async () => {
    const traps = ['true', 'null', '2024', 'a: b', 'x #y', 'quoted "value"', 'uni: ünïcødé ✓'];
    let i = 0;
    for (const description of traps) {
      const out = await saveAgentDefinition(
        makeInput({ name: `trap-${i++}`, description }),
        opts(),
      );
      expect(out.ok).toBe(true);
    }
    const agents = loadAgentsFromDir(agentsDir, 'user');
    expect(agents).toHaveLength(traps.length);
    expect(agents.map((a) => a.description)).toEqual(traps);
  });

  it('is idempotent: identical input reports unchanged and does not rewrite', async () => {
    await saveAgentDefinition(makeInput(), opts());
    const filePath = path.join(agentsDir, 'test-agent.md');
    const before = fs.readFileSync(filePath, 'utf-8');
    const out = await saveAgentDefinition(makeInput(), opts());
    expect(out.action).toBe('unchanged');
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
  });

  it('auto-applies minor updates (small prompt edit, ≤20% of lines)', async () => {
    await saveAgentDefinition(makeInput(), opts());
    const edited = TEN_LINE_PROMPT.replace('line 5', 'line 5 EDITED');
    const out = await saveAgentDefinition(makeInput({ systemPrompt: edited }), opts());
    expect(out.ok).toBe(true);
    expect(out.action).toBe('updated');
    expect(out.change?.promptLinesAdded).toBe(1);
    expect(out.change?.promptLinesRemoved).toBe(1);
    const agents = loadAgentsFromDir(agentsDir, 'user');
    expect(agents[0].systemPrompt).toContain('line 5 EDITED');
  });

  it('treats description-only changes as minor', async () => {
    await saveAgentDefinition(makeInput(), opts());
    const out = await saveAgentDefinition(
      makeInput({ description: 'Updated description' }),
      opts(),
    );
    expect(out.action).toBe('updated');
    expect(out.change?.fields).toEqual(['description']);
  });

  it('blocks major updates (large rewrite) without overwrite; replaces with it', async () => {
    await saveAgentDefinition(makeInput(), opts());
    const rewritten = Array.from({ length: 12 }, (_, i) => `totally different ${i}`).join('\n');

    const blocked = await saveAgentDefinition(makeInput({ systemPrompt: rewritten }), opts());
    expect(blocked.ok).toBe(false);
    expect(blocked.action).toBe('blocked');
    expect(blocked.message).toContain('overwrite: true');
    expect(blocked.change?.ratio).toBeGreaterThan(MINOR_DIFF_RATIO);
    // nothing was written
    expect(loadAgentsFromDir(agentsDir, 'user')[0].systemPrompt).toContain('line 1');

    const forced = await saveAgentDefinition(
      makeInput({ systemPrompt: rewritten, overwrite: true }),
      opts(),
    );
    expect(forced.ok).toBe(true);
    expect(forced.action).toBe('replaced');
    expect(loadAgentsFromDir(agentsDir, 'user')[0].systemPrompt).toContain('totally different 0');
  });

  it.each(['tools', 'model', 'tier', 'thinkingLevel'] as const)(
    'blocks %s changes without overwrite (frontmatter behavior fields are major)',
    async (field) => {
      await saveAgentDefinition(makeInput(), opts());
      const out = await saveAgentDefinition(
        makeInput({ [field]: 'medium' } as Partial<SaveDefinitionInput>),
        opts(),
      );
      expect(out.ok).toBe(false);
      expect(out.action).toBe('blocked');
      expect(out.change?.fields).toContain(field);
    },
  );

  it('compares tools as an unordered set (reordering is unchanged)', async () => {
    await saveAgentDefinition(makeInput({ tools: 'read, grep, bash' }), opts());
    const out = await saveAgentDefinition(makeInput({ tools: 'bash, read, grep' }), opts());
    expect(out.action).toBe('unchanged');
  });

  it('dedupes tools on write', async () => {
    await saveAgentDefinition(makeInput({ tools: 'read, grep, read' }), opts());
    const raw = fs.readFileSync(path.join(agentsDir, 'test-agent.md'), 'utf-8');
    expect(raw).toContain('tools: "read, grep"');
  });

  it('preserves unknown frontmatter keys across a minor update', async () => {
    await saveAgentDefinition(makeInput(), opts());
    const filePath = path.join(agentsDir, 'test-agent.md');
    const withExtras = fs
      .readFileSync(filePath, 'utf-8')
      .replace('---\n', '---\nauthor: "someone"\ntags:\n  - alpha\n  - beta\n');
    fs.writeFileSync(filePath, withExtras);

    const out = await saveAgentDefinition(
      makeInput({ systemPrompt: TEN_LINE_PROMPT.replace('line 3', 'line 3 EDITED') }),
      opts(),
    );
    expect(out.action).toBe('updated');
    const raw = fs.readFileSync(filePath, 'utf-8');
    expect(raw).toContain('author: "someone"');
    expect(raw).toContain('- alpha');
    expect(raw).toContain('- beta');
    const agents = loadAgentsFromDir(agentsDir, 'user');
    expect(agents[0].systemPrompt).toContain('line 3 EDITED');
  });

  it('blocks when the target file defines a different agent name', async () => {
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'scout.md'),
      '---\nname: other-agent\ndescription: d\n---\nbody',
    );
    const out = await saveAgentDefinition(makeInput({ name: 'scout' }), opts());
    expect(out.ok).toBe(false);
    expect(out.action).toBe('blocked');
    expect(out.message).toContain('other-agent');
  });

  it('blocks when the target dir has duplicate definitions of the name', async () => {
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const file of ['a.md', 'b.md']) {
      fs.writeFileSync(path.join(agentsDir, file), '---\nname: dupe\ndescription: d\n---\nbody');
    }
    const out = await saveAgentDefinition(makeInput({ name: 'dupe' }), opts());
    expect(out.ok).toBe(false);
    expect(out.action).toBe('blocked');
    expect(out.message).toContain('duplicate');
  });

  it('replaces an unparseable target file and says so', async () => {
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'test-agent.md'), '---\nname: "broken\n---\nbody');
    const out = await saveAgentDefinition(makeInput(), opts());
    expect(out.ok).toBe(true);
    expect(out.action).toBe('created');
    expect(out.message).toContain('unparseable');
    expect(loadAgentsFromDir(agentsDir, 'user')).toHaveLength(1);
  });
});

describe('saveAgentDefinition — shadowing and scope notes', () => {
  let tmpDir: string;
  let agentsDir: string;
  let projectDir: string;
  let basesDir: string;
  let fakeBundledFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisubagent-shadow-'));
    agentsDir = path.join(tmpDir, 'user-agents');
    projectDir = path.join(tmpDir, 'proj-agents');
    basesDir = path.join(tmpDir, 'bases');
    fakeBundledFile = path.join(tmpDir, 'bundled-scout.md');
    fs.writeFileSync(
      fakeBundledFile,
      '---\nname: scout\ndescription: "Bundled scout"\n---\nBundled scout prompt.',
    );
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const bundledShadow = () => ({
    name: 'scout',
    description: 'Bundled scout',
    systemPrompt: 'Bundled scout prompt.',
    source: 'bundled' as const,
    filePath: fakeBundledFile,
  });
  const projectShadow = () => ({
    name: 'test-agent',
    description: 'project copy',
    systemPrompt: 'p',
    source: 'project' as const,
    filePath: path.join(projectDir, 'test-agent.md'),
  });
  const userShadow = () => ({
    name: 'test-agent',
    description: 'user copy',
    systemPrompt: 'p',
    source: 'user' as const,
    filePath: path.join(agentsDir, 'test-agent.md'),
  });

  it('blocks shadowing a bundled agent without overwrite; allows with it + records base', async () => {
    const blocked = await saveAgentDefinition(makeInput({ name: 'scout' }), {
      targetDir: agentsDir,
      sourceLabel: 'user',
      otherSources: [bundledShadow()],
      basesDir,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.action).toBe('blocked');
    expect(fs.existsSync(path.join(agentsDir, 'scout.md'))).toBe(false);

    const allowed = await saveAgentDefinition(
      makeInput({ name: 'scout', description: 'My scout', overwrite: true }),
      { targetDir: agentsDir, sourceLabel: 'user', otherSources: [bundledShadow()], basesDir },
    );
    expect(allowed.ok).toBe(true);
    expect(allowed.action).toBe('created-shadow');

    const base = readBaseSnapshot(basesDir, 'scout');
    expect(base).not.toBeNull();
    expect(base!.sha256).toBeTruthy();
    expect(base!.content).toBe(normalizeText(fs.readFileSync(fakeBundledFile, 'utf-8')));
  });

  it('saving user scope over a project-scope name: created + scope-aware note', async () => {
    const out = await saveAgentDefinition(makeInput(), {
      targetDir: agentsDir,
      sourceLabel: 'user',
      otherSources: [projectShadow()],
      basesDir,
    });
    expect(out.ok).toBe(true);
    expect(out.action).toBe('created');
    expect(out.warnings.join(' ')).toContain("agentScope 'both'");
    expect(out.warnings.join(' ')).toContain("'project' → your copy is not loaded");
  });

  it('saving project scope over a user-scope name: created + inverse note', async () => {
    const out = await saveAgentDefinition(makeInput(), {
      targetDir: projectDir,
      sourceLabel: 'project',
      otherSources: [userShadow()],
      basesDir,
    });
    expect(out.ok).toBe(true);
    expect(out.action).toBe('created');
    expect(out.warnings.join(' ')).toContain("'both'/'project' → your new project copy wins");
  });
});

describe('serializeAgentDefinition', () => {
  it('uses the canonical key order and omits unset fields', () => {
    const text = serializeAgentDefinition(
      makeInput({
        name: 'a',
        description: 'b',
        tools: 'read, bash',
        model: 'm/x',
        tier: 'cheap',
        thinkingLevel: 'low',
      }),
      ['read', 'bash'],
      [],
    );
    const keys = text.split('\n').filter((l) => /^[a-zA-Z]+: /.test(l));
    expect(keys).toEqual([
      'name: "a"',
      'description: "b"',
      'tools: "read, bash"',
      'model: "m/x"',
      'tier: "cheap"',
      'thinkingLevel: "low"',
    ]);
  });

  it('double-quotes every scalar so YAML cannot re-type values', () => {
    const text = serializeAgentDefinition(makeInput({ description: 'true' }), undefined, []);
    expect(text).toContain('description: "true"');
  });

  it('emits unknown blocks after known keys, original order', () => {
    const text = serializeAgentDefinition(makeInput(), undefined, [
      'author: "someone"',
      'tags:\n  - x',
    ]);
    const lines = text.split('\n');
    expect(lines.indexOf('author: "someone"')).toBeGreaterThan(lines.indexOf('---'));
    expect(lines.indexOf('tags:')).toBeGreaterThan(lines.indexOf('author: "someone"'));
    expect(text).toContain('  - x');
  });
});

describe('extractUnknownFrontmatterBlocks', () => {
  it('returns [] when there is no frontmatter', () => {
    expect(extractUnknownFrontmatterBlocks('just body text')).toEqual([]);
  });

  it('keeps unknown top-level blocks with continuations, drops known keys', () => {
    const blocks = extractUnknownFrontmatterBlocks(
      [
        '---',
        'name: x',
        'tags:',
        '  - a',
        '  - b',
        'description: y',
        'author: me  # note',
        '---',
        'body',
      ].join('\n'),
    );
    expect(blocks).toEqual(['tags:', '  - a', '  - b', 'author: me  # note']);
  });
});

describe('writeAndVerify — restore-not-delete semantics', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisubagent-verify-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const input = makeInput();

  it('update path: restores previous content when round-trip fails', async () => {
    const filePath = path.join(tmpDir, 'agent.md');
    fs.writeFileSync(filePath, 'PREVIOUS DEFINITION');
    // The written text parses to a different name → round-trip mismatch.
    const failure = await writeAndVerify(
      filePath,
      '---\nname: "someone-else"\ndescription: "d"\n---\nbody',
      'PREVIOUS DEFINITION',
      input,
    );
    expect(failure).toContain('restored');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('PREVIOUS DEFINITION');
  });

  it('create path: removes the broken file when round-trip fails', async () => {
    const filePath = path.join(tmpDir, 'agent.md');
    const failure = await writeAndVerify(
      filePath,
      '---\nname: "someone-else"\ndescription: "d"\n---\nbody',
      null,
      input,
    );
    expect(failure).toContain('removed');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('returns null and writes the file on success', async () => {
    const filePath = path.join(tmpDir, 'agent.md');
    const ok = await writeAndVerify(
      filePath,
      '---\nname: "test-agent"\ndescription: "A test agent"\n---\nbody',
      null,
      input,
    );
    expect(ok).toBeNull();
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
