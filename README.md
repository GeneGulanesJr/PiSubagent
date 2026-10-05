# pisubagent

Pi subagent tool. Single command, three modes.

## Install

`pi install git:github.com/genegulanesjr/PiSubagent` (after pushing to GitHub).

## Why

PiSubagent lets a parent Pi session delegate work to focused subagents that
run in isolated subprocess contexts. It registers one `subagent` tool with
three modes — `single`, `parallel`, `chain` — and ships with eight ready-made
agents (`scout`, `planner`, `reviewer`, `debugger`, `test-writer`, `librarian`,
`aws-architect`, `worker`, plus an audit/optimization suite: `senior-reviewer`,
`bug-hunter`, `deep-auditor`, `security-auditor`, `readiness-reviewer`,
`deps-auditor`, `perf-optimizer`, `database-optimizer`, `ai-cleanup`,
`code-explainer`, `test-generator`). Subagents are resolved from
project-local `.pi/agents/`, user-level `~/.pi/agent/agents/`, and the
bundled defaults, with a one-time confirmation prompt before untrusted
project agents run.

## Use

Ask Pi to use the `subagent` tool:

- **Single**: `subagent(agent: "scout", task: "find auth code")`
- **Parallel**: `subagent(tasks: [{agent:"scout", task:"find models"}, {agent:"scout", task:"find providers"}])`
- **Chain**: `subagent(chain: [{agent:"scout", task:"..."}, {agent:"planner", task:"...{previous}..."}])`

Any dispatch (or any `tasks` / `chain` item) may pass an optional
`thinkingLevel` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`)
to scale reasoning effort for that specific task — e.g.
`subagent(agent: "debugger", task: "...", thinkingLevel: "max")` for a gnarly
repro. Omit it and the role default applies (see below).

Any dispatch (or item) also accepts runtime knobs:

- `timeoutMs` (min 1000) — wall-clock budget for the child. On expiry the child
  is killed (SIGTERM → SIGKILL after 5s) and the result is marked `timedOut`
  with `stopReason: "timeout"` (user aborts report `"aborted"`). The budget
  applies per attempt — with `retries`, worst-case wall clock is
  `attempts × timeoutMs` plus any backoff delays (up to 7× `retryBackoffMs`,
  capped at 30s each).
- `retries` (0–3, default 0) — failed runs are retried; user aborts never are.
  `attempts` on the result reports the total when >1. Retrying a
  `session: true` run mints a fresh session per attempt; failed attempts'
  sessions are abandoned.
- `retryBackoffMs` (0–60000, default 0) — base delay between retry attempts,
  exponential (base, 2×, 4×), capped at 30s. 0 = immediate retry.
- `retryOn` (`["error"]`, `["timeout"]`, or both) — failure classes eligible
  for retry. Default: any failed result. Aborts are never retried.
- `chainFailureThreshold` (1–10, default 1, chain mode) — consecutive-failure
  circuit breaker. `1` stops the chain at the first failed step (historical
  behavior); `2`+ tolerates that many consecutive failures and continues from
  the last GOOD step's output (`{previous}` never carries a failure forward).
  When the breaker trips, untouched steps are reported with
  `stopReason: "skipped_due_to_open_circuit"` and `details.circuitBreaker`
  records the trip. See `docs/adr/0006-loop-resilience.md`.
- `outputSchema` — JSON Schema contract (ajv-validated). Top-level applies to
  single mode; set it per item on `tasks[]`/`chain[]` for parallel/chain. The
  child is instructed to reply with pure JSON; the parsed value lands on
  `data`, and any parse/validation failure lands explicitly on
  `structuredError`. Declare a top-level `type` in your schema — without one,
  a `null` reply validates as `data: null`.
- `session: true` — persist the run as a pi session and report its
  `sessionId`; `resume: "<id|path>"` continues a prior session. Default runs
  are ephemeral (`--no-session`).
- `sessionDir` — session storage directory override (child `--session-dir`).

## Modes

| Mode     | Shape              | When to use                                                         | Concurrency                                                     |
| -------- | ------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| single   | `{ agent, task }`  | One focused dispatch; parent only needs the final answer            | 1                                                               |
| parallel | `{ tasks: [...] }` | N independent jobs whose results don't depend on each other         | up to 4 in flight (per-provider caps may lower this), ≤ 8 total |
| chain    | `{ chain: [...] }` | Sequential pipeline where each step feeds the next via `{previous}` | 1 step at a time                                                |

Use `chain` for scout → plan → worker flows (bundled `/implement`,
`/scout-and-plan`, `/implement-and-review` prompts wrap these). Use
`parallel` for independent recon across a codebase or fan-out reviews. Use
`single` for exactly one job.

The bundled `/pisubagent-doctor` slash command runs read-only diagnostics
(Node version, tests, agents discovered, audit, settings registration, smoke
test, schema surface, agent-store sync) and reports a structured remediation
plan. Reach for it before opening an issue.

## Limits

- `MAX_PARALLEL_TASKS = 8` — `tasks[]` length must be ≤ 8.
- `MAX_CONCURRENCY = 4` — parallel dispatch runs as a sliding window; at most
  4 spawns are in flight at any moment.
- **Per-provider concurrency caps** — provider plans limit concurrent requests
  per account, so parallel dispatch also enforces a per-provider slot count on
  top of the total window. Built-in caps: **z.ai → 2, MiniMax → 3**; a run's
  provider comes from its resolved model (dispatch `model`/`tier` → agent
  frontmatter → parent inheritance). Providers without a configured cap are
  bounded only by `MAX_CONCURRENCY`. Override via
  `~/.pi/agent/pisubagent.limits.json`:
  ```json
  { "zai": 2, "minimax": 3, "anthropic": 4 }
  ```
  Values must be positive integers (0 would deadlock the scheduler); invalid
  entries fall back to defaults. A provider at its cap does not block other
  providers — mixed batches keep flowing.
- `PER_TASK_OUTPUT_CAP = 50 * 1024` bytes — each task's parent-facing summary
  is capped; full output is preserved verbatim in `details.results[i].messages`.
- stdout cap = 1 MB per run — beyond it, bytes spill to
  `<tmpdir>/pisubagent-spill-*/<agent>.log` and `SingleResult.outputFile`
  points at the full log (spill dirs are not auto-cleaned).
- `runTimeoutMs` — optional `SubprocessRunner` constructor kill switch used in
  tests; production dispatches construct the runner without it, so the
  per-dispatch `timeoutMs` is the operative knob.
- `engines.node >= 22` — required at install time.

## Built-in agents

- `scout` (tier `cheap`, thinking `low`) — fast recon
- `planner` (GLM-5.3-Flash, thinking `high`) — implementation plans
- `reviewer` (GLM-5.3-Flash, thinking `high`) — code review
- `debugger` (GLM-5.3-Flash) — diagnose failures, propose minimal fix
- `test-writer` (GLM-5.3-Flash) — focused unit tests
- `librarian` (tier `cheap`, thinking `low`, web tools) — research and docs lookup with citations
- `aws-architect` (GLM-5.3-Flash) — AWS Well-Architected review of IaC
- `worker` (GLM-5.3-Flash) — general implementation
- `senior-reviewer` (thinking `high`, read-only) — pre-merge review of the current diff with a blocking-issues verdict
- `bug-hunter` (thinking `high`) — confirmed-bug hunting; fixes one at a time with tests
- `deep-auditor` (thinking `high`, read-only) — deep full-codebase audit, prioritized findings
- `security-auditor` (thinking `high`) — security audit; verified fixes with separate commits
- `readiness-reviewer` — production-readiness review, then highest-impact fixes
- `deps-auditor` — dependency audit; only justified changes, tests after
- `perf-optimizer` — measurable performance pass with baselines and per-change commits
- `database-optimizer` — DB performance audit (N+1, indexes, plans) and fixes
- `ai-cleanup` — cleans up AI-introduced problems (over-engineering, dead code, duplication)
- `code-explainer` (read-only) — "how does this work" walkthrough before touching code
- `test-generator` — gap-driven test generation for under-tested areas

Override by dropping a same-named `*.md` in `~/.pi/agent/agents/` (or save
one with the `subagent_save` tool — see below; the tool path asks for a
one-time `overwrite: true` before shadowing a bundled name).

## Saving agents from a session (`subagent_save`)

The parent LLM can persist a custom agent mid-session with the
`subagent_save` tool — no hand-editing files required:

```
subagent_save({
  name: "css-refiner",
  description: "Polishes CSS/layout changes after feature work",
  systemPrompt: "You are a CSS specialist. ...",
  tools: "read, grep, bash",
  tier: "cheap"
})
```

Definitions are written to `~/.pi/agent/agents/<name>.md` (scope `user`,
default) or the project's nearest `.pi/agents/` (scope `project`; requires a
trusted project). The upsert policy:

- **Missing agent** → created.
- **Minor changes** (description tweaks, small prompt edits — up to 20% of
  prompt lines) → updated automatically.
- **Major changes** (`tools`/`model`/`tier`/`thinkingLevel` changed, or a
  large prompt rewrite) → **blocked** with a diff summary. The caller must
  pass `overwrite: true` — set only when the user actually wants to replace
  the agent — or save under a different name.
- **Shadowing a bundled name** (e.g. saving your own `scout`) → blocked once;
  `overwrite: true` records it as an intentional override.

Notes: names are kebab-case (`[a-z0-9-]`) because they become filenames —
pre-existing agents with uppercase/underscore names can't be edited by the
tool. Setting both `model` and `tier` warns (the model pin wins and the tier
is ignored at dispatch). Minor updates preserve unknown frontmatter keys
(`tags:`, `author:`, …) already present in the file.

## Bundled updates & shadow sync

If you override a bundled agent, a package update that changes the bundled
`.md` would normally leave your copy silently stale forever. PiSubagent
tracks provenance for tool-saved shadows (a base snapshot in
`~/.pi/agent/pisubagent/bases/`) and syncs them on the next dispatch:

- Your copy **unchanged** since the recorded base → fast-forwarded to the new
  bundled version.
- Your copy has **minor edits** (≤ 20% of lines, no settings changes) and
  they don't collide with the bundled changes → your edits are **rebased**
  onto the update automatically.
- **Major edits or conflicts** → never touched; you get an
  `[agent-sync] …` advisory on the dispatch result and in the TUI.

Hand-written shadows (no provenance snapshot) are never auto-touched;
`/pisubagent-doctor` lists them.

## Custom agents

Agents are plain Markdown files with YAML frontmatter + body (the body is
the agent's system prompt):

```markdown
---
name: my-agent
description: Free-text used by the parent LLM to pick this agent.
tools: read, bash, grep
model: claude-sonnet-4-5
---

System prompt body — verbatim, multi-line.
```

Frontmatter fields:

- `name` (required, unique within scope) — invocation key.
- `description` (required) — what the parent LLM reads to pick this agent.
- `tools` (optional) — comma-separated list; omit to inherit full tool set.
- `model` (optional) — omit to inherit the parent's model + thinking level.
- `tier` (optional) — `cheap|thinking`. Cost-tier routing (see below); ignored
  when `model` is also set (the pin wins).
- `thinkingLevel` (optional) — `off|minimal|low|medium|high|xhigh|max`. Per-role
  reasoning effort. Resolution order (most specific wins): the dispatch call's
  `thinkingLevel` → this frontmatter field → the tier default (tier-routed runs:
  cheap `medium`, thinking `high`) → the parent's level (only when the agent
  also inherits the model) → `medium` default for model-pinned agents.
  Without any of these the child `pi` process would silently run at its own
  `max` default.

## Cost tiers (quota-preserving offload)

Non-crucial work can be routed to a cheaper provider model so the primary
provider's quota (e.g. z.ai's 5-hour window) is spent where it matters:

- **`cheap`** — routine work (recon, lookup, bulk triage). Default model:
  `minimax/minimax-m2.5`.
- **`thinking`** — deep reasoning that can still be offloaded. Default model:
  `minimax/minimax-m3`.

Model resolution (most specific wins): the dispatch call's `model` → its
`tier` → the agent's `model` → the agent's `tier` → parent inheritance.
Tier-routed runs get the tier's thinking default and **fall back to the
parent model once on failure** (quota exhausted, provider error) — offload
is best-effort, never dispatch-fatal. Explicit `model:` pins never fall back.

Override the tier → model mapping in `~/.pi/agent/pisubagent.tiers.json`:

```json
{ "cheap": "minimax/minimax-m2.5", "thinking": "minimax/minimax-m3" }
```

Override precedence (most-specific wins): **project > user > bundled**.
Project agents live in `.pi/agents/` next to a `pi` trust boundary and
require `agentScope: "both"` (or `"project"`) plus a one-time confirmation
when the project is untrusted. See `agents/` for full examples and
`docs/superpowers/specs/2026-09-08-pisubagent-design.md` for the full spec.

## Resilience

Three bounded mechanisms harden dispatch against flaky children (see
`docs/adr/0006-loop-resilience.md`):

- **Launch retry (automatic, all modes).** A child that dies at launch —
  spawn error, or a non-zero exit within 100 ms producing zero output — is
  relaunched up to 3 times with exponential backoff (1s, 2s, 4s, ±20%
  jitter). Real agent output, aborts, and timeouts are never retried;
  relaunches surface as `results[i].launchRetries` (absent when the first
  launch stuck) plus a `[subprocess: launch failure …]` stderr trail.
- **Malformed-JSONL dead-letter capture.** Child stdout lines that aren't
  valid JSONL are tallied as before _and_ captured on
  `results[i].malformedOutput` as `"line N: <content>"` — capped at 20
  entries, each clipped to 200 chars. Malformed lines never enter
  `messages`, so they never propagate through a chain.
- **Chain circuit breaker.** `chainFailureThreshold` (above). A trip is
  recorded on `details.circuitBreaker`:
  `{threshold, consecutiveFailures, stoppedAtStep, skippedSteps}`.

## Troubleshooting

| Message                                                         | Meaning                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid parameters. Provide exactly one mode: …`               | Call had zero or more than one of `{agent, task}`, `{tasks}`, `{chain}`.                                                                                                                                                              |
| `Canceled: project-local agents not approved.`                  | User denied the prompt, or `hasUI === false` on an untrusted project. Pass `confirmProjectAgents: false` to skip when intentional.                                                                                                    |
| `Too many parallel tasks (N). Max is 8.`                        | `tasks.length > MAX_PARALLEL_TASKS`. Split into smaller batches.                                                                                                                                                                      |
| `[Output truncated: N bytes omitted. …]`                        | A task's parent-facing summary exceeded `PER_TASK_OUTPUT_CAP`. Full output is preserved in `details.results[i].messages`.                                                                                                             |
| `[subprocess: N malformed JSONL lines dropped]`                 | The child `pi` process emitted lines that weren't valid JSONL events. The first 20 are captured (offsets + clipped content) on `results[i].malformedOutput`; inspect the agent's prompt — usually stray print output.                 |
| `[subprocess: launch failure (retry N/3) — relaunching in Xms]` | The child died at launch (spawn error, or non-zero exit within 100 ms with no output) and was relaunched with backoff. Final outcome in `results[i].launchRetries`; persistent failures end after 3 retries.                          |
| `Chain stopped at step N … skipped_due_to_open_circuit`         | A chain step failed after `chainFailureThreshold` consecutive failures. Ran steps keep their outputs; untouched steps are marked `skipped_due_to_open_circuit` in `details.results`, and `details.circuitBreaker` describes the trip. |
| `run timeout after Xms`                                         | The per-dispatch `timeoutMs` (or test-only `runTimeoutMs`) was exceeded; the child was killed and the result marked `timedOut` with `stopReason: "timeout"`. Raise the limit or shorten the task.                                     |
| `[truncated: stdout exceeded 1MB — full output: <path>]`        | The child's stdout crossed the 1 MB in-memory cap; the full output was spilled to `<path>` (also on `results[i].outputFile`).                                                                                                         |
| `structured output: …` (in `results[i].structuredError`)        | The reply failed the `outputSchema` contract (parse or validation). The dispatch still succeeded — re-dispatch or inspect `results[i].messages`.                                                                                      |
| `NOT saved: … MAJOR differences …` (from `subagent_save`)       | The saved definition differs majorly from the existing one. Pass `overwrite: true` only when replacing is intended, or save under a different name.                                                                                   |
| `NOT saved: … already exists as a bundled agent …`              | Shadowing a bundled name is a one-time intentional act — re-call with `overwrite: true` to record the override.                                                                                                                       |
| `NOT saved: scope 'project' requires a trusted project`         | Project-scope saves are blocked until the project is trusted in pi's settings. Save to user scope instead.                                                                                                                            |
| `[agent-sync] <agent> (advisory): …`                            | A bundled agent you shadow was updated, but your copy has major edits/conflicts — sync did not touch it. Reconcile the named file by hand.                                                                                            |
| `Agent discovery failed: …`                                     | An agent directory contains a file that could not be read or parsed. Fix or remove the offending `.md` (other agents keep loading either way).                                                                                        |

## Cancellation

The parent tool's abort signal (Esc in pi's TUI) is forwarded to every
in-flight subprocess:

- **single** — aborts the one running spawn; the result records
  `stopReason: "aborted"`.
- **parallel** — aborts every in-flight spawn. Already-completed tasks stay
  in `details.results`; in-flight ones finalize as aborted. Partial output is
  reported to the parent.
- **chain** — aborts only the current step. Prior steps remain in
  `details.results` with their final outputs; downstream steps do not run.

## License

MIT
