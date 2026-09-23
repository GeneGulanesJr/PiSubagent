---
description: Self-diagnostic — verify Node version, tests, agents, audit, settings, and a subagent smoke test
---

# /pisubagent-doctor

When to use: Run this when PiSubagent feels broken, slow, or misconfigured — tests fail, agents don't appear, or the `subagent` tool errors. It runs six read-only checks and reports what to fix.

You are running diagnostics. **Do NOT modify any files.** Read-only inspection only. If a command fails, capture the error and keep going — the report stays informative even when individual checks fail.

## Checks to run

1. **Node version** — Run `node -v`. Parse the major number. Pass if `>= 22` (matches `engines.node` in `package.json`). Fail otherwise.
2. **Tests** — Run `npm test -- --reporter=basic` in the repo root. Report total / passed / failed counts. Pass if 0 failures.
3. **Agents discovered** — List these three directories and read each `.md` frontmatter to capture `name` and `description`:
   - `~/.pi/agent/agents/` (user-level)
   - `.pi/agents/` (project-level, relative to repo root)
   - `agents/` at the repo root (bundled)
   Report which agents exist in each scope and flag duplicates (same `name` in multiple scopes).
4. **Security audit** — Run `npm audit --json`. Sum vulnerabilities by severity (low / moderate / high / critical). Pass if `high + critical == 0`.
5. **Settings registration** — Read `~/.pi/agent/settings.json`. Confirm `packages` array contains `"git:github.com/GeneGulanesJr/PiSubagent"`. If missing, show the user how to add it (`pi` adds it on first install; reinstall via `pi install git:github.com/GeneGulanesJr/PiSubagent`).
6. **Subagent smoke test** — Call `subagent(agent: "scout", task: "echo doctor ok", agentScope: "user")`. Pass if it returns successfully (the literal string or a successful completion).

## Output format

Lead with one line:

`<icon> <N> checks need attention` — where `<icon>` is ✅ (all green), ⚠️ (1–2 yellow), or ✗ (3+ red), and `<N>` is the count of non-passing checks.

Then one section per check, in order:

### <N>. <Check name> <icon>
- **Checked:** what was inspected
- **Found:** the actual result (versions, counts, paths, error excerpts)
- **Fix:** one-line remediation hint — or "—" if passing

Use icons per check: ✅ pass, ⚠️ warn (works but suboptimal), ✗ fail.

### Next steps
- If any check failed: list ONLY the failed checks' remediation commands in numeric order, one per line, copy-pasteable.
- If all green: output exactly `All checks passed.`

## Notes

- Read-only diagnostics — never edit, install, or upgrade anything. Suggesting a fix is fine; running it is not.
- The smoke test (check 6) is the only check that executes a subagent; keep its task literal so the result is unambiguous.
- `npm audit` may take a few seconds; `--json` keeps output parseable even when vulns exist.
- Report findings, don't gate on them — a failing check should not stop the rest from running.
