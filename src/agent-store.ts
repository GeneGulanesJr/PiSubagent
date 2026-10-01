import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { AgentConfig } from './types.js';
import type { SaveAgentAction } from './types.js';
import type { Tier } from './tier.js';
import { loadAgentsFromDir, parseToolList } from './agents.js';
import { diffLines, diffRatio, normalizeText } from './text-diff.js';

/**
 * Programmatic save/update of agent definitions (the `subagent_save` tool).
 *
 * An agent definition stays a plain Markdown file (YAML frontmatter + body =
 * system prompt) in one of the directories discoverAgents() already reads —
 * this module never introduces a second state format. Upsert policy:
 *
 *   - create when the target file is missing (with one-time `overwrite`
 *     friction when the name shadows a bundled agent);
 *   - auto-apply MINOR updates (description tweaks, small prompt edits);
 *   - BLOCK major updates (tools/model/tier/thinkingLevel changed, or a
 *     large prompt rewrite) unless the caller passes overwrite: true.
 *
 * Every write is verified by re-parsing the written file; on verification
 * failure the previous content is restored (update path) or the file is
 * removed (create path), and the outcome reports the failure — a broken
 * write never silently replaces a working definition.
 */

/** Prompt diff ratio at or below which a change is classified as minor. */
export const MINOR_DIFF_RATIO = 0.2;

const NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type SaveScope = 'user' | 'project';

export interface SaveDefinitionInput {
  name: string;
  description: string;
  systemPrompt: string;
  /** Comma-separated tool list, as accepted by parseToolList. */
  tools?: string;
  model?: string;
  tier?: Tier;
  thinkingLevel?: ThinkingLevel;
  overwrite?: boolean;
}

export interface ChangeSummary {
  /** Logical fields that differ: description, tools, model, tier, thinkingLevel, systemPrompt. */
  fields: string[];
  promptLinesAdded: number;
  promptLinesRemoved: number;
  ratio: number;
}

export interface SaveAgentOutcome {
  ok: boolean;
  action: SaveAgentAction;
  /** LLM-facing text: what happened, or why the save was blocked + remediation. */
  message: string;
  filePath?: string;
  /** Non-fatal notes (scope collisions, dead tier, provenance failures). */
  warnings: string[];
  change?: ChangeSummary;
}

export interface SaveAgentOptions {
  targetDir: string;
  sourceLabel: 'user' | 'project';
  /** Agents from every source OTHER than targetDir (bundled + other scope), for shadow/collision detection. */
  otherSources: AgentConfig[];
  /** Base-snapshot directory (provenance for bundled-shadow sync). */
  basesDir: string;
}

export interface BaseSnapshot {
  /** The bundled file's normalizeText() output at capture time. */
  content: string;
  /** sha256 of `content` (over the normalized text, never raw bytes). */
  sha256: string;
  capturedAt: string;
}

/* --- hashing / snapshots --- */

export function sha256Normalized(text: string): string {
  return createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
}

/** Read the base snapshot for one agent; null when absent or corrupt. */
export function readBaseSnapshot(basesDir: string, name: string): BaseSnapshot | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(basesDir, `${name}.json`), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BaseSnapshot> | null;
    if (
      parsed === null ||
      typeof parsed.content !== 'string' ||
      typeof parsed.sha256 !== 'string' ||
      typeof parsed.capturedAt !== 'string'
    ) {
      return null;
    }
    return parsed as BaseSnapshot;
  } catch {
    return null;
  }
}

/** Persist a base snapshot (the bundled file's normalized content + its hash). */
export async function writeBaseSnapshotFile(
  basesDir: string,
  name: string,
  snapshot: BaseSnapshot,
): Promise<void> {
  const basePath = path.join(basesDir, `${name}.json`);
  await withFileMutationQueue(basePath, async () => {
    await fs.promises.mkdir(basesDir, { recursive: true });
    await fs.promises.writeFile(basePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  });
}

async function writeBaseSnapshot(
  basesDir: string,
  name: string,
  bundledFilePath: string,
): Promise<void> {
  const raw = fs.readFileSync(bundledFilePath, 'utf-8');
  await writeBaseSnapshotFile(basesDir, name, {
    content: normalizeText(raw),
    sha256: sha256Normalized(raw),
    capturedAt: new Date().toISOString(),
  });
}

/* --- serialization --- */

const KNOWN_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'tools',
  'model',
  'tier',
  'thinkingLevel',
]);

/** YAML double-quoted scalar: defeats scalar re-typing (`true`/`2024`), `: `, and ` #` parsing. */
function yamlDoubleQuoted(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function dedupeTools(tools: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tools) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Raw YAML lines between the `---` markers of an agent .md file (empty when
 * there is no frontmatter block). Mirrors parseFrontmatter's extraction so
 * unknown-key preservation agrees with what the loader actually reads.
 */
function extractFrontmatterLines(content: string): string[] {
  const normalized = content.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---')) return [];
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) return [];
  return normalized.slice(4, endIndex).split('\n');
}

/**
 * Preserve unknown top-level frontmatter blocks (key line plus any
 * indented / list continuation lines) so a minor auto-update never strips
 * user customizations like `tags:` or `author:`.
 */
export function extractUnknownFrontmatterBlocks(content: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of extractFrontmatterLines(content)) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(line)) {
      if (current) blocks.push(...current);
      const key = line.slice(0, line.indexOf(':')).trim();
      current = KNOWN_FRONTMATTER_KEYS.has(key) ? null : [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(...current);
  return blocks;
}

/**
 * Serialize a definition to agent .md text. Canonical key order matches the
 * bundled agents; all scalars are double-quoted; unknown blocks (if any)
 * are emitted after the known keys, original order.
 */
export function serializeAgentDefinition(
  input: SaveDefinitionInput,
  tools: string[] | undefined,
  unknownBlocks: string[],
): string {
  const lines = ['---'];
  lines.push(`name: ${yamlDoubleQuoted(input.name)}`);
  lines.push(`description: ${yamlDoubleQuoted(input.description)}`);
  if (tools && tools.length > 0) {
    lines.push(`tools: ${yamlDoubleQuoted(dedupeTools(tools).join(', '))}`);
  }
  if (input.model && input.model.trim())
    lines.push(`model: ${yamlDoubleQuoted(input.model.trim())}`);
  if (input.tier) lines.push(`tier: ${yamlDoubleQuoted(input.tier)}`);
  if (input.thinkingLevel) lines.push(`thinkingLevel: ${yamlDoubleQuoted(input.thinkingLevel)}`);
  for (const block of unknownBlocks) lines.push(block);
  lines.push('---', '');
  return `${lines.join('\n')}${input.systemPrompt}\n`;
}

/* --- classification --- */

function toolsAsSet(tools: string[] | undefined): string {
  return (tools ?? []).slice().sort().join(',');
}

function summarizeChange(existing: AgentConfig, input: SaveDefinitionInput): ChangeSummary | null {
  const fields: string[] = [];
  if (normalizeText(existing.description) !== normalizeText(input.description)) {
    fields.push('description');
  }

  const inputTools = parseToolList(input.tools ?? '');
  if (toolsAsSet(existing.tools) !== toolsAsSet(inputTools)) fields.push('tools');
  if ((existing.model ?? '').trim() !== (input.model ?? '').trim()) fields.push('model');
  if (existing.tier !== input.tier) fields.push('tier');
  if (existing.thinkingLevel !== input.thinkingLevel) fields.push('thinkingLevel');

  const basePrompt = normalizeText(existing.systemPrompt);
  const nextPrompt = normalizeText(input.systemPrompt);
  let promptLinesAdded = 0;
  let promptLinesRemoved = 0;
  let ratio = 0;
  if (basePrompt !== nextPrompt) {
    fields.push('systemPrompt');
    for (const c of diffLines(basePrompt, nextPrompt)) {
      promptLinesRemoved += c.baseCount;
      promptLinesAdded += c.lines.length;
    }
    ratio = diffRatio(basePrompt, nextPrompt);
  }

  if (fields.length === 0) return null;
  return { fields, promptLinesAdded, promptLinesRemoved, ratio };
}

function isMajorChange(change: ChangeSummary): boolean {
  const frontmatterBehaviorChanged = change.fields.some(
    (f) => f === 'tools' || f === 'model' || f === 'tier' || f === 'thinkingLevel',
  );
  const promptSubstantiallyRewritten =
    change.fields.includes('systemPrompt') && change.ratio > MINOR_DIFF_RATIO;
  return frontmatterBehaviorChanged || promptSubstantiallyRewritten;
}

function formatChange(change: ChangeSummary): string {
  const parts: string[] = [];
  const frontmatterFields = change.fields.filter((f) => f !== 'systemPrompt');
  if (frontmatterFields.length > 0) parts.push(frontmatterFields.join(', '));
  if (change.fields.includes('systemPrompt')) {
    const pct = Math.round(change.ratio * 100);
    parts.push(
      `system prompt +${change.promptLinesAdded}/-${change.promptLinesRemoved} lines (${pct}% changed)`,
    );
  }
  return parts.join('; ');
}

function blockedOutcome(message: string, change?: ChangeSummary): SaveAgentOutcome {
  return { ok: false, action: 'blocked', message, warnings: [], change };
}

function errorOutcome(message: string): SaveAgentOutcome {
  return { ok: false, action: 'error', message, warnings: [] };
}

/* --- core --- */

/**
 * Save or update an agent definition file. Never throws for user-facing
 * failures — everything lands in the returned outcome.
 */
export async function saveAgentDefinition(
  input: SaveDefinitionInput,
  opts: SaveAgentOptions,
): Promise<SaveAgentOutcome> {
  const { targetDir, sourceLabel, otherSources, basesDir } = opts;

  if (!NAME_PATTERN.test(input.name)) {
    return errorOutcome(
      `Invalid agent name '${input.name}': names must be kebab-case (lowercase letters, digits, hyphens; start and end with a letter or digit; max 64 chars) because the definition is written to <name>.md.`,
    );
  }
  if (!input.description || input.description.trim() === '') {
    return errorOutcome('description is required and must be non-empty.');
  }
  if (!input.systemPrompt || input.systemPrompt.trim() === '') {
    return errorOutcome('systemPrompt is required and must be non-empty.');
  }

  const warnings: string[] = [];
  if ((input.model ?? '').trim() && input.tier) {
    warnings.push(
      'Both model and tier are set: the model pin wins at dispatch and the tier is ignored (resolveRunModel checks model first).',
    );
  }

  const filePath = path.join(targetDir, `${input.name}.md`);
  const targetAgents = loadAgentsFromDir(targetDir, sourceLabel);

  const sameNameInTarget = targetAgents.filter((a) => a.name === input.name);
  if (sameNameInTarget.length > 1) {
    return blockedOutcome(
      `NOT saved: '${targetDir}' contains multiple definitions of agent '${input.name}' (${sameNameInTarget
        .map((a) => path.basename(a.filePath))
        .join(
          ', ',
        )}). Discovery is ambiguous in that state — merge or remove the duplicates by hand, then save again.`,
    );
  }
  const agentAtTargetPath = targetAgents.find((a) => a.filePath === filePath);
  if (agentAtTargetPath && agentAtTargetPath.name !== input.name) {
    return blockedOutcome(
      `NOT saved: '${filePath}' currently defines agent '${agentAtTargetPath.name}'. Saving '${input.name}' there would replace a different agent's definition. Choose a different name, or edit that file by hand.`,
    );
  }

  // Raw previous content: restore source for round-trip failures, and the
  // unknown-frontmatter source for minor updates.
  let previousRaw: string | null = null;
  try {
    previousRaw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    previousRaw = null;
  }

  const existing = sameNameInTarget.length === 1 ? sameNameInTarget[0] : undefined;
  const shadow = otherSources.find((a) => a.name === input.name);
  const unknownBlocks =
    existing && previousRaw !== null ? extractUnknownFrontmatterBlocks(previousRaw) : [];

  const writeOutcome = async (
    action: SaveAgentAction,
    message: string,
    change?: ChangeSummary,
  ): Promise<SaveAgentOutcome> => {
    const inputTools = parseToolList(input.tools ?? '');
    const fileText = serializeAgentDefinition(input, inputTools, unknownBlocks);
    const failure = await writeAndVerify(filePath, fileText, previousRaw, input);
    if (failure !== null) {
      return { ok: false, action: 'error', message: failure, warnings };
    }
    if (action === 'created-shadow') {
      try {
        await writeBaseSnapshot(basesDir, input.name, shadow!.filePath);
      } catch (err) {
        warnings.push(
          `Saved, but the bundled-base snapshot could not be written (${err instanceof Error ? err.message : String(err)}) — bundled-update sync will not manage this shadow.`,
        );
      }
    }
    return { ok: true, action, message, filePath, warnings, change };
  };

  // --- create path: target file missing or unparseable ---
  if (!existing) {
    const replaceNote =
      previousRaw !== null
        ? `The previous file at that path was unparseable (invalid frontmatter) and has been replaced.`
        : undefined;

    if (shadow && shadow.source === 'bundled' && !input.overwrite) {
      return blockedOutcome(
        `NOT saved: an agent named '${input.name}' already exists as a bundled agent (${shadow.filePath}). ` +
          `Saving yours would shadow the bundled definition (precedence: project > user > bundled). ` +
          `If you intend to override the bundled agent, re-call with overwrite: true — otherwise pick a different name.`,
      );
    }

    if (shadow && shadow.source === 'bundled' && input.overwrite) {
      const outcome = await writeOutcome(
        'created-shadow',
        `Saved agent '${input.name}' to ${filePath}, shadowing the bundled agent (project > user > bundled). Base snapshot recorded for bundled-update sync.`,
      );
      if (replaceNote) outcome.message = `${outcome.message} ${replaceNote}`;
      return outcome;
    }

    if (shadow && shadow.source === 'project' && sourceLabel === 'user') {
      const outcome = await writeOutcome('created', `Saved agent '${input.name}' to ${filePath}.`);
      outcome.warnings.push(
        `A project-scope agent '${input.name}' already exists (${shadow.filePath}). Effective precedence: agentScope 'both' → project copy wins; 'user' → your new user copy is live; 'project' → your copy is not loaded.`,
      );
      if (replaceNote) outcome.message = `${outcome.message} ${replaceNote}`;
      return outcome;
    }

    if (shadow && shadow.source === 'user' && sourceLabel === 'project') {
      const outcome = await writeOutcome('created', `Saved agent '${input.name}' to ${filePath}.`);
      outcome.warnings.push(
        `A user-scope agent '${input.name}' already exists (${shadow.filePath}). Effective precedence: agentScope 'both'/'project' → your new project copy wins; 'user' → the user copy stays live and yours is not loaded.`,
      );
      if (replaceNote) outcome.message = `${outcome.message} ${replaceNote}`;
      return outcome;
    }

    if (shadow && shadow.source === 'project' && sourceLabel === 'project') {
      const outcome = await writeOutcome('created', `Saved agent '${input.name}' to ${filePath}.`);
      outcome.warnings.push(
        `Another project agents directory defines '${input.name}' (${shadow.filePath}); discovery loads only the nearest .pi/agents, so this copy shadows it for dispatches from this cwd.`,
      );
      if (replaceNote) outcome.message = `${outcome.message} ${replaceNote}`;
      return outcome;
    }

    const outcome = await writeOutcome('created', `Saved agent '${input.name}' to ${filePath}.`);
    if (replaceNote) outcome.message = `${outcome.message} ${replaceNote}`;
    return outcome;
  }

  // --- update path: target file exists and parses ---
  const change = summarizeChange(existing, input);
  if (change === null) {
    return {
      ok: true,
      action: 'unchanged',
      message: `Agent '${input.name}' is already up to date at ${filePath} — nothing written.`,
      filePath,
      warnings,
    };
  }

  if (isMajorChange(change) && !input.overwrite) {
    return blockedOutcome(
      `NOT saved: '${input.name}' exists at ${filePath} with MAJOR differences (${formatChange(change)}). ` +
        `This tool auto-applies only minor changes. If you truly intend to replace the definition, re-call with overwrite: true — ideally after confirming with the user — or save under a different name.`,
      change,
    );
  }

  const action: SaveAgentAction = isMajorChange(change) ? 'replaced' : 'updated';
  const kind = action === 'replaced' ? 'Replaced' : 'Updated';
  return writeOutcome(
    action,
    `${kind} agent '${input.name}' at ${filePath} (${formatChange(change)}).`,
    change,
  );
}

/**
 * Write the file, then re-parse it to prove the round trip (name/description
 * come back as the exact strings we sent). On failure: restore the previous
 * content on the update path, delete the file on the create path — a broken
 * write must never silently replace a working definition. Returns null on
 * success, or a user-facing failure message (including leftover-path
 * reporting when the recovery itself fails).
 *
 * Exported as a test seam (house style, cf. readTierModelsFile).
 */
export async function writeAndVerify(
  filePath: string,
  fileText: string,
  previousRaw: string | null,
  input: SaveDefinitionInput,
): Promise<string | null> {
  return withFileMutationQueue(filePath, async () => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, fileText, 'utf-8');

    let detail = '';
    try {
      const written = await fs.promises.readFile(filePath, 'utf-8');
      const { frontmatter } = parseFrontmatter<{ name?: unknown; description?: unknown }>(written);
      if (frontmatter.name !== input.name || frontmatter.description !== input.description) {
        detail = `round-trip mismatch (name/description did not survive YAML encoding)`;
      }
    } catch (err) {
      detail = `round-trip parse failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (detail === '') return null;

    try {
      if (previousRaw === null) {
        await fs.promises.rm(filePath, { force: true });
        return `Save failed: ${detail}. The broken file was removed; nothing was changed.`;
      }
      await fs.promises.writeFile(filePath, previousRaw, 'utf-8');
      return `Save failed: ${detail}. The previous definition was restored unchanged.`;
    } catch (cleanupErr) {
      const cleanup = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      return `Save failed: ${detail}. Recovery also failed (${cleanup}) — the file at ${filePath} is left in the broken state and needs manual attention.`;
    }
  });
}
