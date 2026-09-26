# pisubagent

Pi subagent tool. Single command, three modes.

## Install

`pi install git:github.com/genegulanesjr/PiSubagent` (after pushing to GitHub).

## Why

PiSubagent lets a parent Pi session delegate work to focused subagents that
run in isolated subprocess contexts. It registers one `subagent` tool with
three modes — `single`, `parallel`, `chain` — and ships with eight ready-made
agents (`scout`, `planner`, `reviewer`, `debugger`, `test-writer`, `librarian`,
`aws-architect`, `worker`). Subagents are resolved from
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
  is killed (SIGTERM → SIGKILL after 5s) and the result is marked `timedOut`.
- `retries` (0–3, default 0) — failed runs are retried immediately; user aborts
  never are. `attempts` on the result reports the total when >1.
- `outputSchema` (single mode) — JSON Schema contract. The child is instructed
  to reply with pure JSON; the parsed value lands on `data`, and any
  parse/validation failure lands explicitly on `structuredError`.
- `session: true` — persist the run as a pi session and report its
  `sessionId`; `resume: "<id|path>"` continues a prior session. Default runs
  are ephemeral (`--no-session`).

## Modes

| Mode     | Shape              | When to use                                                         | Concurrency                  |
| -------- | ------------------ | ------------------------------------------------------------------- | ---------------------------- |
| single   | `{ agent, task }`  | One focused dispatch; parent only needs the final answer            | 1                            |
| parallel | `{ tasks: [...] }` | N independent jobs whose results don't depend on each other         | up to 4 in flight, ≤ 8 total |
| chain    | `{ chain: [...] }` | Sequential pipeline where each step feeds the next via `{previous}` | 1 step at a time             |

Use `chain` for scout → plan → worker flows (bundled `/implement`,
`/scout-and-plan`, `/implement-and-review` prompts wrap these). Use
`parallel` for independent recon across a codebase or fan-out reviews. Use
`single` for exactly one job.

The bundled `/pisubagent-doctor` slash command (added in v0.1.2) runs
6 read-only diagnostics (Node version, tests, agents discovered, audit,
settings registration, smoke test) and reports a structured remediation
plan. Reach for it before opening an issue.

## Limits

- `MAX_PARALLEL_TASKS = 8` — `tasks[]` length must be ≤ 8.
- `MAX_CONCURRENCY = 4` — parallel runs are chunked into batches; at most 4
  spawns are in flight at any moment.
- `PER_TASK_OUTPUT_CAP = 50 * 1024` bytes — each task's parent-facing summary
  is capped; full output is preserved verbatim in `details.results[i].messages`.
- stdout cap = 1 MB per run — beyond it, bytes spill to
  `<tmpdir>/pisubagent-spill-*/<agent>.log` and `SingleResult.outputFile`
  points at the full log (spill dirs are not auto-cleaned).
- `runTimeoutMs` — optional runner-level kill switch with no default; a
  per-dispatch `timeoutMs` overrides it. Either way the run is killed once
  exceeded and the result is marked `timedOut`.
- `engines.node >= 22` — required at install time.

## Built-in agents

- `scout` (Haiku, thinking `low`) — fast recon
- `planner` (Sonnet, thinking `high`) — implementation plans
- `reviewer` (Sonnet, thinking `high`) — code review
- `debugger` (Sonnet) — diagnose failures, propose minimal fix
- `test-writer` (Sonnet) — focused unit tests
- `librarian` (Sonnet, thinking `low`, web tools) — research and docs lookup with citations
- `aws-architect` (Sonnet) — AWS Well-Architected review of IaC
- `worker` (Sonnet) — general implementation

Override by dropping a same-named `*.md` in `~/.pi/agent/agents/`.

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
- `thinkingLevel` (optional) — `off|minimal|low|medium|high|xhigh|max`. Per-role
  reasoning effort. Resolution order (most specific wins): the dispatch call's
  `thinkingLevel` → this frontmatter field → the parent's level (only when the
  agent also inherits the model) → `medium` default for model-pinned agents.
  Without any of these the child `pi` process would silently run at its own
  `max` default.

Override precedence (most-specific wins): **project > user > bundled**.
Project agents live in `.pi/agents/` next to a `pi` trust boundary and
require `agentScope: "both"` (or `"project"`) plus a one-time confirmation
when the project is untrusted. See `agents/` for full examples and
`docs/superpowers/specs/2026-09-08-pisubagent-design.md` for the full spec.

## Troubleshooting

| Message                                                  | Meaning                                                                                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid parameters. Provide exactly one mode: …`        | Call had zero or more than one of `{agent, task}`, `{tasks}`, `{chain}`.                                                                                                |
| `Canceled: project-local agents not approved.`           | User denied the prompt, or `hasUI === false` on an untrusted project. Pass `confirmProjectAgents: false` to skip when intentional.                                      |
| `Too many parallel tasks (N). Max is 8.`                 | `tasks.length > MAX_PARALLEL_TASKS`. Split into smaller batches.                                                                                                        |
| `[Output truncated: N bytes omitted. …]`                 | A task's parent-facing summary exceeded `PER_TASK_OUTPUT_CAP`. Full output is preserved in `details.results[i].messages`.                                               |
| `[subprocess: N malformed JSONL lines dropped]`          | The child `pi` process emitted lines that weren't valid JSONL events. Inspect the agent's prompt — usually stray print output.                                          |
| `run timeout after Xms`                                  | The per-dispatch `timeoutMs` (or runner-level `runTimeoutMs`) was exceeded; the child was killed and the result marked `timedOut`. Raise the limit or shorten the task. |
| `[truncated: stdout exceeded 1MB — full output: <path>]` | The child's stdout crossed the 1 MB in-memory cap; the full output was spilled to `<path>` (also on `results[i].outputFile`).                                           |
| `structured output: …` (in `results[i].structuredError`) | The reply failed the `outputSchema` contract (parse or validation). The dispatch still succeeded — re-dispatch or inspect `results[i].messages`.                        |

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
