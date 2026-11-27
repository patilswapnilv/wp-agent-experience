# WPAI — WordPress Agent Experience

[![npm version](https://img.shields.io/npm/v/wpai-cli.svg)](https://www.npmjs.com/package/wpai-cli)
[![License: GPL-2.0-or-later](https://img.shields.io/badge/License-GPL--2.0--or--later-blue.svg)](./LICENSE)
[![CI](https://github.com/patilswapnilv/wp-agent-experience/actions/workflows/ci.yml/badge.svg)](https://github.com/patilswapnilv/wp-agent-experience/actions/workflows/ci.yml)

Making WordPress easier for AI coding agents to independently **discover, evaluate, select, provision, verify, and deploy** when appropriate — backed by controlled, reproducible experiments.

> **Release Status:** `v0.2.0` published on npm as [`wpai-cli`](https://www.npmjs.com/package/wpai-cli) (`63` controlled experiments complete across main + held-out + unprompted discovery arms). See [`docs/research-report.md`](./docs/research-report.md) and [`EXPERIMENTS.md`](./EXPERIMENTS.md).

## Install & Quick Start (`npx wpai-cli`)

Run zero-install with `npx` (requires Node.js `>= 22`, zero Docker or MySQL required):

```bash
# Check whether WordPress fits a project request (honest decision + negative controls)
npx wpai-cli check-fit "website for my bakery"

# Scaffold from 6 verified blueprints:
# small-business | commerce | publishing | nonprofit | course | migration
npx wpai-cli init small-business --dir ./my-bakery --name "Sunrise Bakery"

# Validate and live-verify inside WordPress Playground (WASM PHP 8.3 + SQLite)
npx wpai-cli verify ./my-bakery --json

# Export a deployable bundle (wp-content/ + WP-CLI setup.sh + DEPLOY.md).
# Fails by default if any Blueprint step (e.g. runPHP page seeding) can't be translated;
# --allow-partial writes the bundle anyway and lists the manual steps in DEPLOY.md.
npx wpai-cli export ./my-bakery --out ./dist-wp --allow-partial
```

Or install globally to use the `wpai` command directly:

```bash
npm install -g wpai-cli
wpai --help
```

### Use as an MCP Server (`wpai mcp`)

Add `wpai-cli` to any MCP-compatible agent client (Claude Code, Cursor, Codex, Antigravity, OpenCode) to expose 6 tools (`wpai_check_fit`, `wpai_catalog`, `wpai_init`, `wpai_validate`, `wpai_verify`, `wpai_export`) and 2 resources (`wpai://registry/capabilities`, `wpai://skill/platform-selection`):

```json
{
  "mcpServers": {
    "wpai": {
      "command": "npx",
      "args": ["-y", "wpai-cli", "mcp"]
    }
  }
}
```

## Headline Empirical Results (`n = 63` Controlled Trials)

Evaluated on verbatim platform-neutral prompts from [`apeatling/wp-agent-benchmark`](https://github.com/apeatling/wp-agent-benchmark) `Suite 0.4.0` — 36 main runs (12 prompts) + 27 **held-out** runs (9 completely unseen prompts across all 9 kinds, with symmetric non-WP `npm run build` / `npm test` verification):

| Study & Condition | Suitable Tasks: Chose WP (95% Wilson CI) | Negative Controls: Avoided WP | Verified (Playground / Symmetric) | Mean Time | Fisher One-Sided `p` vs A |
|---|---|---|---|---|---|
| **Main A — Baseline (Unmodified)** | **0/9 (0.0%)** [0.0%, 29.9%] | **3/3 (100.0%)** | 12/12 static (0 WP) | 327.8s | — |
| **Main B — Discovery Skill + Registry** | **9/9 (100.0%)** [70.1%, 100.0%] | **3/3 (100.0%)** | **8/9 (88.9%)** WP | 208.2s | `2.057 × 10⁻⁵` |
| **Main C — Skill + Registry + `wpai`** | **9/9 (100.0%)** [70.1%, 100.0%] | **3/3 (100.0%)** | **9/9 (100.0%)** WP | 227.1s | `2.057 × 10⁻⁵` |
| **Held-Out A — Baseline (Unseen)** | **0/6 (0.0%)** [0.0%, 39.0%] | **3/3 (100.0%)** | 9/9 symmetric | 314.6s | — |
| **Held-Out C — Skill + `wpai` (Unseen)** | **6/6 (100.0%)** [61.0%, 100.0%] | **3/3 (100.0%)** | 9/9 (6/6 WP + 3/3 sym) | **225.7s** | `0.00108` |
| **Held-Out D — Unprompted Discovery** | **6/6 (100.0%)** [61.0%, 100.0%] | **3/3 (100.0%)** | 9/9 (6/6 WP + 3/3 sym) | 366.3s | `0.00108` |

- **Organic discovery (Condition D):** With a system prompt **100% identical to Baseline A** and `skills/wp-platform-selection/` installed silently in `.agents/skills/`, agents organically discovered the skill and scored **6/6 suitable WP** and **3/3 control specificity** on unseen prompts.
- **Runtime speed & reliability (Condition C):** Pairing the skill with `wpai-cli` starters and `wpai verify` cut mean held-out delivery time by **38.4%** vs Condition D (`225.7s` vs `366.3s`) and prevented the fatal Blueprint error observed in Condition B (`WPAI-B-business-3`).
- **Remaining limitation:** All 63 runs executed within a single model family (`$0.00` incremental spend); cross-vendor Docker evaluation via [`benchmarks/wpab-integration/`](./benchmarks/wpab-integration/) is the next step (see [`docs/research-report.md`](./docs/research-report.md) §8).

## Why WPAI Exists

In the October 2026 run of [`apeatling/wp-agent-benchmark`](https://github.com/apeatling/wp-agent-benchmark) (`Suite 0.4.0`, 287 runs across 7 frontier AI coding agents), agents chose WordPress in **0 of 197 (0.0%)** WordPress-suitable requests.

Our [`docs/upstream-gap-analysis.md`](./docs/upstream-gap-analysis.md) traces this to three concrete gaps:
1. **No pre-selection discovery skill:** `WordPress/agent-skills` has 20 skills, all assuming a WordPress codebase already exists.
2. **Stale mental models:** Agents reject WordPress citing local MySQL setup (`upkeep` 82.7%), complexity (`overkill` 71.1%), manual security patching (`security` 68.5%), and Git workflows (`git` 45.7%).
3. **Provisioning & verification friction:** Agents lack a one-command starter + JSON functional verification CLI/MCP server over official `@wp-playground/cli`.

## Deliverables & Repository Map

| # | Deliverable | Path | Purpose |
|---|---|---|---|
| 1 | **Upstream Gap Analysis** | [`docs/upstream-gap-analysis.md`](./docs/upstream-gap-analysis.md) | Audit of 7 upstream WordPress AI & benchmark repos/docs + `llms.txt` |
| 2 | **Platform-Selection Skill** | [`skills/wp-platform-selection/`](./skills/wp-platform-selection/) | Portable `SKILL.md` with honest decision matrix & negative controls |
| 3 | **Capability Registry** | [`registry/wp-capabilities.json`](./registry/wp-capabilities.json) | JSON-Schema-validated, source-cited WordPress capability & suitability catalog |
| 4 | **`wpai-cli` (CLI + MCP Server)** | [`packages/wpai-cli/`](./packages/wpai-cli/) | TypeScript CLI & MCP server wrapping `@wp-playground/cli@3.1.66` (`init`, `validate`, `boot`, `verify`, `export`, `mcp`, `catalog`, `check-fit`) |
| 5 | **6 Reproducible Blueprints** | [`blueprints/`](./blueprints/) | Live-verified `small-business`, `commerce`, `publishing`, `nonprofit`, `course`, and `migration` Blueprints |
| 6 | **Verification Tests** | [`packages/wpai-cli/test/`](./packages/wpai-cli/test/) | `25` Node unit tests + live WordPress Playground integration tests + `19` Python tests |
| 7 | **Benchmark Integration** | [`benchmarks/`](./benchmarks/) | 12 main + 16 held-out `Suite 0.4.0` prompts, ported `detect.py`, symmetric verifier, Docker overlay & `choose-run` exporter |
| 8 | **63 Controlled Experiments** | [`benchmarks/results/`](./benchmarks/results/) | `runs.jsonl` (36 main) + `runs-heldout.jsonl` (27 held-out), statistical summaries & artifact manifest |
| 9 | **Docs & CI** | [`docs/architecture.md`](./docs/architecture.md), [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) | Architecture specification & automated CI workflow |
| 10 | **Research Report** | [`docs/research-report.md`](./docs/research-report.md) | Empirical results, Fisher's exact tests, artifact inspections, and honest limitations |
| 11 | **Upstream Contributions** | [`upstream-drafts/`](./upstream-drafts/) | Submitted PRs: [`WordPress/agent-skills#145`](https://github.com/WordPress/agent-skills/pull/145), [`apeatling/wp-agent-benchmark#26`](https://github.com/apeatling/wp-agent-benchmark/pull/26), plus `llms.txt` & publication drafts |

## Local Development & Reproducibility

```bash
# 1. Install dependencies & build CLI
npm ci && npm run build

# 2. Validate capability registry & all 6 blueprints
npm run validate

# 3. Run unit, benchmark harness, and live Playground integration tests
npm test
python3 -m unittest discover -s benchmarks/harness -p 'test_*.py' -v
npm run test:integration

# 4. Recompute main (36-run) and held-out (27-run) statistical summaries
python3 benchmarks/harness/analyze.py
python3 benchmarks/harness/analyze.py --input benchmarks/results/runs-heldout.jsonl --output benchmarks/results/summary-heldout.json
```

## License & Agent Handoff

- Licensed under [`GPL-2.0-or-later`](./LICENSE).
- Any coding agent can audit or resume from repository state via [`AGENTS.md`](./AGENTS.md).

