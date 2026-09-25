# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Four new bundled agents:
  - `debugger` (Sonnet, read-only) — diagnose failures, propose minimal fix.
  - `test-writer` (Sonnet, read-only) — focused unit tests matching project conventions.
  - `librarian` (Sonnet, web tools) — research, docs lookup, citations.
  - `aws-architect` (Sonnet, read-only) — AWS Well-Architected review of IaC and deployment configs.

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
