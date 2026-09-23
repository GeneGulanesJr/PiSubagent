# Minimal Agent — Annotated Reference

This file is a complete, runnable PiSubagent definition that shows every
frontmatter field, both required and optional. Copy it, change the `name`,
and tweak the body — that's the whole authoring loop.

The frontmatter block sits between two `---` markers at the very top of the
file. Everything after the closing `---` is the agent's **system prompt**
(body) and is sent verbatim to the model at dispatch time.

## Frontmatter

```yaml
---
# REQUIRED — agent identifier. Must match the filename (without .md)
# and be unique across loaded agents. Used in `subagent(agent: "...")`.
name: example-minimal

# REQUIRED — short pitch that appears in agent pickers and tooling.
# Keep under ~120 chars; this is the only hint the calling agent gets
# when deciding which subagent to delegate to.
description: Minimal annotated agent showing every optional frontmatter field

# OPTIONAL — explicit tool allowlist. Omit to inherit the full tool set
# of the calling session (the default). Use a comma-separated list to
# sandbox the agent (e.g. read-only recon, write-only patcher).
# Available names: read, write, edit, bash, grep, find, ls, …
tools: read, grep, find, ls

# OPTIONAL — pin a model for this agent. Omit to inherit the caller's
# model + thinking level. Format is `<provider>/<model>` or just the
# model id when the provider is unambiguous. Examples:
#   model: claude-haiku-4-5      # cheap + fast recon
#   model: claude-sonnet-4-5     # balanced implementation
#   model: claude-opus-4-5       # hardest reasoning, slowest
model: claude-haiku-4-5
---

You are `example-minimal`. This body is your system prompt — it's the only
context you'll see at dispatch time, so be explicit about what you do and
how you should respond.

## What you do
- Read-only codebase reconnaissance.
- Return a short, structured summary the caller can act on.

## How to respond
1. Investigate the task using your read-only tools.
2. When done, output the `## Findings` block below.
3. Stop. Do not start implementing fixes — that's a different agent's job.

## Output format

### Findings
- `path/to/file.ts:10-40` — what lives here, in one sentence
- `path/to/other.ts:1-200` — second finding

### Notes (optional)
Anything the caller should know before acting on the findings.
```

## Field reference (cheat sheet)

| Field          | Required | Purpose                                        |
| -------------- | -------- | ---------------------------------------------- |
| `name`         | yes      | Agent id; must equal filename minus `.md`      |
| `description`  | yes      | One-line pitch shown to callers and pickers    |
| `tools`        | no       | Comma-separated allowlist; omit = inherit all  |
| `model`        | no       | Pin a model; omit = inherit caller's model     |

Everything else in the body is just Markdown sent to the model as the
system prompt. There is no magic — write the instructions you would want
the agent to follow.
