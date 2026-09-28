import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

/**
 * Cost-tier routing for subagent dispatch.
 *
 * Lets the dispatching LLM (or agent frontmatter) route a run to a cheaper
 * provider model when the task is not crucial — preserving the primary
 * provider's quota (e.g. z.ai's 5-hour window) for work that needs it.
 *
 * Mirrors src/thinking.ts: a lenient resolution ladder, most-specific wins.
 *
 *   1. Per-dispatch `model` override — explicit pin for one-off dispatches.
 *   2. Per-dispatch `tier` — "this task isn't crucial".
 *   3. Agent frontmatter `model:` — existing pin behavior, unchanged.
 *   4. Agent frontmatter `tier:` — static per-role default.
 *   5. undefined — inherit the parent's model (existing default).
 *
 * Tiers:
 *   - "cheap"    → routine work (recon, lookup, bulk triage). MiniMax M2.5.
 *   - "thinking" → deep reasoning that can still be offloaded. MiniMax M3
 *                  (MiniMax's reasoning-capable flagship). Reserved for
 *                  thinking-mode work per owner decision — never the default.
 *
 * Tier → model mapping is overridable via ~/.pi/agent/pisubagent.tiers.json:
 *   { "cheap": "minimax/minimax-m2.5", "thinking": "minimax/minimax-m3" }
 * Invalid or missing entries fall back to the built-in defaults.
 */

export const TIERS = ['cheap', 'thinking'] as const;
export type Tier = (typeof TIERS)[number];

/** Built-in tier → model mapping (provider/model id passed to child pi as --model). */
export const DEFAULT_TIER_MODELS: Record<Tier, string> = {
  cheap: 'minimax/minimax-m2.5',
  thinking: 'minimax/minimax-m3',
};

/**
 * Default thinking level for tier-routed runs. Cheap work gets the same
 * budget as ordinary model-pinned agents; the thinking tier exists precisely
 * to offload deep-reasoning work, so it defaults higher.
 */
export const TIER_DEFAULT_THINKING: Record<Tier, ThinkingLevel> = {
  cheap: 'medium',
  thinking: 'high',
};

/** Lenient tier parser: invalid or absent values yield undefined. */
export function parseTier(value: unknown): Tier | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return (TIERS as readonly string[]).includes(normalized) ? (normalized as Tier) : undefined;
}

const TIER_CONFIG_FILE = 'pisubagent.tiers.json';

/**
 * Pure tier-config file reader (exported for tests). Returns the built-in
 * defaults for entries that are missing or invalid — a broken config file
 * degrades to defaults, never to a failed dispatch.
 */
export function readTierModelsFile(filePath: string): Record<Tier, string> {
  const merged: Record<Tier, string> = { ...DEFAULT_TIER_MODELS };
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
  const obj = parsed as Record<string, unknown>;
  for (const tier of TIERS) {
    const v = obj[tier];
    if (typeof v === 'string' && v.trim().length > 0 && v.includes('/')) {
      merged[tier] = v.trim();
    }
  }
  return merged;
}

let cachedTierModels: Record<Tier, string> | null = null;

/** Effective tier → model mapping (config file merged over built-ins). Cached. */
export function loadTierModels(): Record<Tier, string> {
  if (cachedTierModels) return cachedTierModels;
  try {
    cachedTierModels = readTierModelsFile(path.join(getAgentDir(), TIER_CONFIG_FILE));
  } catch {
    cachedTierModels = { ...DEFAULT_TIER_MODELS };
  }
  return cachedTierModels;
}

/** Test seam: drop the cached tier-model mapping. */
export function resetTierModelsCache(): void {
  cachedTierModels = null;
}

export interface ModelResolutionInput {
  /** Per-dispatch `model` param — explicit pin, beats everything. */
  modelOverride?: string;
  /** Per-dispatch `tier` param — beats agent frontmatter. */
  tierOverride?: Tier;
}

export interface ResolvedRunModel {
  /** Concrete model id for the run, or undefined to inherit the parent's. */
  model?: string;
  /** The tier that drove the decision, when one did. */
  tier?: Tier;
}

/**
 * Resolve the effective model for one subagent run.
 * See module doc for the precedence ladder.
 */
export function resolveRunModel(
  agent: { model?: string; tier?: Tier },
  input: ModelResolutionInput = {},
): ResolvedRunModel {
  if (input.modelOverride && input.modelOverride.trim()) {
    return { model: input.modelOverride.trim(), tier: undefined };
  }
  if (input.tierOverride) {
    return { model: loadTierModels()[input.tierOverride], tier: input.tierOverride };
  }
  if (agent.model && agent.model.trim()) {
    return { model: agent.model.trim(), tier: undefined };
  }
  if (agent.tier) {
    return { model: loadTierModels()[agent.tier], tier: agent.tier };
  }
  return { model: undefined, tier: undefined };
}
