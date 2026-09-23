# pisubagent

Pi subagent tool. Single command, three modes.

## Install

`pi install git:github.com/genegulanesjr/PiSubagent` (after pushing to GitHub).

## Why

PiSubagent lets a parent Pi session delegate work to focused subagents that
run in isolated subprocess contexts. It registers one `subagent` tool with
three modes — `single`, `parallel`, `chain` — and ships with four ready-made
agents (`scout`, `planner`, `reviewer`, `worker`). Subagents are resolved from
project-local `.pi/agents/`, user-level `~/.pi/agent/agents/`, and the
bundled defaults, with a one-time confirmation prompt before untrusted
project agents run.

## Use

Ask Pi to use the `subagent` tool:

- **Single**: `subagent(agent: "scout", task: "find auth code")`
- **Parallel**: `subagent(tasks: [{agent:"scout", task:"find models"}, {agent:"scout", task:"find providers"}])`
- **Chain**: `subagent(chain: [{agent:"scout", task:"..."}, {agent:"planner", task:"...{previous}..."}])`

## Modes

| Mode    | Shape                  | When to use                                                          | Concurrency                  |
| ------- | ---------------------- | -------------------------------------------------------------------- | ---------------------------- |
| single  | `{ agent, task }`      | One focused dispatch; parent only needs the final answer             | 1                            |
| parallel| `{ tasks: [...] }`     | N independent jobs whose results don't depend on each other          | up to 4 in flight, ≤ 8 total |
| chain   | `{ chain: [...] }`     | Sequential pipeline where each step feeds the next via `{previous}`  | 1 step at a time             |

Use `chain` for scout → plan → worker flows (bundled `/implement`,
`/scout-and-plan`, `/implement-and-review` prompts wrap these). Use
`parallel` for independent recon across a codebase or fan-out reviews. Use
`single` for exactly one job.

## Limits

- `MAX_PARALLEL_TASKS = 8` — `tasks[]` length must be ≤ 8.
- `MAX_CONCURRENCY = 4` — parallel runs are chunked into batches; at most 4
  spawns are in flight at any moment.
- `PER_TASK_OUTPUT_CAP = 50 * 1024` bytes — each task's parent-facing summary
  is capped; full output is preserved verbatim in `details.results[i].messages`.
- `runTimeoutMs` — optional kill switch with no default; when set, the run is
  aborted once exceeded.
- `engines.node >= 22` — required at install time.

## Built-in agents

- `scout` (Haiku, read-only) — fast recon
- `planner` (Sonnet, read-only) — implementation plans
- `reviewer` (Sonnet, read-only) — code review
- `worker` (Sonnet, full tools) — general implementation

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

Override precedence (most-specific wins): **project > user > bundled**.
Project agents live in `.pi/agents/` next to a `pi` trust boundary and
require `agentScope: "both"` (or `"project"`) plus a one-time confirmation
when the project is untrusted. See `agents/` for full examples and
`docs/superpowers/specs/2026-09-08-pisubagent-design.md` for the full spec.

## Troubleshooting

| Message                                                  | Meaning                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid parameters. Provide exactly one mode: …`        | Call had zero or more than one of `{agent, task}`, `{tasks}`, `{chain}`.                                                          |
| `Canceled: project-local agents not approved.`           | User denied the prompt, or `hasUI === false` on an untrusted project. Pass `confirmProjectAgents: false` to skip when intentional. |
| `Too many parallel tasks (N). Max is 8.`                 | `tasks.length > MAX_PARALLEL_TASKS`. Split into smaller batches.                                                                  |
| `[Output truncated: N bytes omitted. …]`                 | A task's parent-facing summary exceeded `PER_TASK_OUTPUT_CAP`. Full output is preserved in `details.results[i].messages`.          |
| `[subprocess: N malformed JSONL lines dropped]`          | The child `pi` process emitted lines that weren't valid JSONL events. Inspect the agent's prompt — usually stray print output.    |
| `run timeout after Xms`                                  | `runTimeoutMs` was set and the run exceeded it. Raise the limit or shorten the task.                                              |

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
