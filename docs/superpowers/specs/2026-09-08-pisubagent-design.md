# PiSubagent Design Spec

**Status:** Draft — pending user review
**Date:** 2026-09-08
**Author:** Pi (superpowers:brainstorming)
**Skill chain:** triggered by absence of functional sub-agent dispatch in `subagent-driven-development/SKILL.md`

## Decisions Recorded (from brainstorming)

| Q | Decision | Reasoning |
|---|---|---|
| Q1 — Architecture | **Subprocess backend for v1**, swappable via `AgentRunner` interface | Lowest time-to-working; preserves upstream-proven path; in-process backend is a v2 swap inside one interface, not a rewrite. |
| Q2 — Skill integration | **Replace `subagent-driven-development/SKILL.md` in place**; keep skill name | `writing-plans` hardcodes the skill name; merged skill already supported "Direct mode" fallback for no-subagent environments; v1 assumes Pi is primary harness. |
| Repo location | **`~/Documents/GulanesKorp/PiSubagent/`** | Matches user's house style (PiArgus, PiNyx, PiStats, PiGen, PiSkills, PiMemoryExtension all under `GulanesKorp/`). |
| Distribution | **npm pi-package + GitHub + `git:` install in `settings.json`**, NOT local copy | Memory #1328 explicitly switched the user's `memory-layer` from local to git-package; memory #592 explicitly deleted a local duplicate after promoting PiArgus. |
| Upstream handling | **Fork, do not symlink** upstream example | Risk of upstream drift; ensures v1 hardening deltas stick; aligns with "PiArgus is canonical (replace-in-place of old local browser/)" pattern from memory #592. |
| Cross-harness cost (Q2 trade-off) | If Claude Code/Codex actively consumes the merged skill today, **forking becomes Q2-correct** instead. Open question for spec review (below). | |
| v2 In-Process backend | Interface-only stub in v1; revisit after Aurex SDK-pattern verification | Cannot lean on unverified memory; `AgentRunner` swap is the refactor boundary. |

## Open Questions for Spec Reviewer

Flagged for the user before spec approval:

1. **Q2 cross-harness check**: Do you actively run `~/.pi/agent/skills/subagent-driven-development/SKILL.md` inside Claude Code or Codex today? If yes, in-place replacement breaks that path. If no, replacement is the cleaner default.
2. **Skill rewrite timing**: The current 5-phase plan rewrites the skill at Phase 4 (after PiSubagent is built and verified). Alternative: rewrite first so the skill's updated guidance matches the new tool surface as soon as you start using PiSubagent. Default keeps the verification gate earlier.
3. **Default agent roster**: The four sample agents (scout / planner / reviewer / worker) are inherited from the upstream example. Are there domain-specific defaults you'd want instead — e.g., a `repo-reviewer` for this GulanesKorp codebase, or a `design-implementer` aware of your DESIGN.md conventions?
4. **License**: PiArgus's LICENSE was not inspected — default to MIT unless there's a reason for Apache-2.0 (matches PiNyx style) or to match PiArgus's license exactly.
5. **`pi install` caveat**: If `git:github.com/genegulanesjr/PiSubagent` does not auto-install the markdown assets (agents/, prompts/) into `~/.pi/agent/agents/` and `~/.pi/agent/prompts/`, the migration plan needs a manual symlink step (per the upstream example's README). I haven't verified Pi's package installer asset behavior yet. Phase 5 should confirm and add a fallback step if needed.

## Goal

Provide a working `subagent` LLM-callable tool inside the user's Pi coding agent, so the merged `subagent-driven-development` skill's Sequential and Parallel modes actually have a backend to dispatch to. v1 delivers an isolated subprocess backend that mirrors the upstream Pi example. v2 (deferred) swaps the backend to the Pi SDK in-process once the Aurex precedent is verified.

## Non-Goals (v1)

- In-process backend implementation (interface is designed; v2 only)
- Project-level agent trust flows beyond a single confirmation prompt
- A UI/editor for writing agents and prompts (markdown files only)
- Multi-tenant agent storage
- Cross-process tracing beyond per-call token accounting
- Replacing the upstream Pi example wholesale — this is a fork, not a rewrite

## Architecture Overview

A single Pi extension, packaged as a `pi-package` (npm), installed via `pi install git:github.com/genegulanesjr/PiSubagent`. The extension registers one tool, `subagent`, with three modes (single, parallel, chain). The tool delegates execution to a swappable `AgentRunner` interface. v1 ships one runner — `SubprocessRunner` — that spawns a fresh `pi` process per agent via CLI. v2 will add `InProcessRunner` that uses `createAgentSession()` from the SDK, sharing the parent's runtime.

```
┌─────────────────────────────────┐
│ Parent Pi session               │
│  ┌───────────────────────────┐  │
│  │ subagent tool             │  │
│  │  - validate params        │  │
│  │  - resolve agents[]       │  │
│  │  - dispatch to runner     │  │
│  │  - stream events via      │  │
│  │    onUpdate               │  │
│  │  - render Call/Result     │  │
│  └────────────┬──────────────┘  │
│               │                 │
│  ┌────────────▼──────────────┐  │
│  │ AgentRunner (interface)   │  │
│  └────────────┬──────────────┘  │
│        ┌──────┴──────┐          │
│        ▼             ▼          │
│  ┌──────────┐  ┌──────────────┐ │
│  │Subprocess│  │ InProcess    │ │
│  │ Runner   │  │ Runner (v2)  │ │
│  │ (v1)     │  │              │ │
│  └────┬─────┘  └──────┬───────┘ │
│       │               │         │
└───────┼───────────────┼─────────┘
        ▼               ▼
   spawn("pi" …)    createAgentSession(…)
   CLI flags        in-process SDK
```

Per-agent isolation is the agent-runtime boundary, not the language boundary. v1's subprocess gives hard isolation; v2's in-process gives soft isolation via context reset.

## Repo Layout

```
PiSubagent/
├── package.json                 # name: pisubagent, pi-package, peer pi-coding-agent
├── tsconfig.json                # mirrors PiArgus
├── vitest.config.ts
├── Dockerfile                  # parity with PiArgus; for sandboxed repro
├── README.md
├── LICENSE
├── .gitignore
├── .dockerignore
├── src/
│   ├── index.ts                # ExtensionAPI entry; registers subagent tool
│   ├── agents.ts               # AgentConfig + discoverAgents() (frontmatter parser)
│   ├── runner/
│   │   ├── runner.ts           # AgentRunner interface + types
│   │   ├── subprocess.ts       # SubprocessRunner (v1)
│   │   └── in-process.ts       # InProcessRunner stub (v2 — throws NotImplemented)
│   ├── dispatch.ts             # modeCount validator, chain/parallel/single orchestration
│   ├── render.ts               # renderCall + renderResult for TUI
│   ├── security.ts             # agentScope + project-agent confirmation flow
│   ├── output.ts               # truncation, usage formatting, display-item extraction
│   └── types.ts                # SubagentParams, SubagentDetails, SingleResult, etc

(Prompt templates under `prompts/` are loaded by Pi's own prompt-template system from `~/.pi/agent/prompts/` post-install — no `src/prompts.ts` needed in the extension bundle.)
├── agents/                     # Ships-with sample agents (markdown)
│   ├── scout.md                # Haiku, read-only recon
│   ├── planner.md              # Sonnet, read-only plan
│   ├── reviewer.md             # Sonnet, read-only review
│   └── worker.md               # Sonnet, full tool set
├── prompts/                    # Ships-with workflow prompts
│   ├── implement.md
│   ├── scout-and-plan.md
│   └── implement-and-review.md
├── tests/
│   ├── agents.test.ts          # frontmatter parsing, scope merging
│   ├── dispatch.test.ts        # modeCount validation, chain flow
│   ├── runner-subprocess.test.ts  # spawn argv, JSON event parsing, abort signal
│   ├── security.test.ts        # agentScope + project-agent confirmation
│   ├── output.test.ts          # truncation caps, usage formatting
│   └── fixtures/
│       ├── minimal-agent.md
│       └── minimal-extension-stub.ts
├── docs/
│   ├── superpowers/
│   │   ├── specs/              # this file
│   │   └── plans/              # implementation plan (writing-plans output)
│   ├── AGENT.md                # per-PiNyx pattern: per-extension agent instructions
│   └── architecture.png        # render of the arch diagram above (placeholder OK in v1)
```

**File responsibilities (each owns one concern):**
- `index.ts`: tool registration only; routes to dispatch
- `dispatch.ts`: orchestration only (no spawning, no parsing, no rendering)
- `agents.ts`: agent file parsing only (no I/O beyond discovery)
- `runner/subprocess.ts`: all subprocess knowledge (CLI flags, JSON events, abort signal)
- `runner/in-process.ts`: v2 placeholder; throws `Error("v2: see docs/superpowers/specs/2026-09-08-pisubagent-design.md §In-Process Backend")`
- `render.ts`: pure functions over results; no I/O
- `security.ts`: agentScope policy + project-agent confirmation prompts; pure-where-possible
- `output.ts`: truncation, formatting, display items; pure functions
- `types.ts`: shared types only; no behavior
- prompt templates (in `prompts/*.md`): loaded by Pi's prompt-template system, NOT by the extension

## Public Tool API

The `subagent` tool registered in `index.ts`:

**Tool name**: `subagent`
**Label**: `Subagent`
**Description** (joined string in registration):
> "Delegate tasks to specialized subagents with isolated context. Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder). Default agent scope is 'user' (from ~/.pi/agent/agents). To enable project-local agents in .pi/agents, set agentScope: 'both' (or 'project')."

**Parameters** (TypeBox):

```typescript
{
  // Single mode
  agent?: string,
  task?: string,
  // Parallel mode
  tasks?: Array<{ agent: string; task: string; cwd?: string }>,
  // Chain mode
  chain?: Array<{ agent: string; task: string; cwd?: string }>,
  // Policy
  agentScope?: "user" | "project" | "both",  // default "user"
  confirmProjectAgents?: boolean,             // default true
  cwd?: string,                               // default ctx.cwd; single-mode cwd override
}
```

**Validation**: exactly one of `(agent & task)`, `tasks[]`, or `chain[]` must be present. `modeCount` MUST be 1; else return error listing available agents.

**Output**: `{ content: [{type:"text", text:string}], details: SubagentDetails, isError?: boolean }`. `content` is the human-readable model output; `details` carries full results for `renderResult` and any future inspection tools.

## Agent File Format (`agents/*.md`)

YAML frontmatter + body (body = system prompt):

```markdown
---
name: my-agent            # required, unique within scope
description: Free-text used by parent LLM to pick this agent.
tools: read, bash         # optional: comma-separated string OR yaml list
model: claude-sonnet-4-5  # optional: omit to inherit dispatching model's model + thinkingLevel
---

System prompt goes here. Multi-line. Body is appended verbatim to pi's
system prompt at agent boot.
```

**Locations:**
- `~/.pi/agent/agents/*.md` — user-level (always loaded when `agentScope: "user"` or `"both"`)
- `.pi/agents/*.md` — project-level (loaded only when `agentScope: "project"` or `"both"`)

**Conflict resolution:** with `agentScope: "both"`, project agents override user agents of the same name (mirrors upstream example).

**Discovery implementation:** `agents.ts` exposes `discoverAgents(cwd, scope): { agents: AgentConfig[], projectAgentsDir: string | null }`. Project dir is found by walking parent directories (mirror upstream `findNearestProjectAgentsDir`).

## Prompt File Format (`prompts/*.md`)

Markdown body. Single description frontmatter:

```markdown
---
description: Full implementation workflow — scout gathers context, planner creates plan, worker implements
---

Body — natural-language instructions for the parent LLM to invoke the
subagent tool with specific parameters and modes.
```

`{previous}` placeholder is substituted with the prior chain step's final output text.

**Locations**: `~/.pi/agent/prompts/*.md` (user-level). Project prompts are NOT supported in v1 (deferred; see Open Questions).

## Backend Abstraction (`src/runner/runner.ts`)

```typescript
export interface AgentRunner {
  /** Run a single agent dispatch; resolve with the agent's full event stream summarized into a SingleResult. */
  run(input: AgentRunInput, signal?: AbortSignal, onUpdate?: OnUpdateCallback): Promise<SingleResult>;
  /** Logical runner id, used for diagnostics + future config gating. */
  readonly id: "subprocess" | "in-process";
}

export interface AgentRunInput {
  agent: AgentConfig;
  task: string;
  cwd: string;
  /** ctx.model.provider/id from the dispatching session; used as the default model when agent.model is unset. */
  parentModel?: string;
  /** ctx.thinkingLevel from the dispatching session; inherited unless agent.model overrides. */
  parentThinkingLevel?: ThinkingLevel;
}
```

The runner interface is intentionally narrow — it owns agent execution only. Discovery, mode orchestration, rendering, and security are NOT runner concerns. This split is the seam that lets v2 swap implementations without touching the rest of the codebase.

## Subprocess Backend (`src/runner/subprocess.ts`)

Mirrors the upstream `examples/extensions/subagent/index.ts` with these deliberate deltas (each is a v1 hardening pass):

| Concern | Upstream behavior | v1 PiSubagent behavior | Rationale |
|---|---|---|---|
| CLI invocation | Resolved from `process.argv[1]` heuristic | Resolved from a single helper `resolvePiInvocation()` in `runner/subprocess.ts`, exported and unit-tested | Testability |
| Prompt handoff | Temp file written via `withFileMutationQueue` per call | Same; reused across callsites via `runner/subprocess.ts` `writePromptFile(prompt): Promise<{dir, path}>` | Single source of truth |
| Abort | `signal.addEventListener("abort", killProc, { once: true })` with 5s SIGKILL escalation | Same; factor `killOnAbort(proc, signal)` so test coverage can mock | Testability |
| JSON event parsing | Line-buffer stdout, parse each `\n`-delimited line | Same; encapsulated in `parseJsonlEvents(stream): Observable<Event>` | Stream composition |
| Exit codes | Pass-through | Pass-through; runner also emits `stopReason: "aborted"` on signal, `"error"` on non-zero exit | Match v1 error contract |
| Tool call formatting | Inline `formatToolCall` in `index.ts` | Extracted into `output.ts` (shared with `renderResult`) | Single formatting source |

## In-Process Backend (`src/runner/in-process.ts`) — v2 stub

```typescript
export class InProcessRunner implements AgentRunner {
  readonly id = "in-process" as const;

  async run(_input: AgentRunInput, _signal?: AbortSignal, _onUpdate?: OnUpdateCallback): Promise<SingleResult> {
    throw new Error(
      "InProcessRunner is v2; not implemented in PiSubagent v1. See " +
      "~/Documents/GulanesKorp/PiSubagent/docs/superpowers/specs/2026-09-08-pisubagent-design.md §In-Process Backend"
    );
  }
}
```

**v2 spec (when implemented):**
- Use `createAgentSession()` from `@earendil-works/pi-coding-agent` with `tools: agent.tools ?? [/* inherit from parent */]`
- Inject the agent's system prompt via `systemPromptOverride` (or `--append-system-prompt` analog in SDK)
- Subscribe to the same event types as the subprocess backend (`message_update`, `message_end`, `tool_result_end`, `agent_settled`)
- Stream via the same `onUpdate` callback contract
- Maintain the same `SingleResult` shape — `dispatch.ts` and `render.ts` must not need changes

**Open question for v2:** how to share in-process state with the parent (PiStats context bar, design-system tools). Decision pending Aurex precedent verification.

## Mode Dispatch (`src/dispatch.ts`)

The mode orchestrator. Pure of subprocess details.

```typescript
// Pseudocode of the validation+dispatch logic
async function execute(params: SubagentParams, ctx: ExtensionContext): Promise<AgentToolResult> {
  const mode = detectMode(params); // returns "single" | "parallel" | "chain" | "invalid"
  if (mode === "invalid") return invalidParamsError(discoverAgents(ctx.cwd, params.agentScope ?? "user"));

  await security.confirmProjectAgentsIfNeeded(params, agents, ctx); // may short-circuit
  const runner = selectRunner(); // returns SubprocessRunner in v1

  switch (mode) {
    case "single":   return runSingle(runner, params, ctx, signal, onUpdate);
    case "parallel": return runParallel(runner, params, ctx, signal, onUpdate);
    case "chain":    return runChain(runner, params, ctx, signal, onUpdate);
  }
}
```

Limits (mirrors upstream; constants in `dispatch.ts`):
- `MAX_PARALLEL_TASKS = 8`
- `MAX_CONCURRENCY = 4`
- `PER_TASK_OUTPUT_CAP = 50 * 1024` bytes for parent-facing parallel output

Chain semantics: `{previous}` in any chain step's `task` is replaced with the preceding step's final assistant text. Stops at first failing step (matches upstream).

## Discovery & Security (`src/security.ts` + `src/agents.ts`)

- Default `agentScope` is `"user"`.
- With `agentScope: "project" | "both"`, project-level agents are loaded. If `ctx.isProjectTrusted()` returns `false` AND `confirmProjectAgents !== false`, prompt once before any project agent runs. Trusted projects (`ctx.isProjectTrusted() === true`) skip the prompt. Matches the upstream extension's trust flow, which uses Pi's `ExtensionContext.isProjectTrusted()` and `ctx.hasUI` checks.
- Project agents override user agents with the same name when `agentScope: "both"` — same precedence rule as upstream.
- The confirmation prompt lists the requested project agent names and the directory they're loaded from, then asks for explicit yes/no via `ctx.ui.confirm()`. Skipping cancels the call with `isError: true`.

## Render Layer (`src/render.ts`)

Pure functions:
- `renderCall(args, theme): Text` — formatted compact view (single / parallel / chain variants)
- `renderResult(result, opts, theme): Text | Container` — collapsed and expanded views
- All output formatting (token counts, tool call formatting, final-output markdown rendering) lives in `output.ts`

Constants:
- `COLLAPSED_ITEM_COUNT = 10` — items shown in collapsed view

## Skill Integration

Replace the merged `~/.pi/agent/skills/subagent-driven-development/SKILL.md` body in place. Keep the skill name `subagent-driven-development` (preserves `writing-plans`'s hardcoded reference). Update `description:` frontmatter to:

> "Execute implementation plans with subagents via Pi's subagent tool. Three modes: Sequential (subagent per task with two-stage review), Parallel (concurrent independent agents), Direct (task-by-task without subagents when PiSubagent is unavailable)."

Rewrite prompt templates inside the skill:
- Sequential-mode per-task dispatch: `subagent(agent: "worker", task: <task>)` instead of `Task(...)`
- Parallel-mode dispatch: `subagent(tasks: [{agent:"...", task:"..."}, ...])`
- Chain workflow: `subagent(chain: [{agent:"scout", task:"..."}, {agent:"planner", task: "...{previous}..."}])`
- Model selection table: simplify to "least powerful model that can handle" since Pi inherits dispatch defaults when `model:` is omitted in agent frontmatter

Keep the **Direct mode** section verbatim (it's already Pi-friendly — talks to the parent, not agents).

## Distribution & Install

1. Push `PiSubagent` repo to `genegulanesjr/PiSubagent` on GitHub.
2. Register in `~/.pi/agent/settings.json`:
   ```json
   {
     "packages": [
       "git:github.com/genegulanesjr/PiSubagent"
     ]
   }
   ```
3. Run `pi install` (or `/reload` if settings.json was edited in-place).
4. Verify `~/.pi/agent/agents/` now contains symlinks or copies of the four shipped agents; same for `~/.pi/agent/prompts/`.
5. Test single mode: in any session, ask Pi to use the `subagent` tool with `agent: "scout"` and an obvious task. Verify result, exit, and token accounting.

The upstream `examples/extensions/subagent/` is **NOT** symlinked. PiSubagent is a fork with v1 hardening and (later) v2 backend swap.

## Testing Strategy

`vitest run` against:

| Test file | Covers |
|---|---|
| `agents.test.ts` | frontmatter parsing (string and array tools), scope merging, project-dir walking, malformed file resilience |
| `dispatch.test.ts` | modeCount validation (zero modes, multiple modes), chain `{previous}` substitution, chain stop on failure, parallel concurrency limit |
| `runner-subprocess.test.ts` | `resolvePiInvocation()` across `node` / `bun` / generic runtime cases; `killOnAbort()` SIGTERM-then-SIGKILL escalation with fake timers; JSONL parsing of synthetic streams; `SingleResult` population from event sequence |
| `security.test.ts` | `agentScope` switching, project-agent confirmation prompt behavior on trusted vs untrusted projects, `confirmProjectAgents: false` opt-out |
| `output.test.ts` | `formatTokens()` edge cases, `truncateParallelOutput()` byte-boundary correctness, `getDisplayItems()` filtering |

Mocking strategy: `runner/subprocess.ts` must take a `spawn: typeof spawn` injection so tests can replace it with a fake returning canned JSONL output. No live network or live `pi` subprocesses in unit tests.

Coverage gate: 80% line coverage on `runner/`, `agents.ts`, `security.ts`, `output.ts`. Integration smoke (single mode end-to-end) is a manual check, not in CI.

## Open Questions / Deferred

- **v2 In-Process backend** — depends on Aurex SDK-pattern verification. ADR candidate once that pattern is documented.
- **Project-level prompts** — deferred. v1 only loads prompts from `~/.pi/agent/prompts/`.
- **Cross-harness skill portability** — if user actively uses the merged skill in Claude Code/Codex today, the in-place replacement removes that fallback. v1 assumes Pi is primary; revisit if needed.
- **Prompt registry caching** — every dispatch re-reads agents/*.md. Acceptable for v1 (cheap). Cache if profiling shows otherwise.
- **`agentScope: "both"` UX** — currently one confirmation per call. Could become per-session sticky; deferred.

## Migration / Rollout Phases

The five phases below are the BIG moves for the whole project. After the user approves this spec, the `superpowers:writing-plans` skill will run and decompose Phases 2–4 into atomic, bite-sized tasks.

1. **Spec (this document)** — pending user review and approval.
2. **Scaffold** — `PiSubagent/` repo structure with empty stubs, vitest config, tsconfig, `package.json` pi-package shape, Dockerfile, README, LICENSE, .gitignore. Initial `git init` commit so subsequent phases have a baseline.
3. **Port + adapt** — port `examples/extensions/subagent/{index.ts, agents.ts}` into `src/runner/subprocess.ts`, `src/agents.ts`, and `src/index.ts`. Apply the v1 hardening deltas in the Subprocess Backend table. Add `src/dispatch.ts`, `src/security.ts`, `src/render.ts`, `src/output.ts`, `src/runner/runner.ts`, `src/runner/in-process.ts`, `src/types.ts`. Write tests per Testing Strategy.
4. **Skill rewrite** — fork the body of merged `subagent-driven-development/SKILL.md` into Pi-shaped prompt templates (single / parallel / chain syntax), keep the skill name, update `description:` frontmatter.
5. **Install + verify** — push repo to `genegulanesjr/PiSubagent` on GitHub; register `git:github.com/genegulanesjr/PiSubagent` in `~/.pi/agent/settings.json`; run `pi install`; manual smoke (single, parallel, chain, Direct-mode fallback). Confirm `~/.pi/agent/agents/` and `~/.pi/agent/prompts/` are populated.

Each phase ends with a write-up-to-the-user checkpoint. No phase begins until the prior phase's checkpoint is approved.

## Out of Scope

- v2 In-Process runner implementation (file exists; throws NotImplemented)
- A custom editor for writing agents and prompts
- Persisted agent telemetry (only per-call token accounting)
- Project-level prompt discovery
- A ui/inspector tool for browsing past subagent runs
- Compatibility with non-pi agent harnesses beyond what agents/*.md frontmatter allows by accident
- Replacing or merging with the user's existing `headroom.ts`, `opennous.ts`, `pistats`, or `design-system` extensions

## Domain Stress-Test Notes

I checked for `CONTEXT.md`, `CONTEXT-MAP.md`, and `docs/adr/` in candidate repos. None found in `PiArgus`, `PiNyx`, `PiStats`, or `PiGen`. The project-specific convention (per memory #770, #1328, #1622) is published npm pi-package with Dockerfile + vitest + GitHub repo + git-install in `settings.json`. PiSubagent follows that pattern exactly. No domain conflicts to resolve.

Cross-cutting terms to watch as the project grows:
- "subagent" / "sub-agent" / "sub agent" — spell consistently in code, comments, docs. Use `subagent` in identifiers (matches upstream).
- "agent" — refers to a `*.md` definition; not to Pi itself.
- "runner" — refers to the `AgentRunner` interface; not to the parent Pi process.
- "scope" — refers to `AgentScope = "user" | "project" | "both"`. Not to project trust.

If any of these drift, propose a `docs/adr/0001-pisubagent-terminology.md` capturing the canonical spelling.

## Self-Review (post-write)

- Placeholder scan: no TBD / TODO / "fill in later". (Note: `src/prompts.ts` was initially stubbed with no v1 behavior; removed in self-review because Pi loads prompts from `~/.pi/agent/prompts/` directly.)
- Internal consistency: `AgentRunner` interface ↔ `SubprocessRunner` implementation ↔ `dispatch.ts` invocation — consistent. All `id: "subprocess" | "in-process"` literals match both backend files.
- Scope check: one feature, one design doc; implementation phases separated; writing-plans will atomize.
- Ambiguity check: all parameter shapes TypeBox-explicit; CLI flags enumerated; defaults tagged on every optional; trust semantics pinned to `ctx.isProjectTrusted()` per upstream precedent.
- Cross-reference: writing-plans skill hardcodes "Use superpowers:subagent-driven-development" by name — preserved by in-place skill rewrite.
- User review pending.
