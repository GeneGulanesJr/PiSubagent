# Subagent Delegation Policy

Use subagents **only when they provide a clear net benefit**. Do not spawn a
subagent merely because the task is large, complex, or because a subagent
could technically perform part of it.

Before spawning any subagent, evaluate:

1. **Can I complete this efficiently with the context I already have?**
   - If yes, do it myself.
   - Do not delegate simply to "save context."

2. **Is the delegated work genuinely independent?**
   - Good candidates:
     - Repository/codebase exploration
     - Independent investigation or research
     - Performance profiling/analysis
     - Security review
     - Finding usages/dependencies
     - Independent code review
     - Writing or validating tests for already-defined behavior
     - Comparing alternative implementations
   - Poor candidates:
     - Small edits
     - Simple bug fixes
     - Straightforward refactors
     - Tasks requiring continuous knowledge of the current implementation
     - Work where I would need to repeatedly communicate context back and forth

3. **Will the subagent's output be substantially smaller than the context it
   would need to perform the task?**
   - Prefer delegation when a large investigation can be reduced to a concise
     result.
   - Avoid delegation when the subagent would need extensive project context
     and its output will require substantial review or correction.

4. **Is parallelism actually useful?**
   - Spawn multiple subagents only when their tasks are genuinely independent
     and can run concurrently.
   - Do not split one sequential task into multiple agents just for the sake
     of using subagents.

5. **Avoid subagent overhead for trivial work.**
   - Do not spawn an agent for a task that can reasonably be completed in a
     few tool calls or a small number of edits.

## Default behavior

**Main agent first. Subagent only when justified.**

If uncertain, do NOT spawn a subagent.

Before spawning, briefly state internally:

> "Delegating because [specific reason]. The subagent will [bounded task], and
> I expect its result to materially improve [context efficiency / parallelism /
> investigation quality]."

If you cannot identify a concrete benefit, perform the work yourself.

## Important

Do not confuse **saving the main context window** with **saving tokens**.

A subagent may increase total token usage. Use subagents primarily for:

- context isolation
- parallel independent work
- specialized investigation
- large exploratory tasks whose findings can be summarized

Do not use them merely because they are available.

## When the user explicitly says "spawn subagents"

Treat that as permission, **not a requirement**.

Interpret:

> "Spawn subagents if needed"

as:

> "You may use subagents if your delegation policy determines they provide a
> meaningful net benefit."

If the task is better handled by the main agent, do not spawn one.

## Maximum delegation

Unless the task clearly benefits from parallelization, prefer **0–1
subagents**.

Do not recursively spawn additional subagents unless the task genuinely
requires it.

For multiple subagents, each must have a clearly distinct responsibility with
minimal overlap.

## Final principle

**Optimize for the best result, not maximum agent utilization.**

A task completed cleanly by the main agent with zero subagents is preferable
to a task made more complicated by unnecessary delegation.

---

## When to delegate to MiniMax M3.1 Flash

The `cheap` tier (`minimax/MiniMax-M3.1-Flash`, see `~/.pi/agent/pisubagent.tiers.json`)
is the model to reach for when work is cheap and checkable. Evidence is early
and mostly from small third-party tests — treat this as a starting heuristic
and update it from real results.

### Use M3.1 Flash for

- Well-scoped bug fixes where tests or a build can verify the result
- Refactors, renames, and mechanical code changes
- Front-end and UI prototyping (self-contained, visually inspectable work)
- Writing docs, comments, READMEs, and structuring or organizing content
- Agent loops with many tool calls (file reads, grep, running commands)
- Navigating or summarizing a large codebase via tools
- High-volume or repetitive tasks where cost matters
  (pricing: $0.15 in / $0.60 out per 1M tokens)

### Do NOT use it for (use a stronger model)

- Code review or security review (reported to miss known problems)
- Complex interactive logic: simulations, games, timing/state-heavy code
  (tends to produce plausible code with runtime errors)
- Hard debugging or architecture decisions
- Web research or factual lookups (high rate of confident wrong answers;
  more likely to invent facts than to say it doesn't know)
- Any task where a subtle mistake would be costly and there is no automated check

### Usage rules

- Always verify its output with tests, a build, or a lint run before accepting it.
- Set reasoning effort to `low` or `medium` for routine edits. It defaults to max,
  which is much slower (about 12x in one test) with no clear quality gain on simple tasks.
- Thinking cannot be turned off.
- Use a 512K context window for everyday work (MiniMax says results are similar
  to 1M at about 20% lower cost).
- Cross-check specific claims it makes (quotes, figures, file contents it says exist).
- If it wanders, stalls, or needs repeated approvals, switch to a stronger model.

### Fallback

If M3.1 Flash fails verification twice on the same task, escalate to a stronger
model instead of retrying.

---

## When to delegate to GLM-5.3 Flash

Most bundled agents pin `zai/glm-5.3-flash`, and the `thinking` tier maps to it
in `~/.pi/agent/pisubagent.tiers.json`. Evidence is early, mostly vendor
benchmarks plus a few small third-party tests — treat this as a starting
heuristic and update it from real results. "GLM-5.3 Flash" is a different model
from the full "GLM-5.3" (text-only, ~10x pricier).

### Use GLM-5.3 Flash for

- High-volume coding and agentic work where cost matters
  (list price: $0.15 in / $0.50 out per 1M tokens)
- Multi-step tool use and function calling. Testers found it handled
  failure-and-retry well, persisted through injected errors, and ignored
  irrelevant "tool bait" in prompts
- Long iterative coding sessions (one tester built a full browser game over
  ~350M tokens and ~56 commits)
- Coding inside Claude Code specifically. It appears tuned for a Claude-Code-style
  harness, so results may vary in other harnesses
- Tasks involving screenshots, charts, PDFs, or UI: it is natively multimodal and
  can look at its own rendered output to fix layout problems
- Frontend, game, and 3D work where "looks right" matters as much as "compiles"
- Bulk or first-pass security scanning (cheap, but see weaknesses)

### Do NOT use it for (use a stronger model)

- Genuinely hard reasoning problems, especially academic-style ones; the full
  GLM-5.3 is stronger there
- Final security review. One test found 34 of 100 known vulnerabilities, which is
  good for the price but misses most of them
- Anything relying on broad factual recall. Z.ai published no academic-knowledge
  benchmarks (MMLU, GPQA, etc.), so there is no evidence either way
- Work where a subtle mistake would be costly and nothing automated checks it

### Usage rules

- It is thinking-first and has no "think nothing" mode. Use the `reasoning_effort`
  setting (low/medium/high) and set it low or medium for routine edits.
- Speed depends heavily on the provider, not just the model. Z.ai's own API runs
  slow (~49 tokens/sec); the same model hits 195-273 tokens/sec on hosts like
  Baseten, FriendliAI, or Databricks. If latency matters, check the provider first.
- Data handling: the first-party API has no signed data-processing agreement or
  zero-retention option and runs under PRC law. Do not send sensitive or customer
  data to it. Use a third-party host or self-host the open weights (MIT licensed).
- Always verify output with tests, a build, or a lint run before accepting it.

### Fallback

If it fails verification twice on the same task, escalate to a stronger model
instead of retrying.

---

## Enforcement in PiSubagent

The policy is guidance-first, enforcement-light (ADR-0006):

- **Tool description** (`src/index.ts`) — a condensed version ships in the
  `subagent` tool description, the one delegation-time text every parent model
  reads.
- **`POLICY_PARALLEL_WARN = 2`** (`src/dispatch/limits.ts`) — parallel
  dispatches with more than 2 tasks are allowed (up to `MAX_PARALLEL_TASKS`)
  but `runParallel` appends a one-line, non-blocking policy note to the
  parent-facing result. It never blocks a dispatch or changes `isError`.
- **Skill** (`skills/subagent-delegation/SKILL.md`) — loaded on demand when a
  parent model is deciding whether to delegate.

A hard `justification` parameter on the tool was considered and deferred:
schema friction for every caller without proven benefit. Revisit if soft
guidance proves insufficient.
