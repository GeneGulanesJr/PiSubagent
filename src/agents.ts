import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from './types.js';

export type AgentScope = 'user' | 'project' | 'both';

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  bundledDir: string;
}

type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
};

export function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const tools = raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function loadAgentsFromDir(
  dir: string,
  source: 'user' | 'project' | 'bundled',
): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!fs.existsSync(dir)) return agents;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
    if (typeof frontmatter.name !== 'string' || typeof frontmatter.description !== 'string') {
      continue;
    }

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseToolList(frontmatter.tools),
      model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

export function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, 'agents');
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/**
 * Resolve the package's bundled agents/ directory from this module's location.
 * src/agents.ts → ../../agents (package root's agents/).
 */
export function resolveBundledAgentsDir(importMetaUrl: string): string {
  const here = path.dirname(fileURLToPath(importMetaUrl));
  return path.resolve(here, '../../agents');
}

/**
 * Discover agents from bundled, user, and project directories.
 * Precedence (most-specific wins): project > user > bundled.
 * Implemented via Map.set insertion in reverse-priority order.
 *
 * AgentScope semantics:
 *   - "user"    → bundled + user sources; project agents NEVER loaded.
 *   - "project" → project source only (bundled and user skipped).
 *   - "both"    → bundled + user + project sources.
 *
 * Note: the TypeBox schema in src/index.ts constrains the public surface to
 * exactly these three values. As defensive code (and to make the runtime
 * behavior obvious to readers), anything that is not "user" or "project" is
 * treated as "both". This previously fell through implicitly via the
 * `scope === "user" || !projectAgentsDir` check, which silently merged
 * unknown values into the all-three-source path. That is now explicit.
 */
export function discoverAgents(
  cwd: string,
  scope: AgentScope,
  bundledDir: string,
): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), 'agents');
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  // Scope → load-source matrix. The TypeBox schema in src/index.ts already
  // constrains the public surface to "user" | "project" | "both"; this is
  // defensive runtime handling so the matrix is obvious to readers and the
  // previous implicit fallthrough (silently loading everything for any
  // value that wasn't "user" or "project") is no longer a surprise.
  //
  //   scope         bundled  user  project
  //   "user"          yes     yes    no
  //   "project"        no      no    yes
  //   "both"          yes     yes    yes
  //   anything else   yes     yes    yes  (defensive: same as "both")
  const loadBundled = scope !== 'project';
  const loadUser = scope !== 'project';
  const loadProject = scope !== 'user';

  const bundledAgents = loadBundled ? loadAgentsFromDir(bundledDir, 'bundled') : [];
  const userAgents = loadUser ? loadAgentsFromDir(userDir, 'user') : [];
  const projectAgents =
    loadProject && projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, 'project') : [];

  const agentMap = new Map<string, AgentConfig>();
  for (const a of bundledAgents) agentMap.set(a.name, a);
  for (const a of userAgents) agentMap.set(a.name, a);
  for (const a of projectAgents) agentMap.set(a.name, a);

  return {
    agents: Array.from(agentMap.values()),
    projectAgentsDir,
    bundledDir,
  };
}
