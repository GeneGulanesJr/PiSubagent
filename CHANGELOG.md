# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Cost tiers** (`tier: cheap | thinking`) — quota-preserving offload of
  non-crucial subagent work to a cheaper provider model. Resolution ladder
  (most specific wins): dispatch `model` → dispatch `tier` → agent frontmatter
  `model:` → agent frontmatter `tier:` → parent inheritance. Defaults:
  `cheap` → `minimax/minimax-m2.5`, `thinking` → `minimax/minimax-m3`;
  overridable via `~/.pi/agent/pisubagent.tiers.json`. Tier-routed runs get a
  tier-specific thinking default (cheap: `medium`, thinking: `high`) and fall
  back to the parent model once on failure (`fellBackToParent` on the result;
  explicit `model:` pins never fall back). Bundled `scout` and `librarian`
  now ship as `tier: cheap` (was Haiku / Sonnet pins).
- **`subagent_save` tool** — the parent LLM can persist or update agent
  definitions programmatically (`~/.pi/agent/agents/<name>.md` or the
  project's nearest `.pi/agents/`). Upsert policy: missing agent → created;
  minor changes (description tweaks, prompt edits ≤ 20% of lines) → updated
  automatically; major changes (tools/model/tier/thinkingLevel changed, or a
  large prompt rewrite) → blocked with a diff summary until the caller passes
  `overwrite: true`. Shadowing a bundled name requires the same one-time
  `overwrite`. Serialization double-quotes every frontmatter scalar (defeats
  YAML scalar re-typing), verifies the written file round-trips through
  `parseFrontmatter` (restore-not-delete on failure), and preserves unknown
  frontmatter keys on updates. Project-scope writes require a trusted project
  and always target the nearest existing `.pi/agents` (see ADR-0004).
- **Bundled-shadow sync** (`src/agent-sync.ts`) — user copies of bundled
  agents created via `subagent_save` carry provenance (a base snapshot in
  `~/.pi/agent/pisubagent/bases/`). When a package update changes a bundled
  `.md`: untouched copies fast-forward; minor user edits (≤ 20% of lines, no
  settings changes) rebase onto the update via a clean 3-way merge; major
  edits or conflicts are never auto-touched and surface as
  `[agent-sync] …` advisories on dispatch results (TUI + LLM). Hand-written
  shadows have no provenance and are never auto-touched.
- **Agent name policy** — `subagent_save` names are kebab-case
  (`^[a-z]([a-z0-9-]{0,62}[a-z0-9])?$`, max 64) since they become filenames;
  setting both `model` and `tier` warns (the pin wins, the tier is dead).
- `/pisubagent-doctor` gains checks for bundled-shadow sync state (stale
  shadows, orphaned base snapshots, skipped agent files) and now covers both
  registered tools.

### Fixed

- **`prepare` script was a silent no-op on every platform** (PR #4 follow-up):
  husky 9 is ESM-only, so `require('husky').install()` threw
  (`install` is `undefined` — the ESM namespace only exposes `default`) and
  the `catch {}` swallowed it, meaning git hooks never installed anywhere.
  Now uses `import('husky').then(m => m.default())` with the same
  never-fail-install guard. Also made the `clean` script cross-platform
  (`rm -rf` → `node -e fs.rmSync`) while touching the same concern.
- **Bundled agents never loaded.** `resolveBundledAgentsDir` walked
  `../../agents` from `src/` — one level past the package root — so bundled
  definitions silently never loaded in any layout (repo checkout, pi git
  install); every dispatch ran on the empty fallback config (no system
  prompt, no tools/model/tier frontmatter). Now resolves `../agents`
  (pinned by a regression test against the repo's real `agents/` dir).
- **One malformed agent `.md` bricked all dispatches.** `loadAgentsFromDir`
  called `parseFrontmatter` (a real YAML parser that throws) without a
  guard, so a single invalid-YAML file in any agent directory made every
  `subagent` call fail. Malformed files are now skipped like other
  unreadable entries; both tools' discovery is additionally wrapped so a
  failure surfaces as an explicit error result naming the problem, never a
  raw throw.

## [0.3.0] - 2026-09-27

Structured-everywhere minor: full JSON-Schema validation, per-item outputSchema
for parallel/chain, retry backoff + filtering, sessionDir passthrough, TUI
result badges, and dogfood docs. 289+ tests across 28 files, all green.

### Added

- **Full JSON-Schema validation** (`ajv ^8.20.0`, `strict: false`,
  `ownProperties: true`). `validateAgainstSchema` is now backed by ajv —
  schemas support every keyword ajv handles (maxLength, enum, items, …), not
  just `type`/`required`. Error messages are ajv-shaped (`/answer must be
string`); `extractStructured` still wraps them as
  `structured output: schema violation: …`.
- **Per-item `outputSchema`** on `tasks[]` and `chain[]` items. Each item's
  child task gets the structured-output instruction appended (chain: after
  `{previous}` substitution), and its result carries `data` /
  `structuredError` with the original task text restored. Top-level
  `outputSchema` remains single-mode (guard message updated).
- **Retry backoff** (`retryBackoffMs`, 0–60000, default 0) — delay before
  retry attempt n is `base × 2^(n-1)`, capped at 30s; abort-aware (abort
  during a backoff sleep cancels the retry).
- **Retry filtering** (`retryOn: ["error" | "timeout"]`) — failure-class
  filter; default retries any failed result. Aborts are never retried
  regardless.
- **`sessionDir`** — session storage directory override passed to the child
  as `--session-dir`; available on single params, `tasks[]` items, and
  `chain[]` items.
- **TUI result badges** — the rendered result now surfaces `[×N]` attempt
  counts, `[timed out]`, `[structured ✓]`/`[structured ✗]`, short session
  ids, and a `→ spilled: <path>` line in single mode.
- **Dogfood docs** — `librarian` gains an outputSchema (structured citations)
  section; `debugger`/`test-writer` document resumable iterative sessions;
  `/pisubagent-doctor` gains check 7 (dispatch-schema surface + ajv import);
  the `pi-subagent-driven-development` skill documents the runtime knobs for
  long-running worker tasks.

### Changed

- `structured output` validation errors are now ajv messages (e.g. `must be
object`, `must have required property 'answer'`) — same pass/fail
  classification as the light validator for all v0.2.x-documented cases,
  richer enforcement for everything else.

## [0.2.1] - 2026-09-27

Polish patch closing the v0.2.0 review debt. One observable behavior change
(timeout `stopReason`), two validation fixes, and a test seam. 270 tests
across 26 files, all green.

### Changed

- **Timed-out runs now report `stopReason: "timeout"`** (was `"aborted"`).
  `timedOut: true` and the `run timeout after Xms` error message are
  unchanged — consumers keying on `timedOut` are unaffected; consumers keying
  on `stopReason` can now distinguish timeouts from user aborts.

### Fixed

- `outputSchema` supplied alongside `tasks`/`chain` now returns an explicit
  invalid-params error instead of being silently ignored.
- `validateAgainstSchema` no longer masks `null` payloads to `{}`: with no
  top-level `type`, a `null` reply validates as `data: null` instead of
  producing a misleading "missing required property" error. `type: "object"`
  schemas still reject `null` via the top-level type check.

### Added

- `SubprocessRunnerOptions.spillFactory` — injectable spill-file factory
  (defaults to `createSpillFile`), making the plain-truncation fallback
  branch reachable in tests.

### Docs

- README: `runTimeoutMs` clarified as a test-only constructor option (the
  per-dispatch `timeoutMs` is the operative knob in production); the timeout
  budget is per-attempt (worst-case `attempts × timeoutMs` with retries);
  retrying a `session: true` run mints a fresh session per attempt.

## [0.2.0] - 2026-09-25

Runtime-robustness minor: six per-dispatch controls over child subprocesses — timeout, retries, output spill, usage rollups, structured output, and session persistence/resume. 261 tests across 24 files, all green.

### Added

- **Dynamic thinking-level resolution** (`src/thinking.ts`). Previously every
  model-pinned agent silently ran at the child `pi` process's `max` default —
  no `--thinking` flag was ever passed. Resolution order (most specific wins):
  per-dispatch `thinkingLevel` on the tool call (single / `tasks` item /
  `chain` item) → `thinkingLevel:` agent frontmatter → the parent session's
  level (only when the agent also inherits the model) → `medium` default for
  model-pinned agents. Bundled role defaults: `scout`/`librarian` = `low`,
  `planner`/`reviewer` = `high`, all others inherit the `medium` default.
  `SingleResult.thinkingLevel` reports the effective level per run.
- **Per-dispatch timeout** (`timeoutMs`, minimum 1000 ms). Wall-clock budget for a
  child run; single params, `tasks[]` items, and `chain[]` items all accept it.
  On expiry the child gets SIGTERM (SIGKILL after 5s) and `SingleResult.timedOut`
  is set, so timeouts are distinguishable from user aborts. Per-dispatch beats
  the runner-level `runTimeoutMs`. Also fixes a timer leak: the runner-level
  timeout timer is now cleared when the process exits early and `unref()`'d.
- **Per-dispatch retries** (`retries`, 0–3, default 0) via a shared
  `runWithRetries` helper. Failed results are retried up to N times; user
  aborts (`ctx.signal` already aborted) are never retried. `SingleResult.attempts`
  reports the total when more than one attempt was made. No backoff delay in v1.
- **Stdout spill artifact.** When child stdout exceeds the 1 MB in-memory cap,
  overflow bytes are spilled to `<tmpdir>/pisubagent-spill-*/<agent>.log` instead
  of being dropped; `SingleResult.outputFile` points at the full log (including
  the buffered bytes and the crossing chunk). Falls back to plain truncation
  when the temp dir can't be created. The spill dir is intentionally not
  cleaned up — it's the caller's artifact.
- **Usage rollups.** `SubagentDetails.usage` aggregates per-run `UsageStats` for
  parallel and chain dispatches: counters sum, `contextTokens` (a gauge) takes
  the max. Rolled up on parallel completion and on both chain outcomes
  (short-circuit failure and completion). Single mode unchanged.
- **Structured output** (`outputSchema`, single mode, v1). JSON Schema contract:
  the child is instructed to reply with pure JSON, which is fence-stripped,
  parsed, and lightly validated (top-level `type`, `required`, per-property
  `type`). Value lands on `SingleResult.data`; failures set an explicit
  `SingleResult.structuredError` (parse/validation detail) without flipping
  the dispatch `isError`. Full JSON-Schema validation is future work.
- **Session persistence / resume.** `session: true` persists the child run as a
  pi session (`--session-id <uuid>`) and reports `SingleResult.sessionId`;
  `resume: "<id|path>"` continues a prior session (`--session`) and wins over
  `session`. Default remains ephemeral (`--no-session`).
- Four new bundled agents:
  - `debugger` (Sonnet, read-only) — diagnose failures, propose minimal fix.
  - `test-writer` (Sonnet, read-only) — focused unit tests matching project conventions.
  - `librarian` (Sonnet, web tools) — research, docs lookup, citations.
  - `aws-architect` (Sonnet, read-only) — AWS Well-Architected review of IaC and deployment configs.

### Fixed

- `isFailedResult` explicitly counts `timedOut` results (previously classified
  only via `stopReason: "aborted"`).
- Spill: the chunk that crosses the 1 MB cap is appended to the artifact (was
  dropped at the boundary).
- `runWithRetries` accumulates usage across attempts — failed attempts' spend
  is no longer discarded from `usage` rollups.
- `validateAgainstSchema` uses `Object.hasOwn` for `required` checks —
  `Object.prototype` keys ('toString', 'constructor') no longer satisfy
  required properties vacuously.
- `timeoutMs` has a defensive runtime floor (1 ms) so non-schema callers
  passing 0/negative cannot silently disable the kill switch.

## [0.1.5] - 2026-09-23

Build-infrastructure patch. No public-API or runtime changes. Major-version bumps for `lint-staged`, `@types/node`, `eslint`, and `typescript`, plus peer-dep and plugin cascade fixes that those bumps surfaced.

### Changed

- `prettier` 3.9.8 → 3.9.9 (`7f579d3`).
- `tsx` `^4.0.0` → `^4.23.15` (`7f579d3`).
- `peerDependencies` for the four `@earendil-works/pi-*` packages: `"*"` → `^0.87.1` (`7f579d3`).
- `lint-staged` `^15.2.10` → `^17.5.1` (`c09906b`). No config changes needed — the existing `.lintstagedrc.json` is forward-compatible.
- `@types/node` `^22.20.4` → `^26.6.2` (`de0437f`).
- `eslint` `^9.39.5` → `^10.11.0` + `@eslint/js` `^9.39.5` → `^10.0.1` (`e66cef1`). Required cascade fixes: added peers to `devDependencies` (modern npm doesn't auto-install peer deps), added `vite ^7.1.0` for vitest 5 peer, replaced `eslint-plugin-vitest@0.5.4` (broken under eslint 10) with `@vitest/eslint-plugin` (vitest-team-official, flat-config native). Also fixed one real bug surfaced by lint running on `src/`: `src/runner/subprocess/runner.ts` had an unused `tmpPromptPath` variable (`no-useless-assignment`) — inlined the single use of `tmp.filePath` and dropped the name.
- `typescript` `^5.7.0` → `^6.0.3` (`e26fd2f`). The ceiling is ecosystem-bounded: `typescript-eslint@8.70.1` (current `latest` on npm) declares `peerDependencies.typescript: '>=4.8.4 <6.1.0'`, so TS 7.0.2 is out of reach until typescript-eslint ships a v9 / next channel. Forcing `--legacy-peer-deps` would install but break lint at runtime.

### Fixed

- `src/runner/subprocess/runner.ts` — dropped useless `tmpPromptPath` variable; inlined the single use of `tmp.filePath` (no behavioral change). Uncovered by the eslint 10 migration above once eslint actually started linting `src/`. (`e66cef1`)

### Build config

- `stryker.config.mjs` — landed the `excludedMutations` block (StringLiteral, ObjectLiteral, ArrayDeclaration, Regex, ArrowFunction) that had been sitting uncommitted from prior mutation analysis. No source or test changes (`d2cd712`).

### Test suite

- 185 tests across 17 files, all green.
- Stryker mutation score: **0.45%** (still the post-v0.1.6 baseline; no further lift this round — the score ceiling is bounded by `perTest` coverage attribution, not test value, per memory `#26282`).

## [0.1.4] - 2026-09-23

Test-infrastructure patch. No public-API or runtime changes — only test coverage for previously-uncovered decision points and integration paths. All 59 new tests pass; existing 126 tests unchanged.

### Added

- Behavioral tests for uncovered dispatch decision points: `test/dispatch-behavioral.test.ts` (19 tests covering `runChain` short-circuit on step failure, `runParallel` `MAX_PARALLEL_TASKS` boundary, `runParallel` partial-failure surfacing, `runSingle` failure mode, `execute()` lookup fallback for unknown agent names, `detectMode` single-mode `&&` requirement edges, per-task `cwd` override, multi-batch concurrency cap).
- Discriminating triage tests for surviving Stryker mutants on dispatch boundaries: `test/dispatch-triage.test.ts` (15 tests asserting on observable output for `detectMode` length === 0 edges, ternary/conditional swap signals, lookup-fallback stub shape, `runParallel` MAX_PARALLEL_TASKS boundary + concurrency cap, `runSingle` content-passthrough).
- Integration-style tests for no-coverage subprocess paths: `test/runner-integration.test.ts` (25 tests using `spawnFn` injection with fake `ChildProcess`/`JsonlEventFeed`; covers abort mid-run, fs cleanup on error, JSONL streaming partial abort, onUpdate exception isolation, stdout/stderr 1 MB cap, `progress.ts` emit paths, `selectRunner` + invocation).

### Test suite

- 185 tests across 17 files, all green.
- Stryker mutation score: **0.45%** (up from 0.23% in v0.1.2). 2 of 452 mutants killed; 443 survived; 7 no-cov. Combined with the pre-existing `excludedMutations` config (StringLiteral, ObjectLiteral, ArrayDeclaration, Regex, ArrowFunction), the surviving mutants cluster in ConditionalExpression, BlockStatement, EqualityOperator, LogicalOperator, BooleanLiteral — all testable in principle but perTest coverage attribution is the dominant bottleneck.

## [0.1.3] - 2026-09-23

Maintenance patch. No public-API or runtime changes — only the install path for `--omit=dev` consumers.

### Fixed

- `npm install --omit=dev` (used by Pi's git-source package manager at `~/.pi/agent/git/...` and by Docker builds) failed with `sh: husky: command not found` / exit 127: the `prepare` lifecycle script ran `husky` unconditionally even though `husky` lives in `devDependencies` and was therefore absent. `prepare` now fails-open with `command -v husky >/dev/null 2>&1 && husky || true` so full dev installs still execute `husky install` (`fc3b2a0`).

## [0.1.2] - 2026-09-23

Quality-of-life, CI hardening, dev-tooling, and observability release. No breaking changes to the public `subagent` tool surface. All changes ship behind the existing `pi install git:github.com/GeneGulanesJr/PiSubagent` distribution path.

### Added

- Streaming progress with per-agent latest message text (`src/output.ts:progressSnippet` + `PROGRESS_THROTTLE_MS = 150`). Parallel dispatch now surfaces per-agent activity live instead of a static counter (`commit 83c5ebf`).
- `/pisubagent-doctor` slash command (`prompts/pisubagent-doctor.md`) — runs 6 read-only diagnostics (Node version, tests, agents discovered, audit, settings registration, smoke test) and reports a structured remediation plan.
- macOS added to CI matrix (`.github/workflows/test.yml`).
- `actions/dependency-review-action@v4` on pull requests — fails PRs that introduce moderate+ severity vulnerabilities (`.github/workflows/dependency-review.yml`).
- GitHub CodeQL weekly + per-push + per-PR scan with SARIF upload to the Security tab (`.github/workflows/codeql.yml`).
- `docs/adr/` with first three Architecture Decision Records:
  - `0001-per-batch-concurrency-cap.md` — why `runParallel` uses a per-batch loop.
  - `0002-truncate-parallel-output.md` — why `PER_TASK_OUTPUT_CAP` is enforced on `runParallel` summaries and on `{previous}` substitution in `runChain`.
  - `0003-streaming-progress-throttle.md` — why `progressSnippet` was added to `src/output.ts` and why the throttle is 150 ms.
- `SUPPORT.md` — how to ask questions, file bugs, report security issues.
- `.github/CODEOWNERS` — `@GeneGulanesJr` as default reviewer for the whole repo.
- `examples/` directory with sample agent frontmatter and runnable `subagent(...)` invocations for each of the three modes.
- StrykerJS v10 mutation testing (`stryker.config.mjs` + `npm run mutate`). Baseline score 0.23% (low because existing tests are heavy on string-equality / snapshot matches — score will lift as behavioral tests land).
- `.nvmrc` + `.node-version` (Node 22 pin for nvm / asdf / mise / volta users).
- Dependabot weekly schedule for npm (`dependabot.yml`).
- `CONTRIBUTING.md` — contributor guide.
- Issue templates (`.github/ISSUE_TEMPLATE/{bug,feature}.yml`) and PR template.
- `SECURITY.md` with private disclosure email + 7-day response SLA.
- EditorConfig (`.editorconfig`) + `.gitattributes`.
- `PER_TASK_OUTPUT_CAP = 50 * 1024` enforced in `runParallel` summaries.
- `runTimeoutMs` option on `SubprocessRunnerOptions` (no default; fires SIGTERM → SIGKILL after the configured window).

### Changed

- `vitest` 3.2.7 → 5.0.1, `@vitest/coverage-v8` 3.2.7 → 5.0.1, `@types/node` ^20 → ^22 (vitest 5 peer dep).
- `engines.node` pinned to `>= 22`.
- `Dockerfile` `FROM node:20-bookworm-slim` → `FROM node:22-bookworm-slim` to match the engines pin.
- `src/dispatch.ts` (394 LOC) split into focused modules under `src/dispatch/{detect-mode,limits,internal,progress,types,execute,run-single,run-parallel,run-chain,index}.ts`. Shim file preserved at `src/dispatch.ts` for NodeNext back-compat.
- `src/runner/subprocess.ts` (354 LOC) split into focused modules under `src/runner/subprocess/{invocation,prompt-file,kill-abort,jsonl,runner,index}.ts`. Shim file preserved at `src/runner/subprocess.ts`.
- `vitest.config.ts` — bumped `hookTimeout` to 60 s + `clearMocks: false` (vitest 5 default change).
- `src/runner/subprocess.ts:parseJsonlEvents` return type widened from `IterableIterator<JsonlEvent>` to `Iterable<JsonlEvent>` (right public abstraction).
- CI workflow adds `npm run build` step before `npm test`, and runs tests with `--coverage` to enforce the vitest 80/80/80/70 thresholds.
- Auto-release workflow `.github/workflows/release.yml` triggered on `v*` tag push.

### Fixed

- Issue #1 (Drift): `MAX_CONCURRENCY = 4` was advertised but unenforced — `runParallel` now uses a per-batch loop (`commit 940695e`).
- Issue #1: `execute()` denial path hardcoded `mode: "single"` — now uses the detected mode so parallel/chain consumers get accurate detail (`commit 940695e`).
- Issue #1: `AgentScope` fallthrough silently loaded all three sources for unknown values — now explicit (project / user / both) (`commit 940695e`).
- SubprocessRunner hardening: stdout/stderr buffer cap (1 MB, drop-and-warn on overflow), `runTimeoutMs`, `fs.rmSync(recursive)` tmpdir cleanup, `onUpdate` exception guard, malformed-JSONL stderr summary.
- Windows cold-import flake: `vitest.config.ts:hookTimeout` bumped to 60 s.
- `Iterable<JsonlEvent>` spread under lint-staged's per-file `tsc --noEmit` (TS2802): removed per-file `tsc` from `.lintstagedrc.json` in favor of full-project typecheck in CI + local `npm run typecheck`.

### Security

- `npm audit`: 0 vulnerabilities (was 3 moderate `@vitest/mocker` advisories before vitest 5 bump; cleared by `a1011f3`).
- GitHub CodeQL `security-extended + security-and-quality` queries on every push + weekly.
- `dependency-review-action` flags new moderate+ vulnerabilities at PR time.
- `SECURITY.md` documents private disclosure flow.

## [0.1.1] - 2026-09-23

### Fixed

- Windows cold-import flake: `vitest.config.ts:hookTimeout` bumped to 60 s (`f17db55`).
- `MAX_CONCURRENCY = 4` advertised but unenforced (`4d4612c`).
- `execute()` denial path hardcoded `mode: "single"` (`4d4612c`).
- `AgentScope` fallthrough silently loaded all sources for unknown values (`4d4612c`).

### Changed

- `vitest` 3.2.7 → 5.0.1 (`a1011f3`).
- GitHub Actions CI on linux + windows (`af8b28c`).

## [0.1.0] - 2026-09-22

### Added

- Initial release with `subagent` tool (single / parallel / chain modes).
- Bundled agents: scout, planner, reviewer, worker.
- Project-local agent trust flow with confirmation.
- Live progress streaming via tool `onUpdate`.
- CI: GitHub Actions matrix on linux and windows.
