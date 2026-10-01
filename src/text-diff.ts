/**
 * Line-level text diffing and 3-way merge for agent definition files.
 *
 * Pure functions, no dependencies — the upstream `diff`/`yaml` packages are
 * transitive deps of @earendil-works/pi-coding-agent and importing them
 * directly would be a phantom dependency.
 *
 * All functions accept raw text and normalize it first (see normalizeText),
 * so CRLF working-tree copies and trailing-whitespace churn never register
 * as changes.
 */

export interface LineChange {
  /** Index into the base line array where the replaced region starts. */
  baseStart: number;
  /** Number of base lines replaced by `lines` (0 for a pure insertion). */
  baseCount: number;
  /** Replacement lines in order (empty for a pure deletion). */
  lines: string[];
}

/** CRLF/CR → LF, strip trailing whitespace per line, drop trailing blank lines. */
export function normalizeText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    lines[i] = lines[i].replace(/[ \t]+$/, '');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function toLines(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized === '' ? [] : normalized.split('\n');
}

function diffLineArrays(base: string[], other: string[]): LineChange[] {
  // LCS dynamic-programming table. Agent definition files are small
  // (typically well under 200 lines), so O(n·m) is fine.
  const n = base.length;
  const m = other.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        base[i] === other[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === other[j]) {
      i++;
      j++;
      continue;
    }
    const baseStart = i;
    const lines: string[] = [];
    while (i < n || j < m) {
      if (i < n && j < m && base[i] === other[j]) break;
      if (j >= m) {
        i++; // delete base[i]
      } else if (i >= n) {
        lines.push(other[j]);
        j++; // insert other[j]
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        i++; // delete base[i]
      } else {
        lines.push(other[j]);
        j++; // insert other[j]
      }
    }
    changes.push({ baseStart, baseCount: i - baseStart, lines });
  }
  return changes;
}

/** Diff two raw texts after normalization. */
export function diffLines(base: string, other: string): LineChange[] {
  return diffLineArrays(toLines(base), toLines(other));
}

/** Removed + added line count across all changes. */
export function countChangedLines(changes: LineChange[]): number {
  let count = 0;
  for (const c of changes) count += c.baseCount + c.lines.length;
  return count;
}

/**
 * Fraction of lines changed between two raw texts, after normalization.
 * Pinned edges: 0 when both sides are empty, 1.0 when exactly one side is
 * empty (including the 0-line-base case).
 */
export function diffRatio(base: string, other: string): number {
  const a = toLines(base);
  const b = toLines(other);
  if (a.length === 0 && b.length === 0) return 0;
  const changed = countChangedLines(diffLineArrays(a, b));
  return changed / Math.max(a.length, b.length);
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 3-way line merge. `base` is the common ancestor; changes present on only
 * one side (or identical on both) are taken; different changes to the same
 * base region become a conflict (both sides preserved behind markers —
 * callers treat conflicts as "advisory only", so marker output is a shell
 * for manual resolution, never auto-written).
 */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
): { merged: string; conflicts: number[] } {
  const baseLines = toLines(base);
  const ourChanges = diffLineArrays(baseLines, toLines(ours));
  const theirChanges = diffLineArrays(baseLines, toLines(theirs));

  const out: string[] = [];
  const conflicts: number[] = [];
  let pos = 0;
  let i = 0;
  let t = 0;

  const emitUnchanged = (end: number) => {
    for (; pos < end; pos++) out.push(baseLines[pos]);
  };

  while (i < ourChanges.length || t < theirChanges.length) {
    const o = ourChanges[i];
    const th = theirChanges[t];
    const oEnd = o ? o.baseStart + o.baseCount : Number.POSITIVE_INFINITY;
    const tEnd = th ? th.baseStart + th.baseCount : Number.POSITIVE_INFINITY;

    if (
      o &&
      th &&
      o.baseStart === th.baseStart &&
      o.baseCount === th.baseCount &&
      sameLines(o.lines, th.lines)
    ) {
      // Both sides made the identical change — take it once. Checked before
      // the non-overlap branches: two identical pure insertions at the same
      // position have zero-length regions and would otherwise be applied twice.
      emitUnchanged(o.baseStart);
      out.push(...o.lines);
      pos = oEnd;
      i++;
      t++;
    } else if (o && (!th || oEnd <= th.baseStart)) {
      emitUnchanged(o.baseStart);
      out.push(...o.lines);
      pos = oEnd;
      i++;
    } else if (th && (!o || tEnd <= o.baseStart)) {
      emitUnchanged(th.baseStart);
      out.push(...th.lines);
      pos = tEnd;
      t++;
    } else {
      // Overlapping different changes: absorb every change (either side)
      // that intersects the growing union region into one conflict block.
      const uStart = Math.min(o!.baseStart, th!.baseStart);
      let uEnd = Math.max(oEnd, tEnd);
      let i2 = i! + 1;
      let t2 = t! + 1;
      let grew = true;
      while (grew) {
        grew = false;
        while (i2 < ourChanges.length && ourChanges[i2].baseStart < uEnd) {
          uEnd = Math.max(uEnd, ourChanges[i2].baseStart + ourChanges[i2].baseCount);
          i2++;
          grew = true;
        }
        while (t2 < theirChanges.length && theirChanges[t2].baseStart < uEnd) {
          uEnd = Math.max(uEnd, theirChanges[t2].baseStart + theirChanges[t2].baseCount);
          t2++;
          grew = true;
        }
      }
      conflicts.push(uStart);
      emitUnchanged(uStart);
      out.push('<<<<<<< ours');
      out.push(...regionText(baseLines, ourChanges, i, i2, uStart, uEnd));
      out.push('=======');
      out.push(...regionText(baseLines, theirChanges, t, t2, uStart, uEnd));
      out.push('>>>>>>> theirs');
      pos = uEnd;
      i = i2;
      t = t2;
    }
  }
  emitUnchanged(baseLines.length);
  return { merged: out.join('\n'), conflicts };
}

/** Reconstruct one side of a conflict region: apply that side's changes to the base slice. */
function regionText(
  baseLines: string[],
  changes: LineChange[],
  from: number,
  to: number,
  uStart: number,
  uEnd: number,
): string[] {
  const out: string[] = [];
  let p = uStart;
  for (let k = from; k < to; k++) {
    const c = changes[k];
    for (; p < c.baseStart; p++) out.push(baseLines[p]);
    out.push(...c.lines);
    p = c.baseStart + c.baseCount;
  }
  for (; p < uEnd; p++) out.push(baseLines[p]);
  return out;
}
