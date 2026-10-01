import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { parseToolList } from './agents.js';
import { parseTier } from './tier.js';
import { parseThinkingLevel } from './thinking.js';
import {
  MINOR_DIFF_RATIO,
  readBaseSnapshot,
  sha256Normalized,
  writeBaseSnapshotFile,
} from './agent-store.js';
import { diffRatio, merge3, normalizeText } from './text-diff.js';

/**
 * Bundled-shadow sync: keep user-scope copies of bundled agents current when
 * a package update changes the bundled .md.
 *
 * Only shadows WITH provenance participate — a base snapshot (written by
 * agent-store on shadow creation) records the bundled file's normalized
 * content at capture time. Hand-written shadows have no snapshot and are
 * never auto-touched (advisory-only via the doctor).
 *
 * Per shadow, with `base` = snapshot, `ours` = the user's file, `theirs` =
 * the current bundled file (all diffed on normalizeText output):
 *
 *   - bundled unchanged since base          → skip (silent; common case)
 *   - bundled file gone                     → advisory, shadow retained
 *   - ours identical to base                → fast-forward to theirs
 *   - ours minor (≤ MINOR_DIFF_RATIO, frontmatter
 *     settings unchanged) and merge3 clean  → rebase (merged file written,
 *                                             base refreshed)
 *   - anything else                         → advisory only, never touched
 *
 * All writes go through withFileMutationQueue, which serializes within one
 * process. Across two concurrent pi processes the queue does NOT serialize —
 * but fast-forward/rebase outputs are deterministic functions of the same
 * inputs, so racing writers produce identical bytes, and diverged states
 * degrade to advisories, never corruption.
 */

export type SyncAction = 'fast-forward' | 'rebased' | 'advisory' | 'skipped';

export interface SyncReport {
  agent: string;
  action: SyncAction;
  detail: string;
}

export interface SyncShadowOptions {
  bundledDir: string;
  userDir: string;
  basesDir: string;
}

/** Only reports syncs that DID something or need attention — up-to-date shadows stay silent. */
export async function syncBundledShadows(opts: SyncShadowOptions): Promise<SyncReport[]> {
  let baseFiles: string[];
  try {
    baseFiles = fs.readdirSync(opts.basesDir).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // no bases dir → nothing has provenance → nothing to do
  }
  if (baseFiles.length === 0) return [];

  const reports: SyncReport[] = [];
  for (const file of baseFiles) {
    const name = file.slice(0, -'.json'.length);
    try {
      const report = await syncOne(name, opts);
      if (report) reports.push(report);
    } catch (err) {
      reports.push({
        agent: name,
        action: 'skipped',
        detail: `sync failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return reports;
}

type ShadowFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
  tier?: unknown;
  thinkingLevel?: unknown;
};

/** Semantic compare of the settings frontmatter (everything but name/description/body). */
function nonPromptFrontmatterEqual(a: ShadowFrontmatter, b: ShadowFrontmatter): boolean {
  const toolKey = (t: unknown) => (parseToolList(t) ?? []).slice().sort().join(',');
  const modelKey = (m: unknown) => (typeof m === 'string' ? m.trim() : '');
  const tierKey = (t: unknown) => parseTier(t) ?? '';
  const levelKey = (l: unknown) => parseThinkingLevel(l) ?? '';
  return (
    toolKey(a.tools) === toolKey(b.tools) &&
    modelKey(a.model) === modelKey(b.model) &&
    tierKey(a.tier) === tierKey(b.tier) &&
    levelKey(a.thinkingLevel) === levelKey(b.thinkingLevel)
  );
}

function parseShadow(content: string): ShadowFrontmatter | null {
  try {
    return parseFrontmatter<ShadowFrontmatter>(content).frontmatter;
  } catch {
    return null;
  }
}

async function syncOne(name: string, opts: SyncShadowOptions): Promise<SyncReport | null> {
  const { bundledDir, userDir, basesDir } = opts;
  const shadowPath = path.join(userDir, `${name}.md`);
  if (!fs.existsSync(shadowPath)) return null; // orphan base: skip silently (doctor lists orphans)

  const base = readBaseSnapshot(basesDir, name);
  if (base === null) {
    return {
      agent: name,
      action: 'skipped',
      detail:
        'base snapshot is missing or corrupt — delete it or re-save the agent to restore provenance',
    };
  }

  const bundledPath = path.join(bundledDir, `${name}.md`);
  if (!fs.existsSync(bundledPath)) {
    return {
      agent: name,
      action: 'advisory',
      detail: 'the bundled agent no longer exists — your shadow is retained as a standalone agent',
    };
  }

  const bundledRaw = fs.readFileSync(bundledPath, 'utf-8');
  const bundledNormalized = normalizeText(bundledRaw);
  const bundledHash = sha256Normalized(bundledRaw);
  if (bundledHash === base.sha256) return null; // up to date

  const shadowRaw = fs.readFileSync(shadowPath, 'utf-8');
  const shadowFm = parseShadow(shadowRaw);
  if (shadowFm === null) {
    return {
      agent: name,
      action: 'skipped',
      detail: 'your shadow file has invalid YAML — fix it by hand; sync skipped',
    };
  }
  const baseFm = parseShadow(base.content);
  if (baseFm === null) {
    return {
      agent: name,
      action: 'skipped',
      detail: 'base snapshot content is unparseable — re-save the agent to rebuild provenance',
    };
  }

  const oursRatio = diffRatio(base.content, shadowRaw);
  if (oursRatio === 0) {
    // Untouched copy of the bundled agent at capture time → pure fast-forward.
    await writeShadow(shadowPath, bundledRaw);
    await writeBaseSnapshotFile(basesDir, name, {
      content: bundledNormalized,
      sha256: bundledHash,
      capturedAt: new Date().toISOString(),
    });
    return {
      agent: name,
      action: 'fast-forward',
      detail: 'your copy was unmodified — updated to the new bundled version',
    };
  }

  if (!nonPromptFrontmatterEqual(baseFm, shadowFm)) {
    return {
      agent: name,
      action: 'advisory',
      detail: `your shadow changed agent settings (tools/model/tier/thinkingLevel) — the bundled update was NOT auto-applied; review ${shadowPath}`,
    };
  }

  if (oursRatio > MINOR_DIFF_RATIO) {
    return {
      agent: name,
      action: 'advisory',
      detail: `your shadow has major edits (${Math.round(oursRatio * 100)}% of lines differ from the recorded base) — the bundled update was NOT auto-applied; review ${shadowPath}`,
    };
  }

  const { merged, conflicts } = merge3(base.content, shadowRaw, bundledRaw);
  if (conflicts.length > 0) {
    return {
      agent: name,
      action: 'advisory',
      detail: `the bundled update conflicts with your ${conflicts.length} edited line(s) — NOT auto-applied; reconcile ${shadowPath} by hand`,
    };
  }

  await writeShadow(shadowPath, merged);
  await writeBaseSnapshotFile(basesDir, name, {
    content: bundledNormalized,
    sha256: bundledHash,
    capturedAt: new Date().toISOString(),
  });
  return {
    agent: name,
    action: 'rebased',
    detail: `your edits were preserved and merged with the updated bundled agent`,
  };
}

async function writeShadow(shadowPath: string, content: string): Promise<void> {
  await withFileMutationQueue(shadowPath, async () => {
    await fs.promises.writeFile(shadowPath, content, 'utf-8');
  });
}
