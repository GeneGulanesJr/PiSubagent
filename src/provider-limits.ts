import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

/**
 * Provider-scoped concurrency limits for subagent dispatch.
 *
 * Provider plans cap how many model requests may run concurrently per account
 * (e.g. z.ai allows 2, MiniMax 3). Every subagent is its own model session, so
 * a parallel dispatch can exceed those caps before any single run misbehaves.
 * These limits bound how many subagent runs may be in flight per provider at
 * once; `MAX_CONCURRENCY` (src/dispatch/limits.ts) remains the overall window.
 *
 * Mirrors src/tier.ts: built-in defaults, overridable via a config file in the
 * agent dir, invalid entries fall back to defaults, never a failed dispatch.
 *
 * Provider = the prefix of the run's resolved model id ("zai/glm-5.3-flash" →
 * "zai"), after the full resolution ladder (dispatch model override → tier →
 * agent frontmatter model/tier → parent inheritance). Runs whose model has no
 * provider prefix, or whose provider has no configured limit, are uncapped
 * (still bounded by MAX_CONCURRENCY).
 */

/** Built-in per-provider cap on concurrent subagent runs. */
export const DEFAULT_PROVIDER_CONCURRENCY: Record<string, number> = {
  zai: 2,
  minimax: 3,
};

const PROVIDER_LIMITS_FILE = 'pisubagent.limits.json';

/**
 * Pure limits-config file reader (exported for tests). Returns the built-in
 * defaults for entries that are missing or invalid — a broken config file
 * degrades to defaults, never to a failed dispatch. A cap must be a positive
 * integer: 0 would deadlock the scheduler (the task could never start), and
 * fractional caps are meaningless.
 */
export function readProviderLimitsFile(filePath: string): Record<string, number> {
  const merged: Record<string, number> = { ...DEFAULT_PROVIDER_CONCURRENCY };
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return merged;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return merged;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return merged;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const provider = key.trim().toLowerCase();
    if (!provider) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) continue;
    merged[provider] = value;
  }
  return merged;
}

let cachedProviderLimits: Record<string, number> | null = null;

/** Effective provider → concurrency cap mapping (config file merged over built-ins). Cached. */
export function loadProviderLimits(): Record<string, number> {
  if (cachedProviderLimits) return cachedProviderLimits;
  try {
    cachedProviderLimits = readProviderLimitsFile(path.join(getAgentDir(), PROVIDER_LIMITS_FILE));
  } catch {
    cachedProviderLimits = { ...DEFAULT_PROVIDER_CONCURRENCY };
  }
  return cachedProviderLimits;
}

/** Test seam: drop the cached provider-limits mapping. */
export function resetProviderLimitsCache(): void {
  cachedProviderLimits = null;
}

/**
 * Extract the provider from a model id: "zai/glm-5.3-flash" → "zai".
 * Returns undefined for absent models or bare ids without a provider prefix —
 * such runs cannot be attributed to a provider plan, so they are uncapped.
 */
export function providerOfModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return undefined;
  const provider = trimmed.slice(0, slash).trim().toLowerCase();
  return provider || undefined;
}
