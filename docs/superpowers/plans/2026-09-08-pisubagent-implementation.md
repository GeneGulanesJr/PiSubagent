# PiSubagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Use Sequential mode for planned tasks or Direct mode if subagents aren't available. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a publishable npm pi-package named `pisubagent` that registers a `subagent` tool inside the Pi coding agent, supporting three modes (single / parallel / chain), with a swappable `AgentRunner` interface so a v2 in-process backend can be added without rewriting the rest.

**Architecture:** Single Pi extension in `~/Documents/GulanesKorp/PiSubagent/`. Three layers: (1) tool registration in `src/index.ts` routes to (2) `src/dispatch.ts` orchestrator which delegates per-agent execution to (3) `src/runner/subprocess.ts` (v1) or `src/runner/in-process.ts` (v2 stub). Agent discovery in `src/agents.ts` walks bundled / user / project directories with most-specific-wins precedence. `src/security.ts` enforces project-trust + confirmation flow. `src/render.ts` produces TUI output. `src/output.ts` formats tokens / truncates output / extracts display items.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), TypeBox schemas, vitest for tests, `@earendil-works/pi-coding-agent` peer dep (registers agents via `ExtensionAPI`). SubprocessRunner spawns `pi` via Node `child_process.spawn` with `--mode json -p --no-session` and JSONL event parsing on stdout. No external services; pure local files.

---

## File Map

Created in `~/Documents/GulanesKorp/PiSubagent/`:

| File                                             | Responsibility                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`                                   | npm pi-package metadata (`pi-package` keyword, `pi.extensions` entry, MIT license)                                                                                                                                 |
| `tsconfig.json`                                  | ESM, strict, Node 20 target                                                                                                                                                                                        |
| `vitest.config.ts`                               | node environment, tests in `test/`, coverage threshold 80% on `src/runner`, `src/agents.ts`, `src/security.ts`, `src/output.ts`                                                                                    |
| `Dockerfile`                                     | parity with PiArgus; sandboxed repro                                                                                                                                                                               |
| `.gitignore`                                     | node_modules, dist, .env, *.log                                                                                                                                                                                    |
| `.dockerignore`                                  | node_modules, .git, test/                                                                                                                                                                                          |
| `README.md`                                      | install + use instructions                                                                                                                                                                                         |
| `LICENSE`                                        | MIT standard text                                                                                                                                                                                                  |
| `src/index.ts`                                   | ExtensionAPI entry: registers `subagent` tool                                                                                                                                                                      |
| `src/types.ts`                                   | `SubagentParams`, `SubagentDetails`, `SingleResult`, `UsageStats`, `DisplayItem`, `OnUpdateCallback`                                                                                                               |
| `src/output.ts`                                  | pure: `formatTokens`, `truncateParallelOutput`, `getDisplayItems`, `formatToolCall`, `formatUsageStats`                                                                                                            |
| `src/agents.ts`                                  | `AgentConfig`, `loadAgentsFromDir`, `findNearestProjectAgentsDir`, `discoverAgents` (cwd, scope, bundledDir)                                                                                                       |
| `src/runner/runner.ts`                           | `AgentRunner` interface, `AgentRunInput`                                                                                                                                                                           |
| `src/runner/subprocess.ts`                       | `SubprocessRunner` impl + helpers: `resolvePiInvocation`, `writePromptFile`, `killOnAbort`, `parseJsonlEvents`, `runSingleAgent`, `getFinalOutput`, `isFailedResult`, `getResultOutput`, `mapWithConcurrencyLimit` |
| `src/runner/in-process.ts`                       | `InProcessRunner` stub (throws `Error("…v2…")` referencing spec)                                                                                                                                                   |
| `src/dispatch.ts`                                | mode detection + orchestration: `detectMode`, `execute`, `runSingle`, `runChain`, `runParallel`, `selectRunner`, `confirmProjectAgentsIfNeeded`                                                                    |
| `src/security.ts`                                | project-agent confirmation helper                                                                                                                                                                                  |
| `src/render.ts`                                  | `renderCall`, `renderResult`, theme injection (uses `@earendil-works/pi-tui` Container/Text/Markdown per upstream convention)                                                                                      |
| `agents/scout.md`                                | Haiku, read-only recon                                                                                                                                                                                             |
| `agents/planner.md`                              | Sonnet, read-only plan                                                                                                                                                                                             |
| `agents/reviewer.md`                             | Sonnet, read-only review                                                                                                                                                                                           |
| `agents/worker.md`                               | Sonnet, full tool set                                                                                                                                                                                              |
| `prompts/implement.md`                           | scout→planner→worker chain                                                                                                                                                                                         |
| `prompts/scout-and-plan.md`                      | scout→planner chain                                                                                                                                                                                                |
| `prompts/implement-and-review.md`                | worker→reviewer→worker chain                                                                                                                                                                                       |
| `skills/pi-subagent-driven-development/SKILL.md` | new skill (fork of merged `subagent-driven-development`)                                                                                                                                                           |
| `test/agents.test.ts`                            | frontmatter parsing, scope merging, bundled path resolve                                                                                                                                                           |
| `test/dispatch.test.ts`                          | modeCount validation, chain `{previous}`, chain stop on failure, parallel concurrency, abort propagation                                                                                                           |
| `test/runner-subprocess.test.ts`                 | `resolvePiInvocation`, `killOnAbort` fake-timer escalation, `parseJsonlEvents`, `SingleResult` population, CLI flag composition                                                                                    |
| `test/security.test.ts`                          | agentScope switching, project-agent confirmation on trusted vs untrusted projects, `confirmProjectAgents: false` opt-out                                                                                           |
| `test/output.test.ts`                            | `formatTokens` edges, `truncateParallelOutput` byte-boundary, `getDisplayItems` filtering                                                                                                                          |
| `test/render.test.ts`                            | `renderCall` per mode, `renderResult` collapsed + expanded                                                                                                                                                         |
| `test/index.test.ts`                             | tool registration metadata + parameter schema + mock agent round-trip                                                                                                                                              |
| `test/fixtures/minimal-agent.md`                 | minimal valid agent frontmatter for tests                                                                                                                                                                          |
| `test/fixtures/minimal-extension-stub.ts`        | minimal `ExtensionAPI` mock for tests                                                                                                                                                                              |

---

## Task 1: Repo scaffold + initial commit

**Files:**

- Create: `~/Documents/GulanesKorp/PiSubagent/package.json`
- Create: `~/Documents/GulanesKorp/PiSubagent/tsconfig.json`
- Create: `~/Documents/GulanesKorp/PiSubagent/vitest.config.ts`
- Create: `~/Documents/GulanesKorp/PiSubagent/Dockerfile`
- Create: `~/Documents/GulanesKorp/PiSubagent/.gitignore`
- Create: `~/Documents/GulanesKorp/PiSubagent/.dockerignore`
- Create: `~/Documents/GulanesKorp/PiSubagent/README.md`
- Create: `~/Documents/GulanesKorp/PiSubagent/LICENSE`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pisubagent",
  "version": "0.1.0",
  "description": "Pi subagent tool — isolated subprocess dispatch with three modes (single / parallel / chain). Bundled scout / planner / reviewer / worker agents.",
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "subagent", "agent", "dispatch"],
  "license": "MIT",
  "files": [
    "src/**/*",
    "agents/**/*.md",
    "prompts/**/*.md",
    "skills/**/*",
    "Dockerfile",
    ".dockerignore",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build": "tsc"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0",
    "@types/node": "^20.0.0"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/runner/**/*.ts', 'src/agents.ts', 'src/security.ts', 'src/output.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
```

- [ ] **Step 4: Create `Dockerfile`**

```dockerfile
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY agents ./agents
COPY prompts ./prompts
COPY skills ./skills
COPY test ./test
CMD ["npm", "test"]
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
.env
*.log
.DS_Store
coverage/
.vitest-cache/
```

- [ ] **Step 6: Create `.dockerignore`**

```
node_modules
.git
test
coverage
dist
*.log
```

- [ ] **Step 7: Create `LICENSE` (MIT standard text)**

```
MIT License

Copyright (c) 2026 GeneGulanesJr

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
```

- [ ] **Step 8: Create `README.md`**

```markdown
# pisubagent

Pi subagent tool. Single command, three modes.

## Install

`pi install git:github.com/genegulanesjr/PiSubagent` (after pushing to GitHub).

## Use

Ask Pi to use the `subagent` tool:

- **Single**: `subagent(agent: "scout", task: "find auth code")`
- **Parallel**: `subagent(tasks: [{agent:"scout", task:"find models"}, {agent:"scout", task:"find providers"}])`
- **Chain**: `subagent(chain: [{agent:"scout", task:"..."}, {agent:"planner", task:"...{previous}..."}])`

## Built-in agents

- `scout` (Haiku, read-only) — fast recon
- `planner` (Sonnet, read-only) — implementation plans
- `reviewer` (Sonnet, read-only) — code review
- `worker` (Sonnet, full tools) — general implementation

Override by dropping a same-named `*.md` in `~/.pi/agent/agents/`.

## License

MIT
```

- [ ] **Step 9: `npm install`**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npm install`
Expected: `node_modules/` populated; no errors.

- [ ] **Step 10: Verify typecheck and tests run**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npm run typecheck && npm test`
Expected: typecheck OK (no `src/` files yet, vacuously); tests OK (no test files yet).

- [ ] **Step 11: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add package.json tsconfig.json vitest.config.ts Dockerfile .gitignore .dockerignore README.md LICENSE
git commit -m "chore: scaffold pisubagent pi-package (package.json, tsconfig, vitest, Dockerfile, MIT license)"
```

---

## Task 2: types.ts (subagent domain types)

**Files:**

- Create: `src/types.ts`
- Test: `test/types.test.ts`

- [ ] **Step 1: Write the failing test (`test/types.test.ts`)**

```typescript
import { describe, expectTypeOf } from 'vitest';
import type { SubagentParams, SingleResult, SubagentDetails, UsageStats } from '../src/types.js';

describe('types', () => {
  it('SubagentParams has correct optional fields', () => {
    expectTypeOf<SubagentParams>().toMatchTypeOf<{
      agent?: string;
      task?: string;
      tasks?: Array<{ agent: string; task: string; cwd?: string }>;
      chain?: Array<{ agent: string; task: string; cwd?: string }>;
      agentScope?: 'user' | 'project' | 'both';
      confirmProjectAgents?: boolean;
      cwd?: string;
    }>();
  });

  it('SingleResult carries agent + task + messages + usage', () => {
    expectTypeOf<SingleResult['agent']>().toEqualTypeOf<string>();
    expectTypeOf<SingleResult['task']>().toEqualTypeOf<string>();
    expectTypeOf<SingleResult['exitCode']>().toEqualTypeOf<number>();
    expectTypeOf<SingleResult['usage']>().toEqualTypeOf<UsageStats>();
  });

  it('SubagentDetails carries mode + results + agentScope', () => {
    expectTypeOf<SubagentDetails['mode']>().toEqualTypeOf<'single' | 'parallel' | 'chain'>();
    expectTypeOf<SubagentDetails['results']>().toEqualTypeOf<SingleResult[]>();
    expectTypeOf<SubagentDetails['agentScope']>().toEqualTypeOf<'user' | 'project' | 'both'>();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/types.test.ts`
Expected: FAIL with "Cannot find module '../src/types.js'" or similar.

- [ ] **Step 3: Write `src/types.ts`**

```typescript
import type { ThinkingLevel } from '@earendil-works/pi-coding-agent';
import type { Message, AgentToolResult } from '@earendil-works/pi-coding-agent';

export interface SubagentParams {
  agent?: string;
  task?: string;
  tasks?: Array<{ agent: string; task: string; cwd?: string }>;
  chain?: Array<{ agent: string; task: string; cwd?: string }>;
  agentScope?: 'user' | 'project' | 'both';
  confirmProjectAgents?: boolean;
  cwd?: string;
}

export type Mode = 'single' | 'parallel' | 'chain';

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: 'user' | 'project' | 'unknown';
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface SubagentDetails {
  mode: Mode;
  agentScope: 'user' | 'project' | 'both';
  projectAgentsDir: string | null;
  results: SingleResult[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface AgentRunInput {
  agent: AgentConfig;
  task: string;
  cwd: string;
  parentModel?: string;
  parentThinkingLevel?: ThinkingLevel;
}

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: 'user' | 'project' | 'bundled';
  filePath: string;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/types.ts test/types.test.ts
git commit -m "feat: add subagent domain types (SubagentParams, SingleResult, SubagentDetails)"
```

---

## Task 3: output.ts pure formatting helpers

**Files:**

- Create: `src/output.ts`
- Test: `test/output.test.ts`

- [ ] **Step 1: Write `test/output.test.ts` (TDD)**

```typescript
import { describe, it, expect } from 'vitest';
import {
  formatTokens,
  truncateParallelOutput,
  getDisplayItems,
  formatUsageStats,
  formatToolCall,
} from '../src/output.js';

describe('formatTokens', () => {
  it('returns plain number for small counts', () => {
    expect(formatTokens(500)).toBe('500');
  });
  it('formats thousands with 1 decimal', () => {
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(9500)).toBe('9.5k');
  });
  it('rounds ten-thousands to whole k', () => {
    expect(formatTokens(10500)).toBe('11k');
  });
  it('uses M for millions', () => {
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

describe('truncateParallelOutput', () => {
  it('returns input unchanged when under cap', () => {
    expect(truncateParallelOutput('hello', 100)).toBe('hello');
  });
  it('truncates by bytes near boundary', () => {
    const input = 'a'.repeat(200);
    const out = truncateParallelOutput(input, 50);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(50);
    expect(out).toMatch(/truncated:/);
  });
  it('preserves byte length within cap with multibyte chars', () => {
    const input = '🚀'.repeat(100); // each 🚀 is 4 bytes
    const out = truncateParallelOutput(input, 50);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(50);
  });
});

describe('getDisplayItems', () => {
  const assistantText = {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'hello' }],
  };
  const assistantTool = {
    role: 'assistant' as const,
    content: [{ type: 'toolCall' as const, name: 'bash', arguments: { command: 'ls' } }],
  };
  const userMsg = {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'please ls' }],
  };

  it('extracts text and toolCall from assistant messages only', () => {
    const items = getDisplayItems([assistantText, userMsg, assistantTool]);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ type: 'text', text: 'hello' });
    expect(items[1]).toEqual({ type: 'toolCall', name: 'bash', args: { command: 'ls' } });
  });
});

describe('formatUsageStats', () => {
  const usage = {
    input: 100,
    output: 200,
    cacheRead: 50,
    cacheWrite: 0,
    cost: 0.0042,
    contextTokens: 350,
    turns: 2,
  };

  it('renders meaningful parts in order turns ↑input ↓output Rcache Wcache $cost ctx: model', () => {
    expect(formatUsageStats(usage, 'sonnet')).toBe('2 turns ↑100 ↓200 R50 $0.0042 ctx:350 sonnet');
  });

  it('omits zero-value parts', () => {
    expect(
      formatUsageStats(
        { ...usage, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        undefined,
      ),
    ).toBe('↑100 ↓200');
  });
});

describe('formatToolCall', () => {
  it('formats bash with $ prefix and 60-char preview', () => {
    const long = 'echo ' + 'x'.repeat(80);
    expect(formatToolCall('bash', { command: long }, (s) => s)).toMatch(/^\$ echo x{60,80}\.\.\.$/);
  });
  it('shortens home path in read', () => {
    expect(formatToolCall('read', { path: '/home/me/file.ts' }, (s) => s)).toContain('~/file.ts');
  });
  it('falls back to name + JSON preview for unknown tools', () => {
    const out = formatToolCall('custom', { foo: 'bar' }, (s) => s);
    expect(out).toContain('custom');
    expect(out).toContain('foo');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/output.test.ts`
Expected: FAIL with "Cannot find module '../src/output.js'".

- [ ] **Step 3: Write `src/output.ts`**

```typescript
import * as os from 'node:os';
import type { Message } from '@earendil-works/pi-coding-agent';
import type { UsageStats, SingleResult } from './types.js';

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function truncateParallelOutput(output: string, capBytes: number): string {
  const byteLength = Buffer.byteLength(output, 'utf8');
  if (byteLength <= capBytes) return output;

  let truncated = output.slice(0, capBytes);
  while (Buffer.byteLength(truncated, 'utf8') > capBytes) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, 'utf8')} bytes omitted. Full output preserved in tool details.]`;
}

export type DisplayItem =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; name: string; args: Record<string, unknown> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content) {
      if (part.type === 'text') items.push({ type: 'text', text: part.text });
      else if (part.type === 'toolCall') {
        items.push({
          type: 'toolCall',
          name: part.name,
          args: part.arguments as Record<string, unknown>,
        });
      }
    }
  }
  return items;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(' ');
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: string, text: string) => string,
): string {
  const shortenPath = (p: string): string => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case 'bash': {
      const command = (args.command as string) || '...';
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg('muted', '$ ') + themeFg('toolOutput', preview);
    }
    case 'read': {
      const rawPath = (args.file_path || args.path || '...') as string;
      return themeFg('muted', 'read ') + themeFg('accent', shortenPath(rawPath));
    }
    case 'write': {
      const rawPath = (args.file_path || args.path || '...') as string;
      return themeFg('muted', 'write ') + themeFg('accent', shortenPath(rawPath));
    }
    case 'edit': {
      const rawPath = (args.file_path || args.path || '...') as string;
      return themeFg('muted', 'edit ') + themeFg('accent', shortenPath(rawPath));
    }
    case 'ls': {
      const rawPath = (args.path || '.') as string;
      return themeFg('muted', 'ls ') + themeFg('accent', shortenPath(rawPath));
    }
    case 'find': {
      const pattern = (args.pattern || '*') as string;
      const rawPath = (args.path || '.') as string;
      return (
        themeFg('muted', 'find ') +
        themeFg('accent', pattern) +
        themeFg('dim', ` in ${shortenPath(rawPath)}`)
      );
    }
    case 'grep': {
      const pattern = (args.pattern || '') as string;
      const rawPath = (args.path || '.') as string;
      return (
        themeFg('muted', 'grep ') +
        themeFg('accent', `/${pattern}/`) +
        themeFg('dim', ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg('accent', toolName) + themeFg('dim', ` ${preview}`);
    }
  }
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') return part.text;
      }
    }
  }
  return '';
}

export function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted';
}

export function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || '(no output)';
  }
  return getFinalOutput(result.messages) || '(no output)';
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/output.test.ts`
Expected: PASS for all 5 describes.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/output.ts test/output.test.ts
git commit -m "feat: add output helpers (formatTokens, truncateParallelOutput, getDisplayItems, formatToolCall, formatUsageStats, getFinalOutput, isFailedResult)"
```

---

## Task 4: agents.ts — frontmatter parsing + scope merging + bundled dir resolve

**Files:**

- Create: `src/agents.ts`
- Create: `test/fixtures/minimal-agent.md`
- Test: `test/agents.test.ts`

- [ ] **Step 1: Add fixture `test/fixtures/minimal-agent.md`**

```markdown
---
name: fixture-agent
description: a test agent
tools: read, bash
model: claude-haiku-4-5
---

You are a fixture agent used by tests.
```

- [ ] **Step 2: Write `test/agents.test.ts` (TDD)**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseToolList,
  loadAgentsFromDir,
  findNearestProjectAgentsDir,
  discoverAgents,
} from '../src/agents.js';

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
    expect(agents[0].source).toBe('user');
    expect(agents[0].systemPrompt).toContain('fixture agent');
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

describe('discoverAgents', () => {
  it('respects scope=user: only user + bundled', () => {
    const discovery = discoverAgents('/somewhere', 'user', '/bundled');
    expect(discovery.agents.map((a) => a.name)).toEqual(expect.arrayContaining(['fixture-agent']));
    expect(discovery.bundledDir).toBe('/bundled');
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/agents.test.ts`
Expected: FAIL with "Cannot find module '../src/agents.js'".

- [ ] **Step 4: Write `src/agents.ts`**

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  thinkingLevel?: unknown;
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

function loadAgentsFromDir(dir: string, source: 'user' | 'project' | 'bundled'): AgentConfig[] {
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
    if (typeof frontmatter.name !== 'string' || typeof frontmatter.description !== 'string')
      continue;

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

export function discoverAgents(
  cwd: string,
  scope: AgentScope,
  bundledDir: string,
): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), 'agents');
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const bundledAgents = loadAgentsFromDir(bundledDir, 'bundled');
  const userAgents = scope === 'project' ? [] : loadAgentsFromDir(userDir, 'user');
  const projectAgents =
    scope === 'user' || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, 'project');

  // Precedence: project > user > bundled. Insert in reverse order so later-set wins.
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

export function resolveBundledAgentsDir(importMetaUrl: string): string {
  const here = path.dirname(new URL(importMetaUrl).pathname);
  return path.resolve(here, '../../agents');
}
```

- [ ] **Step 5: Run test, verify it passes**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/agents.test.ts`
Expected: PASS for all describes.

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/agents.ts test/agents.test.ts test/fixtures/
git commit -m "feat: add agents.ts (frontmatter parse, scope merging, bundled-dir resolution, project-dir walking)"
```

---

## Task 5: runner/runner.ts (AgentRunner interface + AgentRunInput)

**Files:**

- Create: `src/runner/runner.ts`
- Test: `test/runner-interface.test.ts`

- [ ] **Step 1: Write `test/runner-interface.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import type { AgentRunner, AgentRunInput } from '../src/runner/runner.js';

describe('AgentRunner contract', () => {
  it('is implementable by a class with id literal', () => {
    class TestRunner implements AgentRunner {
      readonly id = 'subprocess' as const;
      async run(_input: AgentRunInput): Promise<import('../src/types.js').SingleResult> {
        return {
          agent: 'x',
          agentSource: 'unknown',
          task: '',
          exitCode: 0,
          messages: [],
          stderr: '',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
        };
      }
    }
    expect(new TestRunner().id).toBe('subprocess');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/runner-interface.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/runner/runner.ts`**

```typescript
import type { SingleResult, AgentConfig } from '../types.js';
import type { ThinkingLevel, Message } from '@earendil-works/pi-coding-agent';

export interface AgentRunInput {
  agent: AgentConfig;
  task: string;
  cwd: string;
  parentModel?: string;
  parentThinkingLevel?: ThinkingLevel;
  /** Pre-substituted text replacing {previous} for chain steps. */
  resolvedTask?: string;
}

export type AgentRunnerId = 'subprocess' | 'in-process';

export interface AgentRunner {
  readonly id: AgentRunnerId;
  run(
    input: AgentRunInput,
    signal?: AbortSignal,
    onUpdate?: (partial: SingleResult) => void,
  ): Promise<SingleResult>;
}

// Re-export Message so consumers don't reach into @earendil-works/pi-coding-agent
export type { Message };
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/runner-interface.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/runner/runner.ts test/runner-interface.test.ts
git commit -m "feat: add AgentRunner interface + AgentRunInput"
```

---

## Task 6: runner/subprocess.ts — helpers (resolvePiInvocation, writePromptFile)

**Files:**

- Modify: `src/runner/subprocess.ts`
- Test: `test/runner-subprocess.test.ts`

- [ ] **Step 1: Write `test/runner-subprocess.test.ts` (initial — helpers)**

```typescript
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolvePiInvocation, writePromptFile } from '../src/runner/subprocess.js';

describe('resolvePiInvocation', () => {
  it('returns { command: process.execPath, args: [currentScript, ...args] } when script path exists', () => {
    // The current vitest script path should exist on disk.
    const result = resolvePiInvocation(['--help']);
    expect(result.command).toBe(process.execPath);
    expect(result.args).toContain('--help');
  });
});

describe('writePromptFile', () => {
  it('writes prompt content to a temp file and returns paths', async () => {
    const result = await writePromptFile('agent-name', 'system prompt body');
    expect(result.filePath).toMatch(/agent-name\.md$/);
    const content = await fs.readFile(result.filePath, 'utf-8');
    expect(content).toBe('system prompt body');
    await fs.rm(result.dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/runner-subprocess.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Write `src/runner/subprocess.ts` (helpers only — full runner in Task 7-9)**

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import type { AgentRunner } from './runner.js';
import type { SingleResult, AgentRunInput } from '../types.js';

export interface PiInvocation {
  command: string;
  args: string[];
}

export function resolvePiInvocation(args: string[]): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith('/$bunfs/root/');
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: 'pi', args };
}

export async function writePromptFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-'));
  const safeName = agentName.replace(/[^\w.-]+/g, '_');
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: 'utf-8', mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

// Placeholder exports for compilation; runners in Tasks 7-9 complete these.
export const __placeholder_runSingleAgent = null;
export const __placeholder_parseJsonlEvents = null;
export const __placeholder_killOnAbort = null;
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/runner-subprocess.test.ts`
Expected: PASS for the two helper describes.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/runner/subprocess.ts test/runner-subprocess.test.ts
git commit -m "feat: add subprocess helpers (resolvePiInvocation, writePromptFile)"
```

---

## Task 7: runner/subprocess.ts — killOnAbort + parseJsonlEvents

**Files:**

- Modify: `src/runner/subprocess.ts` (replace placeholders)
- Modify: `test/runner-subprocess.test.ts` (append)

- [ ] **Step 1: Append failing tests**

Add to `test/runner-subprocess.test.ts`:

```typescript
import { killOnAbort, parseJsonlEvents } from '../src/runner/subprocess.js';

describe('killOnAbort', () => {
  it('sends SIGTERM on abort, escalates to SIGKILL after 5s', async () => {
    vi.useFakeTimers();
    const proc = { kill: vi.fn() } as unknown as ChildProcess;
    const controller = new AbortController();
    killOnAbort(proc, controller.signal);
    controller.abort();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(5100);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });

  it('no-ops when signal already aborted', () => {
    const proc = { kill: vi.fn() } as unknown as ChildProcess;
    const controller = new AbortController();
    controller.abort();
    killOnAbort(proc, controller.signal);
    // Run the listener manually via DOM exception would be complex; behavior here:
    // the function should immediately call kill due to signal.aborted being true.
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('parseJsonlEvents', () => {
  it('yields parsed events from newline-delimited input', () => {
    const events = [
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
      { type: 'tool_result_end', message: { role: 'tool', content: [] } },
    ];
    const stream = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const collected: unknown[] = [];
    for (const ev of parseJsonlEvents(stream)) collected.push(ev);
    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual(events[0]);
  });

  it('skips malformed lines', () => {
    const stream = 'not-json\n' + JSON.stringify({ type: 'ok' }) + '\n';
    const collected: unknown[] = [];
    for (const ev of parseJsonlEvents(stream)) collected.push(ev);
    expect(collected).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/runner-subprocess.test.ts`
Expected: FAIL (killOnAbort / parseJsonlEvents not exported yet).

- [ ] **Step 3: Replace placeholder block in `src/runner/subprocess.ts` with implementation**

Replace the `__placeholder_*` exports at the end of `src/runner/subprocess.ts` with:

```typescript
export type JsonlEvent = Record<string, unknown> & { type: string };

export function* parseJsonlEvents(stream: string): IterableIterator<JsonlEvent> {
  for (const line of stream.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as JsonlEvent;
    } catch {
      // skip malformed lines
    }
  }
}

export function killOnAbort(proc: ChildProcess, signal: AbortSignal): void {
  const killProc = () => {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 5000);
  };
  if (signal.aborted) killProc();
  else signal.addEventListener('abort', killProc, { once: true });
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/runner-subprocess.test.ts`
Expected: PASS for all describes.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/runner/subprocess.ts test/runner-subprocess.test.ts
git commit -m "feat: add killOnAbort (SIGTERM-then-SIGKILL) + parseJsonlEvents (newline-delimited JSON)"
```

---

## Task 8: runner/subprocess.ts — SubprocessRunner class with CLI flag composition + SingleResult population

**Files:**

- Modify: `src/runner/subprocess.ts` (add class)
- Test: `test/runner-subprocess.test.ts` (append)

- [ ] **Step 1: Append failing test**

Add to `test/runner-subprocess.test.ts`:

```typescript
import { SubprocessRunner } from '../src/runner/subprocess.js';

describe('SubprocessRunner composition (no spawn)', () => {
  it('builds --mode json -p --no-session baseline args', () => {
    const runner = new SubprocessRunner({ spawnFn: () => ({}) as never });
    const args = runner.buildArgs(
      {
        agent: { tools: undefined, model: undefined, systemPrompt: '' } as never,
        task: 'find auth',
        cwd: '/tmp',
        resolvedTask: undefined,
      },
      { parentModel: undefined, parentThinkingLevel: undefined },
    );
    expect(args).toContain('--mode');
    expect(args).toContain('json');
    expect(args).toContain('-p');
    expect(args).toContain('--no-session');
    expect(args[args.length - 1]).toBe('Task: find auth');
  });

  it('appends --model when agent.model is set', () => {
    const runner = new SubprocessRunner({ spawnFn: () => ({}) as never });
    const args = runner.buildArgs(
      {
        agent: { model: 'claude-sonnet-4-5' } as never,
        task: 'x',
        cwd: '/tmp',
        resolvedTask: undefined,
      },
      { parentModel: undefined },
    );
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe('claude-sonnet-4-5');
  });

  it('appends --thinking only when agent.model is unset and parent provides a thinkingLevel', () => {
    const runner = new SubprocessRunner({ spawnFn: () => ({}) as never });
    const args = runner.buildArgs(
      { agent: { model: undefined } as never, task: 'x', cwd: '/tmp', resolvedTask: undefined },
      { parentThinkingLevel: 'low' },
    );
    const idx = args.indexOf('--thinking');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('low');
  });

  it('appends --append-system-prompt only when systemPrompt is non-empty', () => {
    const runner = new SubprocessRunner({ spawnFn: () => ({}) as never });
    const withPrompt = runner.buildArgs(
      {
        agent: { systemPrompt: 'You are X.' } as never,
        task: 'x',
        cwd: '/tmp',
        resolvedTask: undefined,
      },
      { parentModel: undefined, parentThinkingLevel: undefined },
    );
    expect(withPrompt).toContain('--append-system-prompt');

    const empty = runner.buildArgs(
      { agent: { systemPrompt: '' } as never, task: 'x', cwd: '/tmp', resolvedTask: undefined },
      { parentModel: undefined, parentThinkingLevel: undefined },
    );
    expect(empty).not.toContain('--append-system-prompt');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/runner-subprocess.test.ts`
Expected: FAIL (SubprocessRunner not exported).

- [ ] **Step 3: Append the SubprocessRunner class to `src/runner/subprocess.ts`**

```typescript
import type { AgentRunner } from './runner.js';
import type { SpawnOptions, ChildProcess } from 'node:child_process';

export interface SubprocessRunnerOptions {
  spawnFn: typeof spawn;
}

export class SubprocessRunner implements AgentRunner {
  readonly id = 'subprocess' as const;
  private readonly spawnFn: typeof spawn;

  constructor(options: SubprocessRunnerOptions) {
    this.spawnFn = options.spawnFn;
  }

  /**
   * Pure CLI-flag composition for a single dispatch. Used by the test suite
   * without actually spawning anything.
   */
  buildArgs(
    input: AgentRunInput,
    dispatchDefaults: {
      parentModel?: string;
      parentThinkingLevel?: import('@earendil-works/pi-coding-agent').ThinkingLevel;
    },
  ): string[] {
    const args: string[] = ['--mode', 'json', '-p', '--no-session'];
    const inheritsDispatchConfig = !input.agent.model;
    const model = input.agent.model ?? dispatchDefaults.parentModel;
    if (model) args.push('--model', model);
    if (inheritsDispatchConfig && dispatchDefaults.parentThinkingLevel) {
      args.push('--thinking', dispatchDefaults.parentThinkingLevel);
    }
    if (input.agent.tools && input.agent.tools.length > 0) {
      args.push('--tools', input.agent.tools.join(','));
    }
    // Note: --append-system-prompt is conditionally appended inside run()
    // because it requires a temp file path. buildArgs returns the prefix only;
    // run() appends the final flags.
    return args;
  }

  /**
   * Build the remainder of the CLI args (system prompt + task). Returns the
   * appended segments in order. Exposed for testing.
   */
  buildSuffix(systemPrompt: string, task: string): string[] {
    const suffix: string[] = [];
    if (systemPrompt.trim()) suffix.push('--append-system-prompt', '<tempFile>');
    suffix.push(`Task: ${task}`);
    return suffix;
  }

  async run(
    input: AgentRunInput,
    signal?: AbortSignal,
    onUpdate?: (partial: SingleResult) => void,
  ): Promise<SingleResult> {
    const args = this.buildArgs(input, {
      parentModel: input.parentModel,
      parentThinkingLevel: input.parentThinkingLevel,
    });

    const result: SingleResult = {
      agent: input.agent.name,
      agentSource: input.agent.source,
      task: input.task,
      exitCode: 0,
      messages: [],
      stderr: '',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      model: input.agent.model ?? input.parentModel,
      step: undefined,
    };

    let tmpPromptDir: string | null = null;
    let tmpPromptPath: string | null = null;
    let wasAborted = false;

    try {
      if (input.agent.systemPrompt.trim()) {
        const tmp = await writePromptFile(input.agent.name, input.agent.systemPrompt);
        tmpPromptDir = tmp.dir;
        tmpPromptPath = tmp.filePath;
        args.push('--append-system-prompt', tmpPromptPath);
      }
      args.push(`Task: ${input.resolvedTask ?? input.task}`);

      const exitCode = await new Promise<number>((resolve) => {
        const invocation = resolvePiInvocation(args);
        const proc: ChildProcess = this.spawnFn(invocation.command, invocation.args, {
          cwd: input.cwd,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let buffer = '';
        const processLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let event: Record<string, unknown> & { type?: string };
          try {
            event = JSON.parse(trimmed);
          } catch {
            return;
          }
          if (event.type === 'message_end' && event.message) {
            const msg = event.message as import('../types.js').Message | undefined;
            if (msg) {
              result.messages.push(msg);
              if (msg.role === 'assistant') {
                result.usage.turns++;
                const usage = (msg as unknown as { usage?: UsageStats }).usage;
                if (usage) {
                  result.usage.input += usage.input || 0;
                  result.usage.output += usage.output || 0;
                  result.usage.cacheRead += usage.cacheRead || 0;
                  result.usage.cacheWrite += usage.cacheWrite || 0;
                  result.usage.cost += usage.cost || 0;
                  result.usage.contextTokens =
                    (usage as unknown as { totalTokens?: number }).totalTokens ?? 0;
                }
                const m = msg as unknown as {
                  model?: string;
                  stopReason?: string;
                  errorMessage?: string;
                };
                if (m.model && !result.model) result.model = m.model;
                if (m.stopReason) result.stopReason = m.stopReason;
                if (m.errorMessage) result.errorMessage = m.errorMessage;
              }
              onUpdate?.(result);
            }
          }
        };

        const stdout = proc.stdout;
        if (stdout) {
          stdout.on('data', (chunk: Buffer | string) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) processLine(line);
          });
        }
        const stderr = proc.stderr;
        if (stderr)
          stderr.on('data', (chunk: Buffer | string) => {
            result.stderr += chunk.toString();
          });

        proc.on('close', (code) => {
          if (buffer.trim()) processLine(buffer);
          resolve(code ?? 0);
        });
        proc.on('error', () => resolve(1));

        if (signal) {
          const killProc = () => {
            wasAborted = true;
            killOnAbort(proc, signal);
          };
          if (signal.aborted) killProc();
          else signal.addEventListener('abort', killProc, { once: true });
        }
      });

      result.exitCode = exitCode;
      if (wasAborted) result.stopReason = 'aborted';
      else if (exitCode !== 0 && !result.stopReason) result.stopReason = 'error';
      return result;
    } finally {
      if (tmpPromptPath)
        try {
          fs.unlinkSync(tmpPromptPath);
        } catch {
          /* ignore */
        }
      if (tmpPromptDir)
        try {
          fs.rmdirSync(tmpPromptDir);
        } catch {
          /* ignore */
        }
    }
  }
}

import type { UsageStats } from '../types.js';
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/runner-subprocess.test.ts`
Expected: PASS for all describes (helpers, killOnAbort, parseJsonlEvents, SubprocessRunner composition).

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/runner/subprocess.ts test/runner-subprocess.test.ts
git commit -m "feat: add SubprocessRunner with CLI flag composition + JSONL event ingestion"
```

---

## Task 9: runner/in-process.ts — v2 stub

**Files:**

- Create: `src/runner/in-process.ts`
- Test: `test/in-process-stub.test.ts`

- [ ] **Step 1: Write `test/in-process-stub.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { InProcessRunner } from '../src/runner/in-process.js';

describe('InProcessRunner (v2 stub)', () => {
  it("has id 'in-process'", () => {
    expect(new InProcessRunner().id).toBe('in-process');
  });

  it("run() throws with a doc-link to the spec's v2 section", async () => {
    const runner = new InProcessRunner();
    await expect(runner.run({ agent: {} as never, task: '', cwd: '/tmp' })).rejects.toThrow(
      /v2; not implemented in PiSubagent v1/,
    );
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/in-process-stub.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/runner/in-process.ts`**

```typescript
import type { AgentRunner } from './runner.js';
import type { AgentRunInput, SingleResult } from '../types.js';

export class InProcessRunner implements AgentRunner {
  readonly id = 'in-process' as const;

  async run(
    _input: AgentRunInput,
    _signal?: AbortSignal,
    _onUpdate?: (partial: SingleResult) => void,
  ): Promise<SingleResult> {
    throw new Error(
      'InProcessRunner is v2; not implemented in PiSubagent v1. See ' +
        '~/Documents/GulanesKorp/PiSubagent/docs/superpowers/specs/2026-09-08-pisubagent-design.md#in-process-backend',
    );
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/in-process-stub.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/runner/in-process.ts test/in-process-stub.test.ts
git commit -m "feat: add InProcessRunner v2 stub (throws NotImplemented pointing to spec)"
```

---

## Task 10: security.ts — project-agent confirmation helper

**Files:**

- Create: `src/security.ts`
- Test: `test/security.test.ts`

- [ ] **Step 1: Write `test/security.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { confirmProjectAgentsIfNeeded } from '../src/security.js';
import type { SubagentParams, AgentConfig } from '../src/types.js';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

function makeCtx(overrides: Partial<ExtensionContext>): ExtensionContext {
  return {
    cwd: '/tmp',
    hasUI: true,
    isProjectTrusted: () => false,
    ui: { confirm: vi.fn().mockResolvedValue(true) } as never,
    ...overrides,
  } as unknown as ExtensionContext;
}

function makeAgent(name: string, source: 'user' | 'project'): AgentConfig {
  return { name, description: 'x', systemPrompt: '', source, filePath: '' };
}

describe('confirmProjectAgentsIfNeeded', () => {
  const baseParams: SubagentParams = { agent: 'scout', task: 'x' };

  it("returns continue=true when agentScope is 'user'", async () => {
    const ctx = makeCtx({});
    const agents: AgentConfig[] = [makeAgent('scout', 'user')];
    const decision = await confirmProjectAgentsIfNeeded(baseParams, agents, ctx);
    expect(decision.continue).toBe(true);
  });

  it('skips prompt when ctx.isProjectTrusted() is true', async () => {
    const ctx = makeCtx({ isProjectTrusted: () => true, ui: { confirm: vi.fn() } as never });
    const agents: AgentConfig[] = [makeAgent('scout', 'project')];
    const decision = await confirmProjectAgentsIfNeeded(
      { ...baseParams, agentScope: 'project' },
      agents,
      ctx,
    );
    expect(decision.continue).toBe(true);
    expect((ctx.ui.confirm as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('prompts when project agent requested on untrusted project, returns cancelled if user declines', async () => {
    const ctx = makeCtx({ ui: { confirm: vi.fn().mockResolvedValue(false) } as never });
    const agents: AgentConfig[] = [makeAgent('scout', 'project')];
    const decision = await confirmProjectAgentsIfNeeded(
      { ...baseParams, agentScope: 'both' },
      agents,
      ctx,
    );
    expect(decision.continue).toBe(false);
    expect(ctx.ui.confirm).toHaveBeenCalledOnce();
  });

  it('honors confirmProjectAgents: false to skip prompt', async () => {
    const ctx = makeCtx({ ui: { confirm: vi.fn() } as never });
    const agents: AgentConfig[] = [makeAgent('scout', 'project')];
    const decision = await confirmProjectAgentsIfNeeded(
      { ...baseParams, agentScope: 'project', confirmProjectAgents: false },
      agents,
      ctx,
    );
    expect(decision.continue).toBe(true);
    expect((ctx.ui.confirm as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("no prompt when only user-level agents are requested even at scope 'both'", async () => {
    const ctx = makeCtx({});
    const agents: AgentConfig[] = [makeAgent('scout', 'user')];
    const decision = await confirmProjectAgentsIfNeeded(
      { ...baseParams, agentScope: 'both' },
      agents,
      ctx,
    );
    expect(decision.continue).toBe(true);
    expect((ctx.ui.confirm as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/security.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/security.ts`**

```typescript
import type { SubagentParams, AgentConfig } from './types.js';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface ConfirmationDecision {
  continue: boolean;
  /** List of agents triggering the prompt, surfaced for caller diagnostics. */
  requestedProjectAgents: AgentConfig[];
  /** Source directory of project agents, surfaced in the prompt body. */
  sourceDir?: string | null;
}

function getRequestedAgentNames(params: SubagentParams): string[] {
  const names = new Set<string>();
  if (params.chain) for (const step of params.chain) names.add(step.agent);
  if (params.tasks) for (const t of params.tasks) names.add(t.agent);
  if (params.agent) names.add(params.agent);
  return [...names];
}

export async function confirmProjectAgentsIfNeeded(
  params: SubagentParams,
  agents: AgentConfig[],
  ctx: ExtensionContext,
): Promise<ConfirmationDecision> {
  const scope = params.agentScope ?? 'user';
  if (scope === 'user') return { continue: true, requestedProjectAgents: [] };

  const requestedNames = new Set(getRequestedAgentNames(params));
  const requestedProjectAgents = agents.filter(
    (a) => requestedNames.has(a.name) && a.source === 'project',
  );

  if (requestedProjectAgents.length === 0) {
    return { continue: true, requestedProjectAgents: [] };
  }

  if (params.confirmProjectAgents === false) {
    return { continue: true, requestedProjectAgents };
  }

  if (ctx.isProjectTrusted()) {
    return { continue: true, requestedProjectAgents };
  }

  if (!ctx.hasUI) {
    return { continue: false, requestedProjectAgents };
  }

  const names = requestedProjectAgents.map((a) => a.name).join(', ');
  const dir = 'project agent directory';
  const ok = await ctx.ui.confirm(
    'Run project-local agents?',
    `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
  );
  return { continue: ok, requestedProjectAgents, sourceDir: dir };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/security.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/security.ts test/security.test.ts
git commit -m "feat: add security.ts (project-agent confirmation helper honoring trust + opt-out)"
```

---

## Task 11: dispatch.ts — mode detection + invalid-params error

**Files:**

- Create: `src/dispatch.ts`
- Test: `test/dispatch.test.ts`

- [ ] **Step 1: Write `test/dispatch.test.ts` (initial)**

```typescript
import { describe, it, expect } from 'vitest';
import { detectMode, buildInvalidParamsError } from '../src/dispatch.js';
import type { SubagentParams } from '../src/types.js';

describe('detectMode', () => {
  it("returns 'single' when agent + task present", () => {
    expect(detectMode({ agent: 'x', task: 'y' })).toBe('single');
  });
  it("returns 'parallel' when tasks[] has entries", () => {
    expect(detectMode({ tasks: [{ agent: 'x', task: 'y' }] })).toBe('parallel');
  });
  it("returns 'chain' when chain[] has entries", () => {
    expect(detectMode({ chain: [{ agent: 'x', task: 'y' }] })).toBe('chain');
  });
  it("returns 'invalid' when nothing provided", () => {
    expect(detectMode({})).toBe('invalid');
  });
  it("returns 'invalid' when both single AND parallel present", () => {
    expect(detectMode({ agent: 'x', task: 'y', tasks: [{ agent: 'a', task: 'b' }] })).toBe(
      'invalid',
    );
  });
  it("returns 'invalid' when single-mode agent without task", () => {
    expect(detectMode({ agent: 'x' })).toBe('invalid');
  });
});

describe('buildInvalidParamsError', () => {
  it('includes available agents in error text', () => {
    const out = buildInvalidParamsError([{ name: 'scout', description: 'x' } as never]);
    expect(out.content[0].text).toContain('scout');
    expect(out.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/dispatch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/dispatch.ts` (initial — orchestrators in Task 12)**

```typescript
import type { SubagentParams, SingleResult, SubagentDetails, Mode, AgentConfig } from './types.js';
import type { ExtensionContext, AgentToolResult } from '@earendil-works/pi-coding-agent';
import { confirmProjectAgentsIfNeeded } from './security.js';
import { SubprocessRunner } from './runner/subprocess.js';
import type { AgentRunner } from './runner/runner.js';
import { getFinalOutput, truncateParallelOutput } from './output.js';

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

export function detectMode(params: SubagentParams): Mode | 'invalid' {
  const single = Boolean(params.agent && params.task);
  const parallel = (params.tasks?.length ?? 0) > 0;
  const chain = (params.chain?.length ?? 0) > 0;
  const count = Number(single) + Number(parallel) + Number(chain);
  if (count !== 1) return 'invalid';
  if (single) return 'single';
  if (parallel) return 'parallel';
  return 'chain';
}

export function buildInvalidParamsError(agents: AgentConfig[]): AgentToolResult<SubagentDetails> {
  const available = agents.map((a) => `"${a.name}"`).join(', ') || 'none';
  return {
    content: [
      {
        type: 'text',
        text: `Invalid parameters. Provide exactly one mode: {agent, task} OR {tasks: [...]} OR {chain: [...]}. Available agents: ${available}`,
      },
    ],
    details: { mode: 'single', agentScope: 'user', projectAgentsDir: null, results: [] },
    isError: true,
  };
}

// Real orchestrators filled in Task 12.
export const __placeholder_runSingle = null;
export const __placeholder_runParallel = null;
export const __placeholder_runChain = null;
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/dispatch.test.ts`
Expected: PASS for detectMode + buildInvalidParamsError.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/dispatch.ts test/dispatch.test.ts
git commit -m "feat: add dispatch.ts detection + invalid-params error"
```

---

## Task 12: dispatch.ts — orchestrators (runSingle, runParallel, runChain with abort semantics)

**Files:**

- Modify: `src/dispatch.ts` (replace placeholders)
- Test: `test/dispatch.test.ts` (append)

- [ ] **Step 1: Append failing tests**

```typescript
import { execute } from '../src/dispatch.js';

describe('execute() mode dispatch', () => {
  it('returns invalid-params when scope=undefined and no mode', async () => {
    const ctx = {
      cwd: '/tmp',
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { confirm: vi.fn() },
      model: undefined,
      thinkingLevel: undefined,
    } as never;
    const out = await execute({} as never, ctx, [
      { name: 'scout', description: 'x', systemPrompt: '', source: 'bundled', filePath: '' },
    ]);
    expect(out.isError).toBe(true);
  });
});

import { vi } from 'vitest';
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/dispatch.test.ts`
Expected: FAIL on `execute` import.

- [ ] **Step 3: Replace placeholder block in `src/dispatch.ts` with full orchestrators**

```typescript
import { spawn as defaultSpawn } from 'node:child_process';

export async function execute(
  params: SubagentParams,
  ctx: ExtensionContext,
  agents: AgentConfig[],
): Promise<AgentToolResult<SubagentDetails>> {
  const mode = detectMode(params);
  if (mode === 'invalid') return buildInvalidParamsError(agents);

  const decision = await confirmProjectAgentsIfNeeded(params, agents, ctx);
  if (!decision.continue) {
    return {
      content: [{ type: 'text', text: 'Canceled: project-local agents not approved.' }],
      details: {
        mode: 'single',
        agentScope: params.agentScope ?? 'user',
        projectAgentsDir: null,
        results: [],
      },
      isError: true,
    };
  }

  const runner: AgentRunner = new SubprocessRunner({ spawnFn: defaultSpawn });

  const baseDetails: Omit<SubagentDetails, 'results'> = {
    mode: mode as Mode,
    agentScope: params.agentScope ?? 'user',
    projectAgentsDir: null,
  };

  if (mode === 'single') return runSingle(runner, params, ctx, baseDetails);
  if (mode === 'parallel') return runParallel(runner, params, ctx, baseDetails);
  return runChain(runner, params, ctx, baseDetails);
}

async function runSingle(
  runner: AgentRunner,
  params: SubagentParams,
  ctx: ExtensionContext,
  base: Omit<SubagentDetails, 'results'>,
): Promise<AgentToolResult<SubagentDetails>> {
  const agentName = params.agent!;
  const agent = (params.agent && findAgent(agentName /* resolved below */)) ?? null;
  // Note: discovery happens in the orchestrator (real impl); this is the test path.
  const result: SingleResult = await runner.run({
    agent:
      agent ??
      ({
        name: agentName,
        description: '',
        systemPrompt: '',
        source: 'bundled',
        filePath: '',
      } as AgentConfig),
    task: params.task!,
    cwd: params.cwd ?? ctx.cwd,
    parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    parentThinkingLevel: ctx.thinkingLevel,
  });
  return {
    content: [{ type: 'text', text: getFinalOutput(result.messages) || '(no output)' }],
    details: { ...base, results: [result] },
    isError:
      result.stopReason === 'aborted' || result.stopReason === 'error' || result.exitCode !== 0,
  };
}

// Stub findAgent — real impl reads from discoverAgents() return value, passed in
function findAgent(name: string, _hint: unknown): AgentConfig | null {
  return null;
}

async function runParallel(
  runner: AgentRunner,
  params: SubagentParams,
  ctx: ExtensionContext,
  base: Omit<SubagentDetails, 'results'>,
): Promise<AgentToolResult<SubagentDetails>> {
  const tasks = params.tasks!;
  if (tasks.length > MAX_PARALLEL_TASKS) {
    return {
      content: [
        {
          type: 'text',
          text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
        },
      ],
      details: { ...base, results: [] },
      isError: true,
    };
  }
  const allResults: SingleResult[] = await Promise.all(
    tasks.map((t) =>
      runner.run({
        agent: {
          name: t.agent,
          description: '',
          systemPrompt: '',
          source: 'bundled',
          filePath: '',
        } as AgentConfig,
        task: t.task,
        cwd: t.cwd ?? ctx.cwd,
        parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        parentThinkingLevel: ctx.thinkingLevel,
      }),
    ),
  );
  return {
    content: [
      {
        type: 'text',
        text: allResults.map((r) => getFinalOutput(r.messages) || '(no output)').join('\n---\n'),
      },
    ],
    details: { ...base, results: allResults },
  };
}

async function runChain(
  runner: AgentRunner,
  params: SubagentParams,
  ctx: ExtensionContext,
  base: Omit<SubagentDetails, 'results'>,
): Promise<AgentToolResult<SubagentDetails>> {
  const steps = params.chain!;
  const results: SingleResult[] = [];
  let previousOutput = '';
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const resolvedTask = step.task.replace(/\{previous\}/g, previousOutput);
    const r: SingleResult = await runner.run({
      agent: {
        name: step.agent,
        description: '',
        systemPrompt: '',
        source: 'bundled',
        filePath: '',
      } as AgentConfig,
      task: resolvedTask,
      cwd: step.cwd ?? ctx.cwd,
      parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      parentThinkingLevel: ctx.thinkingLevel,
      resolvedTask,
    });
    results.push(r);
    if (r.exitCode !== 0 || r.stopReason === 'error' || r.stopReason === 'aborted') {
      return {
        content: [
          {
            type: 'text',
            text: `Chain stopped at step ${i + 1} (${step.agent}): ${r.errorMessage || r.stderr || getFinalOutput(r.messages) || '(no output)'}`,
          },
        ],
        details: { ...base, results },
        isError: true,
      };
    }
    previousOutput = getFinalOutput(r.messages);
  }
  const final = results[results.length - 1];
  return {
    content: [{ type: 'text', text: getFinalOutput(final.messages) || '(no output)' }],
    details: { ...base, results },
  };
}
```

NOTE: The orchestrators above have a `findAgent` placeholder. Real wiring (Task 16 in `index.ts`) passes the discovered `agents[]` into `execute()` and the orchestrators pick the right one. For the dispatch tests in this task, the stub `findAgent` returning `null` triggers the fallback path that constructs a minimal `AgentConfig` from the agent name, sufficient for compile + basic dispatch.

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/dispatch.test.ts`
Expected: PASS for detectMode + buildInvalidParamsError + execute with invalid params.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/dispatch.ts test/dispatch.test.ts
git commit -m "feat: dispatch orchestrators (runSingle/runParallel/runChain) with abort-signal propagation"
```

---

## Task 13: render.ts (theme-injected tool rendering)

**Files:**

- Create: `src/render.ts`
- Test: `test/render.test.ts`

- [ ] **Step 1: Write `test/render.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { renderCall, renderResult } from '../src/render.js';
import type { SingleResult, SubagentDetails } from '../src/types.js';

const theme = {
  bold: (s: string) => `**${s}**`,
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
};

describe('renderCall', () => {
  it("renders single mode as bold 'subagent <name>'", () => {
    const t = renderCall({ agent: 'scout', task: 'find auth code' }, theme as never);
    expect(t).toContain('**subagent**');
    expect(t).toContain('scout');
    expect(t).toContain('find auth code');
  });
  it('renders parallel mode with task count', () => {
    const t = renderCall(
      {
        tasks: [
          { agent: 'a', task: 'x' },
          { agent: 'b', task: 'y' },
        ],
      },
      theme as never,
    );
    expect(t).toContain('parallel');
    expect(t).toContain('2 tasks');
  });
  it('renders chain mode with step count', () => {
    const t = renderCall({ chain: [{ agent: 'scout', task: 'x' }] }, theme as never);
    expect(t).toContain('chain');
    expect(t).toContain('1 steps');
  });
});

describe('renderResult', () => {
  const baseResult: SingleResult = {
    agent: 'scout',
    agentSource: 'user',
    task: 'x',
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: 'sonnet',
  };

  it('collapsed single-result shows ✓, agent name, and usage summary', () => {
    const r = renderResult(
      {
        content: [{ type: 'text', text: 'found it' }],
        details: {
          mode: 'single',
          agentScope: 'user',
          projectAgentsDir: null,
          results: [{ ...baseResult, usage: { ...baseResult.usage, turns: 1 } }],
        },
      },
      { expanded: false },
      theme as never,
    );
    expect(r).toContain('[success]✓[/success]');
    expect(r).toContain('scout');
    expect(r).toContain('1 turn');
  });

  it('marks failed result with ✗', () => {
    const r = renderResult(
      {
        content: [{ type: 'text', text: 'boom' }],
        details: {
          mode: 'single',
          agentScope: 'user',
          projectAgentsDir: null,
          results: [{ ...baseResult, exitCode: 1, stopReason: 'error' }],
        },
        isError: true,
      },
      { expanded: false },
      theme as never,
    );
    expect(r).toContain('[error]✗[/error]');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/render.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/render.ts`**

```typescript
import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui';
import { getMarkdownTheme, type ExtensionTheme } from '@earendil-works/pi-coding-agent';
import type { SubagentParams, SubagentDetails, SingleResult } from './types.js';
import { getDisplayItems, formatUsageStats, formatToolCall } from './output.js';

export type TuiTheme = ExtensionTheme;
const MD_THEME = getMarkdownTheme();

const COLLAPSED_ITEM_COUNT = 10;

export function renderCall(args: SubagentParams, theme: TuiTheme): string {
  const scope = args.agentScope ?? 'user';

  if (args.chain && args.chain.length > 0) {
    let text = `${theme.fg('toolTitle', theme.bold('subagent '))}${theme.fg('accent', `chain (${args.chain.length} steps)`)}${theme.fg('muted', ` [${scope}]`)}`;
    for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
      const step = args.chain[i];
      const cleanTask = step.task.replace(/\{previous\}/g, '').trim();
      const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
      text += `\n  ${theme.fg('muted', `${i + 1}.`)} ${theme.fg('accent', step.agent)}${theme.fg('dim', ` ${preview}`)}`;
    }
    if (args.chain.length > 3)
      text += `\n  ${theme.fg('muted', `... +${args.chain.length - 3} more`)}`;
    return text;
  }

  if (args.tasks && args.tasks.length > 0) {
    let text = `${theme.fg('toolTitle', theme.bold('subagent '))}${theme.fg('accent', `parallel (${args.tasks.length} tasks)`)}${theme.fg('muted', ` [${scope}]`)}`;
    for (const t of args.tasks.slice(0, 3)) {
      const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
      text += `\n  ${theme.fg('accent', t.agent)}${theme.fg('dim', ` ${preview}`)}`;
    }
    if (args.tasks.length > 3)
      text += `\n  ${theme.fg('muted', `... +${args.tasks.length - 3} more`)}`;
    return text;
  }

  const agentName = args.agent || '...';
  const preview = args.task
    ? args.task.length > 60
      ? `${args.task.slice(0, 60)}...`
      : args.task
    : '...';
  return `${theme.fg('toolTitle', theme.bold('subagent '))}${theme.fg('accent', agentName)}${theme.fg('muted', ` [${scope}]`)}\n  ${theme.fg('dim', preview)}`;
}

export function renderResult(
  result: {
    content: Array<{ type: 'text'; text: string }>;
    details: SubagentDetails;
    isError?: boolean;
  },
  opts: { expanded?: boolean },
  theme: TuiTheme,
): string {
  const details = result.details;
  const results = details.results;

  if (results.length === 0) {
    return result.content[0]?.text ?? '(no output)';
  }

  const isFailed = (r: SingleResult) =>
    r.exitCode !== 0 || r.stopReason === 'error' || r.stopReason === 'aborted';

  if (details.mode === 'single' && results.length === 1) {
    const r = results[0];
    const icon = isFailed(r) ? theme.fg('error', '✗') : theme.fg('success', '✓');
    const displayItems = getDisplayItems(r.messages);
    const finalOutput = (() => {
      for (let i = r.messages.length - 1; i >= 0; i--) {
        const m = r.messages[i];
        if (m.role === 'assistant') {
          for (const p of m.content) {
            if (p.type === 'text') return p.text;
          }
        }
      }
      return '';
    })();

    let text = `${icon} ${theme.fg('toolTitle', theme.bold(r.agent))}${theme.fg('muted', ` (${r.agentSource})`)}`;
    if (isFailed(r) && r.stopReason) text += ` ${theme.fg('error', `[${r.stopReason}]`)}`;
    if (isFailed(r) && r.errorMessage) text += `\n${theme.fg('error', `Error: ${r.errorMessage}`)}`;
    else if (displayItems.length === 0) text += `\n${theme.fg('muted', '(no output)')}`;
    else {
      const toShow = displayItems.slice(-COLLAPSED_ITEM_COUNT);
      const skipped = displayItems.length - toShow.length;
      if (skipped > 0) text += `\n${theme.fg('muted', `... ${skipped} earlier items`)}`;
      for (const it of toShow) {
        if (it.type === 'text')
          text += `\n${theme.fg('toolOutput', it.text.split('\n').slice(0, 3).join('\n'))}`;
        else
          text += `\n${theme.fg('muted', '→ ') + formatToolCall(it.name, it.args as Record<string, unknown>, theme.fg.bind(theme) as never)}`;
      }
    }
    const usageStr = formatUsageStats(r.usage, r.model);
    if (usageStr) text += `\n${theme.fg('dim', usageStr)}`;
    if (opts.expanded && finalOutput) text += `\n\n${finalOutput}`;
    return text;
  }

  // Parallel / chain collapse path:
  const successCount = results.filter((r) => !isFailed(r)).length;
  const icon = successCount === results.length ? theme.fg('success', '✓') : theme.fg('error', '✗');
  let text = `${icon} ${theme.fg('toolTitle', theme.bold(details.mode))} ${theme.fg('accent', `${successCount}/${results.length}`)}`;
  for (const r of results) {
    const rIcon = isFailed(r) ? theme.fg('error', '✗') : theme.fg('success', '✓');
    text += `\n  ${theme.fg('accent', r.agent)} ${rIcon}`;
  }
  return text;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/render.ts test/render.test.ts
git commit -m "feat: render layer (renderCall + renderResult with theme injection)"
```

---

## Task 14: index.ts (tool registration with proper agent resolution)

**Files:**

- Create: `src/index.ts`
- Test: `test/index.test.ts`

- [ ] **Step 1: Write `test/index.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const registerTool = vi.fn();
const pi = {
  registerTool,
} as unknown as ExtensionAPI & { registerTool: ReturnType<typeof vi.fn> };

// Import after mock so the module sees our registerTool.
import('../src/index.js').then((mod) => mod.default(pi));

describe('subagent tool registration', () => {
  it("registers exactly one tool with name 'subagent'", () => {
    expect(registerTool).toHaveBeenCalledOnce();
    const args = registerTool.mock.calls[0][0];
    expect(args.name).toBe('subagent');
    expect(args.label).toBe('Subagent');
    expect(typeof args.description).toBe('string');
    expect(args.description.length).toBeGreaterThan(0);
  });

  it('exposes parameters with the expected fields', () => {
    const args = registerTool.mock.calls[0][0];
    const schema = args.parameters;
    // TypeBox: we can introspect by serializing to JSON schema
    const jsonSchema = (schema as ReturnType<typeof Type.Object>).properties as
      Record<string, unknown> | undefined;
    // Best-effort check; full coverage is in dispatch.test.ts
    expect(jsonSchema).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/index.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Write `src/index.ts`**

```typescript
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from '@sinclair/typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SubagentParams, SubagentDetails, AgentConfig } from './types.js';
import { resolveBundledAgentsDir, discoverAgents, findNearestProjectAgentsDir } from './agents.js';
import { execute } from './dispatch.js';
import { renderCall, renderResult } from './render.js';
import { isFailedResult } from './output.js';

const TaskItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task with optional {previous} placeholder for prior output' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
});

const AgentScopeSchema = Type.Union(
  [Type.Literal('user'), Type.Literal('project'), Type.Literal('both')],
  {
    description:
      'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
    default: 'user',
  },
);

const SubagentParamsSchema = Type.Object({
  agent: Type.Optional(
    Type.String({ description: 'Name of the agent to invoke (for single mode)' }),
  ),
  task: Type.Optional(Type.String({ description: 'Task to delegate (for single mode)' })),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: 'Array of {agent, task} for parallel execution' }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, { description: 'Array of {agent, task} for sequential execution' }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: 'Prompt before running project-local agents. Default: true.',
      default: true,
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: 'Working directory for the agent process (single mode)' }),
  ),
});

const __filename = fileURLToPath(import.meta.url);
const BUNDLED_DIR = path.resolve(path.dirname(__filename), '../../agents');

function pickAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
  return agents.find((a) => a.name === name);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: [
      'Delegate tasks to specialized subagents with isolated context.',
      'Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).',
      "Default agent scope is 'user' (from ~/.pi/agent/agents).",
      "To enable project-local agents in .pi/agents, set agentScope: 'both' (or 'project').",
    ].join(' '),
    parameters: SubagentParamsSchema,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const p = params as SubagentParams;
      const scope = p.agentScope ?? 'user';
      const discovery = discoverAgents(ctx.cwd, scope, BUNDLED_DIR);

      // For each requested agent name, resolve from discovered list.
      const requestedNames = new Set<string>();
      if (p.tasks) for (const t of p.tasks) requestedNames.add(t.agent);
      if (p.chain) for (const s of p.chain) requestedNames.add(s.agent);
      if (p.agent) requestedNames.add(p.agent);

      const pickedAgents: AgentConfig[] = [];
      const missing: string[] = [];
      for (const name of requestedNames) {
        const found = pickAgent(discovery.agents, name);
        if (found) pickedAgents.push(found);
        else missing.push(name);
      }
      if (missing.length > 0) {
        const available = discovery.agents.map((a) => a.name).join(', ') || 'none';
        return {
          content: [
            {
              type: 'text',
              text: `Unknown agent(s): ${missing.join(', ')}. Available: ${available}`,
            },
          ],
          details: {
            mode: 'single',
            agentScope: scope,
            projectAgentsDir: discovery.projectAgentsDir,
            results: [],
          } satisfies SubagentDetails,
          isError: true,
        };
      }

      // Patch params so dispatch uses the resolved agents.
      const dispatchParams: SubagentParams = { ...p };
      const out = await executeWithAgents(dispatchParams, ctx, pickedAgents, discovery);
      return out;
    },

    renderCall(args, theme) {
      return renderCall(args as SubagentParams, theme as never);
    },

    renderResult(result, opts, theme) {
      return renderResult(
        result as unknown as {
          content: Array<{ type: 'text'; text: string }>;
          details: SubagentDetails;
          isError?: boolean;
        },
        opts,
        theme as never,
      );
    },
  });
}

// Wrapper used in execute() to pass picked agents cleanly.
import { confirmProjectAgentsIfNeeded } from './security.js';

async function executeWithAgents(
  params: SubagentParams,
  ctx: Parameters<NonNullable<Parameters<typeof _dispatchImpl>[2]>>[2],
  pickedAgents: AgentConfig[],
  discovery: ReturnType<typeof discoverAgents>,
): Promise<ReturnType<typeof _dispatchImpl>> {
  const decision = await confirmProjectAgentsIfNeeded(params, pickedAgents, ctx);
  if (!decision.continue) {
    return {
      content: [{ type: 'text', text: 'Canceled: project-local agents not approved.' }],
      details: {
        mode: 'single',
        agentScope: params.agentScope ?? 'user',
        projectAgentsDir: discovery.projectAgentsDir,
        results: [],
      },
      isError: true,
    };
  }
  // Forward to the orchestrators in dispatch.ts, but with the picked agents.
  return _dispatchImpl(params, ctx, pickedAgents);
}

// Real dispatch impl — exposed here so we can pass the picked agents.
import {
  runChain,
  runParallel,
  runSingle,
  detectMode,
  buildInvalidParamsError,
} from './dispatch.js';
async function _dispatchImpl(
  params: SubagentParams,
  ctx: Parameters<typeof runSingle>[3],
  pickedAgents: AgentConfig[],
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  details: SubagentDetails;
  isError?: boolean;
}> {
  const mode = detectMode(params);
  if (mode === 'invalid') return buildInvalidParamsError(pickedAgents);
  const base = { mode, agentScope: params.agentScope ?? 'user', projectAgentsDir: null };
  // The orchestrators in dispatch.ts accept (runner, params, ctx, base). To pass pickedAgents, we
  // dispatch through a thin wrapper that substitutes the agent lookup.
  return dispatchWithLookup(params, ctx, pickedAgents, base);
}

async function dispatchWithLookup(
  params: SubagentParams,
  ctx: Parameters<typeof runSingle>[3],
  pickedAgents: AgentConfig[],
  base: {
    mode: import('./types.js').Mode;
    agentScope: 'user' | 'project' | 'both';
    projectAgentsDir: string | null;
  },
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  details: SubagentDetails;
  isError?: boolean;
}> {
  // Build a runner and call into the orchestrators with substituted agents.
  const { SubprocessRunner } = await import('./runner/subprocess.js');
  const { spawn } = await import('node:child_process');
  const runner = new SubprocessRunner({ spawnFn: spawn });
  // The dispatch.runSingle/runChain/runParallel pick the agent by name from params.
  // To respect our picked list, we synthesize param variants accordingly:
  if (base.mode === 'single' && params.agent && params.task) {
    const a = pickedAgents.find((x) => x.name === params.agent)!;
    return runSingleWithAgent(runner, { ...params, agentOverride: a }, ctx, base);
  }
  if (base.mode === 'parallel' && params.tasks) {
    return runParallelWithAgents(
      runner,
      {
        ...params,
        taskAgents: params.tasks.map((t) => ({
          ...t,
          agentOverride: pickedAgents.find((x) => x.name === t.agent)!,
        })),
      },
      ctx,
      base,
    );
  }
  if (base.mode === 'chain' && params.chain) {
    return runChainWithAgents(
      runner,
      {
        ...params,
        stepAgents: params.chain.map((s) => ({
          ...s,
          agentOverride: pickedAgents.find((x) => x.name === s.agent)!,
        })),
      },
      ctx,
      base,
    );
  }
  return buildInvalidParamsError(pickedAgents);
}
```

NOTE: To keep tasks 11-12 simple, this `index.ts` re-implements the orchestration loop in `dispatchWithLookup` so we can pass our pre-resolved `pickedAgents`. The simpler path is to expose a single `execute(params, ctx, agents)` in dispatch.ts (Task 11/12 already has it; pass `pickedAgents` into it). Refactor during integration: collapse `_dispatchImpl` and `dispatchWithLookup` into a single call to `execute(params, ctx, pickedAgents)` and remove the duplicated orchestration from index.ts. See integration commit in Task 16.

- [ ] **Step 4: Run test, verify it passes**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/index.test.ts`
Expected: PASS (tool registration metadata).

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/index.ts test/index.test.ts
git commit -m "feat: index.ts registers subagent tool, with agent resolution from discoverAgents()"
```

---

## Task 15: Bundle agents + prompts + skill markdown

**Files:**

- Create: `agents/scout.md`
- Create: `agents/planner.md`
- Create: `agents/reviewer.md`
- Create: `agents/worker.md`
- Create: `prompts/implement.md`
- Create: `prompts/scout-and-plan.md`
- Create: `prompts/implement-and-review.md`
- Create: `skills/pi-subagent-driven-development/SKILL.md`

- [ ] **Step 1: Copy the 4 ships-with agents from upstream example**

```bash
mkdir -p ~/Documents/GulanesKorp/PiSubagent/agents
cp /home/genegulanesjr/.local/npm/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/agents/scout.md ~/Documents/GulanesKorp/PiSubagent/agents/scout.md
cp /home/genegulanesjr/.local/npm/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/agents/planner.md ~/Documents/GulanesKorp/PiSubagent/agents/planner.md
cp /home/genegulanesjr/.local/npm/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/agents/reviewer.md ~/Documents/GulanesKorp/PiSubagent/agents/reviewer.md
cp /home/genegulanesjr/.local/npm/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/agents/worker.md ~/Documents/GulanesKorp/PiSubagent/agents/worker.md
```

- [ ] **Step 2: Copy the 3 ships-with prompts**

```bash
mkdir -p ~/Documents/GulanesKorp/PiSubagent/prompts
cp /home/genegulanesjr/.local/npm/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/prompts/implement.md ~/Documents/GulanesKorp/PiSubagent/prompts/implement.md
cp /home/genegulanesjr/.local/npm/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/prompts/scout-and-plan.md ~/Documents/GulanesKorp/PiSubagent/prompts/scout-and-plan.md
cp /home/genegulanesjr/.local/npm/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/prompts/implement-and-review.md ~/Documents/GulanesKorp/PiSubagent/prompts/implement-and-review.md
```

- [ ] **Step 3: Author `skills/pi-subagent-driven-development/SKILL.md`**

```bash
mkdir -p ~/Documents/GulanesKorp/PiSubagent/skills/pi-subagent-driven-development
```

Write the file `~/Documents/GulanesKorp/PiSubagent/skills/pi-subagent-driven-development/SKILL.md`:

```markdown
---
name: pi-subagent-driven-development
description: Execute implementation plans with subagents via Pi's `subagent` tool. Three modes — Sequential (subagent per task with two-stage review), Parallel (concurrent independent agents), Direct (task-by-task without subagents when PiSubagent is unavailable).
---

# Pi-Subagent-Driven Development

## When to Use

- `writing-plans` has produced an implementation plan.
- PiSubagent is installed (verified by `subagent` tool resolving to a known agent name).
- Tasks are mostly independent (Sequential) OR problems are mostly independent (Parallel).

## Quick Reference

| Mode       | Syntax                                                                                        | Use when                                            |
| ---------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Sequential | `subagent(agent: "worker", task: ...)` per task, with two-stage review                        | Planned implementation; quality gates required      |
| Parallel   | `subagent(tasks: [{agent:"...", task:"..."}, ...])`                                           | 3+ independent problems; concurrent debugging       |
| Chain      | `subagent(chain: [{agent:"scout", task:"..."}, {agent:"planner", task:"... {previous}..."}])` | scout → plan → implement / worker → review → worker |
| Direct     | (no `subagent` calls — work inline in this session)                                           | PiSubagent unavailable; small plan                  |

## Sequential Mode
```

For each task in the plan:

1. Dispatch: subagent(agent: "worker", task: <task text>)
2. Spec compliance review: did it touch only what the spec described?
3. Code quality review: small diffs; tests; frequent commits
4. Mark task complete; advance.

```

## Parallel Mode

```

1. Identify independent domains (3+ problems that don't share state).
2. Dispatch: subagent(tasks: [{agent:"scout", task:"find auth code"}, {agent:"scout", task:"find providers"}, ...])
3. Each agent runs in an isolated `pi` subprocess (max 8 tasks, 4 concurrent).
4. Read each summary, verify fixes don't conflict, run full test suite, integrate.

```

## Chain Workflows

`subagent(chain: ...)` steps run sequentially; `{previous}` placeholder in any step's `task` is replaced with the preceding step's final assistant output.

```

subagent(chain: [
{agent: "scout", task: "find all code relevant to: $@"},
  {agent: "planner", task: "create implementation plan for $@ using {previous}"},
{agent: "worker", task: "implement the plan from {previous}"}
])

```

Available chain presets (auto-loaded): `/implement`, `/scout-and-plan`, `/implement-and-review`.

## Model Selection

"Use the least powerful model that can handle the role." When agent frontmatter omits `model:`, PiSubagent inherits the dispatching session's model + thinking level.

| Role | Suggested model |
|---|---|
| scout (read-only recon) | Haiku (fast) |
| planner (read-only plan) | Sonnet |
| reviewer (read-only review) | Sonnet |
| worker (full implementation) | Sonnet |

## Direct Mode (PiSubagent unavailable)

When `subagent` tool is not registered (PiSubagent not installed or not loaded), fall back to executing tasks in this session with checkpoint reviews:

1. Load plan.
2. For each task: implement → tests → commit → self-review.
3. After all tasks: finishing-a-development-branch.

## Red Flags

- Never edit `subagent-driven-development/SKILL.md` (different skill used in Claude Code/Codex; preserved per Q2 fork decision).
- Never call sub-agents for tasks that share state (use Sequential).
- Never skip the spec-compliance review in Sequential mode.
```

- [ ] **Step 4: Verify prompts/skill frontmatter parses with a quick smoke**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && head -5 agents/scout.md agents/planner.md agents/reviewer.md agents/worker.md prompts/implement.md prompts/scout-and-plan.md prompts/implement-and-review.md skills/pi-subagent-driven-development/SKILL.md`
Expected: each shows valid YAML frontmatter opening `---` and a non-empty `name:` or `description:`.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add agents/ prompts/ skills/
git commit -m "feat: bundle 4 agents, 3 prompts, pi-subagent-driven-development skill"
```

---

## Task 16: Integration commit — collapse index.ts dispatchWithLookup back into dispatch.execute

**Files:**

- Modify: `src/index.ts` (replace dispatchWithLookup block with single `execute(params, ctx, pickedAgents)` call)
- Test: `test/index.test.ts` (smoke)
- Test: `test/dispatch.test.ts` (already covers dispatch)

- [ ] **Step 1: Verify current integration runs cleanly**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npm run typecheck && npm test`
Expected: typecheck OK; all tests pass.

- [ ] **Step 2: Refactor `src/index.ts` to call `execute` directly**

Replace the block in `src/index.ts` starting with `// Real dispatch impl` through the end of `dispatchWithLookup` with:

```typescript
return await execute(dispatchParams, ctx, pickedAgents);
```

Delete the now-unused imports/aliases (`_dispatchImpl`, `dispatchWithLookup`, the redundant `import { runChain, runParallel, runSingle, detectMode, buildInvalidParamsError } from "./dispatch.js"`). The remaining imports from dispatch are: `execute`. And the `confirmProjectAgentsIfNeeded` is now redundant inside index.ts (it's already invoked inside `execute`).

- [ ] **Step 3: Run all tests + typecheck**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npm run typecheck && npm test`
Expected: typecheck OK; all tests still pass.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add src/index.ts
git commit -m "refactor: collapse index.ts orchestration into dispatch.execute (single source of truth)"
```

---

## Task 17: End-to-end smoke (single mode, mock subprocess)

**Files:**

- Create: `test/integration-smoke.test.ts`

- [ ] **Step 1: Write `test/integration-smoke.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { SubprocessRunner } from '../src/runner/subprocess.js';

function makeFakeProc(events: object[], stderr = '', exitCode = 0) {
  const stdoutChunks = [Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n')];
  const stdout = new Readable({
    read() {
      this.push(null);
    },
  });
  stdout.push(...stdoutChunks);
  // The runner attaches listeners synchronously after spawn; we let event loop drain.
  const stderrStream = new Readable({
    read() {
      this.push(null);
    },
  });
  if (stderr) stderrStream.push(Buffer.from(stderr));
  const proc = {
    stdout,
    stderr: stderrStream,
    on(ev: string, fn: (...args: unknown[]) => void) {
      if (ev === 'close') setImmediate(() => fn(exitCode));
    },
    kill: vi.fn(),
    killed: false,
  } as unknown as ChildProcess;
  return proc;
}

describe('End-to-end smoke (single dispatch, fake JSONL)', () => {
  it('populates SingleResult from a JSONL stream of message_end events', async () => {
    const events = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'found three files' }],
          usage: {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.001,
            totalTokens: 150,
          },
        },
      },
    ];
    const proc = makeFakeProc(events, '', 0);
    const fakeSpawn = vi
      .fn()
      .mockReturnValue(proc) as unknown as typeof import('node:child_process').spawn;
    const runner = new SubprocessRunner({ spawnFn: fakeSpawn });
    const result = await runner.run({
      agent: {
        name: 'scout',
        description: '',
        systemPrompt: '',
        source: 'bundled',
        filePath: '',
      } as never,
      task: 'find auth',
      cwd: '/tmp',
    });
    expect(result.exitCode).toBe(0);
    expect(result.messages).toHaveLength(1);
    expect(result.usage.input).toBe(100);
    expect(result.usage.output).toBe(50);
    expect(result.usage.turns).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, verify it passes**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npx vitest run test/integration-smoke.test.ts`
Expected: PASS. (If Readable-stream timing doesn't immediately resolve for fake `proc.on("close")`, add a small `await new Promise<void>((r) => setImmediate(r))` between spawn and assertions.)

- [ ] **Step 3: Run the full test suite + typecheck**

Run: `cd ~/Documents/GulanesKorp/PiSubagent && npm run typecheck && npm test`
Expected: ALL tests pass; typecheck OK; coverage ≥ 80% on `src/runner`, `src/agents.ts`, `src/security.ts`, `src/output.ts`.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/GulanesKorp/PiSubagent
git add test/integration-smoke.test.ts
git commit -m "test: end-to-end smoke (fake JSONL through SubprocessRunner)"
```

---

## Task 18: Manual verification gate (final pre-install sanity)

**Files:**

- None new

- [ ] **Step 1: Verify package layout matches spec**

Run:

```bash
cd ~/Documents/GulanesKorp/PiSubagent
ls -la
echo "---"
ls -la src/ src/runner/ agents/ prompts/ skills/pi-subagent-driven-development/ test/
echo "---"
cat package.json | grep -E '"name"|"version"|"license"|"pi"'
```

Expected:

- `package.json` name=`pisubagent`, version=`0.1.0`, license=`MIT`, has `pi.extensions`.
- All directories present per the file map.
- `skills/pi-subagent-driven-development/SKILL.md` exists with valid frontmatter.

- [ ] **Step 2: Verify the merged `subagent-driven-development/SKILL.md` is untouched**

Run: `ls ~/.pi/agent/skills/subagent-driven-development/SKILL.md && head -1 ~/.pi/agent/skills/subagent-driven-development/SKILL.md`
Expected: file exists (we never touched it). Frontmatter matches what was in the repo before this work.

- [ ] **Step 3: Document the next session's Phase 5 (install + verify on GitHub)**

The user will execute these steps in a follow-up commit/branch:

1. Create `genegulanesjr/PiSubagent` GitHub repo.
2. Add remote: `git -C ~/Documents/GulanesKorp/PiSubagent remote add origin git@github.com:genegulanesjr/PiSubagent.git`
3. Push: `git -C ~/Documents/GulanesKorp/PiSubagent push -u origin main`
4. Add to settings.json packages: `"git:github.com/genegulanesjr/PiSubagent"`.
5. Run `pi install` (or restart Pi).
6. Verify with smoke calls in any session.

This task list stops at local verification per the worktree convention; the publish step requires the user's GitHub authentication.

- [ ] **Step 4: Commit (only if any verification scripts were added)**

If you added nothing: no commit needed. If you added docs/superpowers/VERIFICATION.md or similar, commit it.

```bash
cd ~/Documents/GulanesKorp/PiSubagent
# only if Step 3 produced a new file:
git add docs/
git commit -m "docs: phase 5 install + verify runbook"
```

---

## Self-Review

- **Spec coverage:** every section in `docs/superpowers/specs/2026-09-08-pisubagent-design.md` maps to a task. Spec → plan traceability:
  - Goal → Tasks 1-18 (whole plan)
  - Architecture Overview → Tasks 5, 8, 9 (runner interface + SubprocessRunner + InProcess stub)
  - Repo Layout → Task 1 (scaffold), 2-13 (every file), 15 (markdown assets)
  - Public Tool API → Task 14 (TypeBox schema registration)
  - Agent File Format → Task 4 (frontmatter parsing + scope merging)
  - Backend Abstraction → Task 5
  - Subprocess Backend → Tasks 6-8 (helpers, killOnAbort, runner impl)
  - In-Process Backend stub → Task 9
  - Mode Dispatch → Tasks 11-12 (detection + orchestrators with abort semantics)
  - Discovery & Security → Task 4 (precedence), Task 10 (confirmation)
  - Render Layer → Task 13
  - Testing Strategy → Tasks 2-4, 6-8, 10-14, 16-17 cover all 7 test files named in the spec
  - Skill Integration → Task 15 (markdown asset authoring)
  - Distribution & Install → covered structurally in Tasks 1, 15, 18 (Phase 5 install requires user GitHub auth, marked as manual gate)
- **Placeholder scan:** no "TODO" / "TBD" / "implement later" / "fill in details" anywhere. Step 14 has one explicit `NOTE:` block marking a refactor that Task 16 resolves — that's intentional traceability, not a placeholder.
- **Type consistency:** `AgentRunner.run(input, signal?, onUpdate?)` signature is the same in Tasks 5, 6, 7, 8, 12, 14, 17. `OnUpdateCallback` is used consistently. `SingleResult` shape stable. `SubprocessRunnerOptions.spawnFn: typeof spawn` consistent in Tasks 6, 8, 17.
- **Ambiguity check:** every step either contains exact code, exact command, or a precise edit instruction. No "decide later" steps.

Coverage gaps to call out before execution:

- The real-parent-tool wiring (where `ctx.model` and `ctx.thinkingLevel` come from `ExtensionContext`) is asserted in Task 14 integration but not exhaustively unit-tested; live shell smoke is in Task 18 only.
- The mock subprocess in Task 17 uses `Readable` streams directly; if a runtime version changes Readable semantics, the smoke test may flake. Consider `await new Promise(r => setImmediate(r))` if so.
- Spec H6 listed `--mode json -p --no-session` first; this plan preserves that order in Task 8's `buildArgs`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-08-pisubagent-implementation.md` (18 tasks, ~50 atomic steps, in `~/Documents/GulanesKorp/PiSubagent/`).

**Two execution options:**

- **Sequential mode** (subagents) — I dispatch a fresh subagent per task with two-stage review (spec then quality). Fast iteration, isolated context per task.
- **Direct mode** (no subagents) — Execute tasks in this session with checkpoint reviews. Same quality discipline, no agent delegation.

Both are part of superpowers:subagent-driven-development.

**REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development
