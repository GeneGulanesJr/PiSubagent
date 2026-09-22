# Contributing

Thanks for your interest in PiSubagent! This guide covers local setup, verification,
and the conventions we follow. Issues and PRs are welcome.

## Setup

```sh
git clone https://github.com/GeneGulanesJr/PiSubagent.git
cd PiSubagent
npm install
```

Node **22 or newer** is required (see the `engines` field in `package.json`).
No global dependencies are needed — `npm install` is sufficient.

## Verify

Before opening a PR, run the full verification suite locally:

```sh
npm run typecheck && npm test
```

Both commands must pass. CI runs the same matrix on linux and windows.

## Conventions

- **Commit messages** follow `<type>: <subject>`. Common types: `feat:`, `fix:`,
  `test:`, `build:`, `ci:`, `docs:`. See `git log --oneline -10` for examples.
- **TypeScript sibling imports** use the `.js` extension (Vite-style ESM
  resolution — the runtime resolves to the `.ts` source). See `tsconfig.json`.
- **Tests** live in `test/` and follow vitest patterns — one `describe` block per
  source module.
- **Public exports** in `src/index.ts` are the user-facing API. Backward
  compatibility matters: additive changes only, no breaking renames or removals
  within a minor line.

## Reporting bugs

Open an issue at https://github.com/GeneGulanesJr/PiSubagent/issues and include:

1. Reproduction steps (ideally a minimal failing test).
2. Output of `npm test` (paste the relevant snippet).
3. Node version (`node -v`) and platform.
