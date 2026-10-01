import { describe, it, expect } from 'vitest';
import {
  normalizeText,
  diffLines,
  countChangedLines,
  diffRatio,
  merge3,
} from '../src/text-diff.js';

/* --- normalizeText --- */

describe('normalizeText', () => {
  it('normalizes CRLF and lone CR to LF', () => {
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('strips trailing whitespace per line', () => {
    expect(normalizeText('a  \nb\t')).toBe('a\nb');
  });

  it('drops trailing blank lines but keeps interior ones', () => {
    expect(normalizeText('a\n\nb\n\n\n')).toBe('a\n\nb');
  });

  it('collapses whitespace-only text to empty', () => {
    expect(normalizeText('\n \n\r\n')).toBe('');
  });
});

/* --- diffLines / countChangedLines --- */

describe('diffLines', () => {
  it('returns no changes for identical text', () => {
    expect(diffLines('a\nb\nc', 'a\nb\nc')).toEqual([]);
  });

  it('treats normalization-equivalent text as identical', () => {
    expect(diffLines('a\r\nb\n', 'a\nb')).toEqual([]);
  });

  it('detects a pure insertion', () => {
    const changes = diffLines('a\nc', 'a\nb\nc');
    expect(changes).toEqual([{ baseStart: 1, baseCount: 0, lines: ['b'] }]);
  });

  it('detects a pure deletion', () => {
    const changes = diffLines('a\nb\nc', 'a\nc');
    expect(changes).toEqual([{ baseStart: 1, baseCount: 1, lines: [] }]);
  });

  it('detects a modified line as delete+insert', () => {
    const changes = diffLines('a\nb\nc', 'a\nB\nc');
    expect(changes).toHaveLength(1);
    expect(changes[0].baseStart).toBe(1);
    expect(changes[0].baseCount).toBe(1);
    expect(changes[0].lines).toEqual(['B']);
  });

  it('handles empty-to-content and content-to-empty', () => {
    expect(diffLines('', 'a\nb')).toEqual([{ baseStart: 0, baseCount: 0, lines: ['a', 'b'] }]);
    expect(diffLines('a\nb', '')).toEqual([{ baseStart: 0, baseCount: 2, lines: [] }]);
  });

  it('counts removed + added lines', () => {
    expect(countChangedLines(diffLines('a\nb\nc', 'a\nX\nc'))).toBe(2);
    expect(countChangedLines(diffLines('a\nb\nc', 'a\nX\nY\nc'))).toBe(3);
  });
});

/* --- diffRatio --- */

describe('diffRatio', () => {
  it('is 0 when both sides are empty', () => {
    expect(diffRatio('', '')).toBe(0);
    expect(diffRatio('\n\n', '   ')).toBe(0);
  });

  it('is 1.0 when exactly one side is empty (incl. 0-line base)', () => {
    expect(diffRatio('', 'a')).toBe(1);
    expect(diffRatio('a\nb', '')).toBe(1);
    expect(diffRatio('', 'a\nb\nc')).toBe(1);
  });

  it('scales with changed fraction', () => {
    // 1 of 4 lines changed = delete+insert = 2 / 4 = 0.5
    expect(diffRatio('a\nb\nc\nd', 'a\nb\nX\nd')).toBe(0.5);
    expect(diffRatio('a\nb\nc\nd', 'a\nb\nc\nd')).toBe(0);
  });
});

/* --- merge3 --- */

describe('merge3', () => {
  it('merges clean non-overlapping edits from both sides', () => {
    const base = 'one\ntwo\nthree\nfour\nfive';
    const ours = 'one\ntwo (ours)\nthree\nfour\nfive';
    const theirs = 'one\ntwo\nthree\nfour\nfive (theirs)';
    const { merged, conflicts } = merge3(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged).toBe('one\ntwo (ours)\nthree\nfour\nfive (theirs)');
  });

  it('takes an identical change once (including pure insertions)', () => {
    const base = 'a\nb';
    const ours = 'a\nX\nb';
    const theirs = 'a\nX\nb';
    const { merged, conflicts } = merge3(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged).toBe('a\nX\nb');
  });

  it('applies one-sided changes when the other side is untouched', () => {
    const base = 'a\nb\nc';
    const { merged, conflicts } = merge3(base, base, 'a\nB\nc');
    expect(conflicts).toEqual([]);
    expect(merged).toBe('a\nB\nc');
    const back = merge3(base, 'a\nB\nc', base);
    expect(back.conflicts).toEqual([]);
    expect(back.merged).toBe('a\nB\nc');
  });

  it('reports a conflict when the same line changes differently', () => {
    const base = 'a\nb\nc';
    const ours = 'a\nours\nc';
    const theirs = 'a\ntheirs\nc';
    const { merged, conflicts } = merge3(base, ours, theirs);
    expect(conflicts).toEqual([1]);
    expect(merged).toContain('<<<<<<< ours');
    expect(merged).toContain('ours');
    expect(merged).toContain('=======');
    expect(merged).toContain('theirs');
    expect(merged).toContain('>>>>>>> theirs');
  });

  it('merges multiple hunks from both sides cleanly when regions do not overlap', () => {
    const base = '1\n2\n3\n4\n5\n6\n7\n8\n9';
    const ours = '1\nours\n3\n4\n5\n6\n7\n8\n9'; // changed line 2
    const theirs = '1\n2\n3\ntheirs\n5\ntheirs2\n7\n8\n9'; // changed 4 and 6
    const { merged, conflicts } = merge3(base, ours, theirs);
    // ours(2..3) overlaps theirs(4..5)? no — separate regions → all merge cleanly
    expect(conflicts).toEqual([]);
    expect(merged).toBe('1\nours\n3\ntheirs\n5\ntheirs2\n7\n8\n9');
  });

  it('does not conflict on an insertion at a replaced region boundary', () => {
    const base = 'a\nb\nc';
    const ours = 'a\nb\ninserted\nc'; // insertion at base position 2
    const theirs = 'a\nX\nc'; // replaced base[1..2)
    const { merged, conflicts } = merge3(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged).toBe('a\nX\ninserted\nc');
  });

  it('handles unrelated leading/trailing edits', () => {
    const base = 'head\nmid\ntail';
    const ours = 'HEAD\nmid\ntail';
    const theirs = 'head\nmid\nTAIL';
    const { merged, conflicts } = merge3(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged).toBe('HEAD\nmid\nTAIL');
  });
});
