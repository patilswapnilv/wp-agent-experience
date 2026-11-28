# Contributing to WPAI (WordPress Agent Experience)

Thank you for your interest in contributing to **WPAI**! Whether you're reporting a bug, hardening `wpai export`, improving the MCP server, adding a verified Blueprint preset, or running cross-model benchmark replications, your help is welcome.

---

## Quick Start for Contributors

### Prerequisites
- **Node.js `>= 22.0.0`** (`npm`)
- **Python `>= 3.12`** (only needed if working on `benchmarks/harness/`)
- Zero Docker or local MySQL required for `wpai-cli` development or live Playground tests.

### Setup & Verification

```bash
git clone https://github.com/patilswapnilv/wp-agent-experience.git
cd wp-agent-experience
git checkout develop

# Install dependencies and build packages/wpai-cli
npm ci && npm run build

# Validate capability registry & all 6 blueprints
npm run validate

# Run Node unit tests + standalone npm tarball smoke test
npm test
npm run test:pack

# Run Python benchmark harness tests
python3 -m unittest discover -s benchmarks/harness -p 'test_*.py' -v

# Run live WordPress Playground integration tests
npm run test:integration
```

---

## Branching & Pull Request Workflow

We use a **`develop` → `main`** branching model:

- **`main`** is protected (requires pull requests, resolved conversations, and passing CI checks). Never push directly to `main`.
- **Target `develop` for all PRs:** Branch off `develop` using a descriptive name:
  - `feat/<short-name>`
  - `fix/<short-name>`
  - `docs/<short-name>`
  - `exp/<short-name>`
- Open your Pull Request targeting **`develop`** and complete the PR checklist.
- Maintainers promote `develop` → `main` via verified release PRs before publishing `wpai-cli` to npm.

---

## Project Principles (Non-Negotiable)

1. **Honest, neutral evaluation:** Never coach negative-control workloads (`app`, `docs`, `page`) to select WordPress. Keep `skills/wp-platform-selection/` and `registry/wp-capabilities.json` factually accurate and source-cited.
2. **Real evidence only:** Never fabricate benchmark runs, test outputs, or timing metrics. All data in `benchmarks/results/` must come from real executions with verifiable artifacts.
3. **Security & credential isolation:** Never commit `.env` files, API keys, tokens, or credentials. Any changes to `wpai export` or `src/paths.ts` should respect the threat model in [`docs/export-security-and-parity.md`](./docs/export-security-and-parity.md) (`T1`–`T7`).
4. **Standalone npm package parity:** Everything shipped in `wpai-cli` must work when installed outside this repository via `npx wpai-cli` (`npm run test:pack` enforces this in CI).

---

## Good Places to Contribute

- **Export Security Hardening (`T1`, `T3`, `T4`, `T5`, `T7`)** & **Stage 2 Materialized Export (`#2`)** — see [`docs/export-security-and-parity.md`](./docs/export-security-and-parity.md).
- **Cross-Model Benchmark Runs** — run [`benchmarks/wpab-integration/`](./benchmarks/wpab-integration/) against additional frontier models via Harbor and share empirical results.
- **New Verified Blueprint Presets** — open a [Blueprint Preset Proposal](https://github.com/patilswapnilv/wp-agent-experience/issues/new?template=blueprint_preset.yml) before implementing.
- **Documentation & Tests** — improve CLI/MCP ergonomics, Windows/macOS edge cases, or test coverage.

---

## Code of Conduct

Participation in this project is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md).
