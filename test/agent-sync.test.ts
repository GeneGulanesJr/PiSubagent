import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { syncBundledShadows } from '../src/agent-sync.js';
import { readBaseSnapshot, sha256Normalized } from '../src/agent-store.js';
import { normalizeText } from '../src/text-diff.js';

const BUNDLED_V1 = [
  '---',
  'name: "scout"',
  'description: "Bundled scout"',
  'tier: "cheap"',
  '---',
  'prompt v1 line 1',
  'prompt v1 line 2',
  'prompt v1 line 3',
].join('\n');
const BUNDLED_V2 = [
  '---',
  'name: "scout"',
  'description: "Bundled scout"',
  'tier: "cheap"',
  '---',
  'prompt v1 line 1',
  'prompt v1 line 2',
  'prompt v2 NEW section',
].join('\n');

describe('syncBundledShadows', () => {
  let tmpDir: string;
  let bundledDir: string;
  let userDir: string;
  let basesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisubagent-sync-'));
    bundledDir = path.join(tmpDir, 'bundled');
    userDir = path.join(tmpDir, 'agents');
    basesDir = path.join(tmpDir, 'bases');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (dir: string, name: string, text: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.md`), text);
  };
  const writeBaseFor = (name: string, bundledText: string) => {
    fs.mkdirSync(basesDir, { recursive: true });
    fs.writeFileSync(
      path.join(basesDir, `${name}.json`),
      JSON.stringify({
        content: normalizeText(bundledText),
        sha256: sha256Normalized(bundledText),
        capturedAt: new Date().toISOString(),
      }),
    );
  };
  const sync = () => syncBundledShadows({ bundledDir, userDir, basesDir });

  it('returns [] when the bases dir is missing or empty (common-case early exit)', async () => {
    await expect(sync()).resolves.toEqual([]);
    fs.mkdirSync(basesDir, { recursive: true });
    await expect(sync()).resolves.toEqual([]);
  });

  it('stays silent when bundled content is unchanged since the base', async () => {
    write(bundledDir, 'scout', BUNDLED_V1);
    writeBaseFor('scout', BUNDLED_V1);
    write(userDir, 'scout', BUNDLED_V1);
    await expect(sync()).resolves.toEqual([]);
  });

  it('skips orphan bases silently (shadow deleted by hand)', async () => {
    writeBaseFor('scout', BUNDLED_V1);
    write(bundledDir, 'scout', BUNDLED_V2);
    await expect(sync()).resolves.toEqual([]);
  });

  it('reports a corrupt base snapshot as skipped without throwing', async () => {
    fs.mkdirSync(basesDir, { recursive: true });
    fs.writeFileSync(path.join(basesDir, 'scout.json'), '{ not json');
    write(userDir, 'scout', BUNDLED_V1);
    const reports = await sync();
    expect(reports).toHaveLength(1);
    expect(reports[0].action).toBe('skipped');
  });

  it('fast-forwards an untouched copy and refreshes the base', async () => {
    write(bundledDir, 'scout', BUNDLED_V2); // package shipped a new version
    writeBaseFor('scout', BUNDLED_V1);
    write(userDir, 'scout', BUNDLED_V1); // user copy identical to old bundled

    const reports = await sync();
    expect(reports).toEqual([expect.objectContaining({ agent: 'scout', action: 'fast-forward' })]);
    expect(fs.readFileSync(path.join(userDir, 'scout.md'), 'utf-8')).toBe(BUNDLED_V2);
    const base = readBaseSnapshot(basesDir, 'scout');
    expect(base!.sha256).toBe(sha256Normalized(BUNDLED_V2));
  });

  it('rebases minor user edits onto the bundled update, preserving both', async () => {
    const longBase =
      BUNDLED_V1 + '\n' + Array.from({ length: 20 }, (_, i) => `filler ${i}`).join('\n');
    const longBundledV2 = longBase.replace('prompt v1 line 2', 'prompt v2 line 2');
    const longUserCopy = longBase.replace('prompt v1 line 3', 'prompt v1 line 3 (user tweak)');

    writeBaseFor('scout', longBase);
    write(userDir, 'scout', longUserCopy);
    write(bundledDir, 'scout', longBundledV2);

    const reports = await sync();
    expect(reports).toEqual([expect.objectContaining({ agent: 'scout', action: 'rebased' })]);

    const merged = fs.readFileSync(path.join(userDir, 'scout.md'), 'utf-8');
    expect(merged).toContain('prompt v2 line 2'); // theirs applied
    expect(merged).toContain('prompt v1 line 3 (user tweak)'); // ours preserved
    expect(readBaseSnapshot(basesDir, 'scout')!.sha256).toBe(sha256Normalized(longBundledV2));
  });

  it('rebases a CRLF-edited shadow (normalization-aware diffing)', async () => {
    const longBase =
      BUNDLED_V1 + '\n' + Array.from({ length: 20 }, (_, i) => `filler ${i}`).join('\n');
    const longBundledV2 = longBase.replace('prompt v1 line 2', 'prompt v2 line 2');
    const crlfUserCopy = longBase
      .replace('prompt v1 line 3', 'prompt v1 line 3 (user tweak)')
      .replace(/\n/g, '\r\n');

    write(bundledDir, 'scout', longBundledV2);
    writeBaseFor('scout', longBase);
    write(userDir, 'scout', crlfUserCopy);

    const reports = await sync();
    expect(reports[0].action).toBe('rebased');
    expect(fs.readFileSync(path.join(userDir, 'scout.md'), 'utf-8')).toContain('(user tweak)');
  });

  it('advises (never touches) when both sides changed the same lines', async () => {
    const longBase =
      BUNDLED_V1 + '\n' + Array.from({ length: 20 }, (_, i) => `filler ${i}`).join('\n');
    const longBundledV2 = longBase.replace('prompt v1 line 2', 'prompt v2 line 2');
    const conflictingUser = longBase.replace('prompt v1 line 2', 'user rewrote this line');

    write(bundledDir, 'scout', longBundledV2);
    writeBaseFor('scout', longBase);
    write(userDir, 'scout', conflictingUser);

    const reports = await sync();
    expect(reports[0].action).toBe('advisory');
    expect(fs.readFileSync(path.join(userDir, 'scout.md'), 'utf-8')).toBe(conflictingUser);
  });

  it('advises (never touches) when the user shadow has major edits — intentional overrides survive', async () => {
    const majorOverride = BUNDLED_V1.replace(
      /prompt v1 line \d/g,
      (m, i) => `completely custom prompt line ${i}`,
    );
    write(bundledDir, 'scout', BUNDLED_V2);
    writeBaseFor('scout', BUNDLED_V1);
    write(userDir, 'scout', majorOverride);

    const reports = await sync();
    expect(reports[0].action).toBe('advisory');
    expect(fs.readFileSync(path.join(userDir, 'scout.md'), 'utf-8')).toBe(majorOverride);
  });

  it('advises when the user changed agent settings frontmatter (tools/model/tier)', async () => {
    const longBase =
      BUNDLED_V1 + '\n' + Array.from({ length: 20 }, (_, i) => `filler ${i}`).join('\n');
    const longBundledV2 = longBase.replace('prompt v1 line 2', 'prompt v2 line 2');
    const userChangedTier = longBase.replace('tier: "cheap"', 'tier: "thinking"');

    write(bundledDir, 'scout', longBundledV2);
    writeBaseFor('scout', longBase);
    write(userDir, 'scout', userChangedTier);

    const reports = await sync();
    expect(reports[0].action).toBe('advisory');
    expect(reports[0].detail).toContain('settings');
  });

  it('advises when the bundled agent no longer exists; shadow retained', async () => {
    writeBaseFor('scout', BUNDLED_V1);
    write(userDir, 'scout', BUNDLED_V1);
    // no bundled dir at all

    const reports = await sync();
    expect(reports).toEqual([
      expect.objectContaining({
        agent: 'scout',
        action: 'advisory',
        detail: expect.stringContaining('no longer exists'),
      }),
    ]);
    expect(fs.existsSync(path.join(userDir, 'scout.md'))).toBe(true);
  });

  it('skips shadows with invalid YAML (never throws)', async () => {
    write(bundledDir, 'scout', BUNDLED_V2);
    writeBaseFor('scout', BUNDLED_V1);
    write(userDir, 'scout', '---\nname: "broken\n---\nbody');

    const reports = await sync();
    expect(reports[0].action).toBe('skipped');
    expect(reports[0].detail).toContain('invalid YAML');
  });
});
