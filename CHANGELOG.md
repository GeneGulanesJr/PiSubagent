# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Dependabot configuration for weekly npm dependency updates (`.github/dependabot.yml`).
- Contributor documentation (`CONTRIBUTING.md`).

### Changed

- Enforce `PER_TASK_OUTPUT_CAP` in parallel and chain modes (dispatch output cap).
- Subprocess hardening: stdout/stderr buffer cap, run timeout, tmpdir cleanup, `onUpdate` exception guard, and malformed JSONL logging.
- `engines` pin: Node `>=22`.

## [0.1.0] - 2026-09-22

### Added

- Initial release with `subagent` tool (single / parallel / chain modes).
- Bundled agents: scout, planner, reviewer, worker.
- Project-local agent trust flow with confirmation.
- Live progress streaming via tool `onUpdate`.
- CI: GitHub Actions matrix on linux and windows.
