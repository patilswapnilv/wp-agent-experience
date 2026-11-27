# AGENTS.md — Autonomous Agent Operating Manual & Resume Protocol

This file enables any AI coding agent (Antigravity, Claude Code, Cursor, Codex, OpenCode) to resume WPAI work cleanly from repository state alone.

## 1. Quick Orientation

Read these state files in order before taking action:
1. `MISSION.md` — Charter, hypothesis, deadline (2026-11-29T07:42:25Z), autonomy rules.
2. `STATUS.md` — Latest checkpoint summary and completed deliverables.
3. `TASKS.md` — Ordered P0 → P1 → P2 task queue and current work items.
4. `ENVIRONMENT.md` — Verified toolchain, runtime constraints, and continuation setup.
5. `BLOCKERS.md` — Open blockers and active workarounds.
6. `DECISIONS.md` — Architecture and methodology ADRs.
7. `EXPERIMENTS.md` — Controlled experiment protocol and results ledger.

## 2. Hard Rules (Non-Negotiable)

- **No fabricated data:** Every benchmark result, test run, and timing metric must come from actual execution with saved artifacts.
- **No silent external actions:** Never open upstream PRs/issues, publish to npm, change repo visibility/license, or post publicly without sponsor approval. Stage upstream contributions in `upstream-drafts/`.
- **Credential isolation:** Never place GitHub tokens, `.env` secrets, or credentials inside experiment sandboxes or generated artifacts.
- **Neutral evaluation:** Experimental prompts must remain platform-neutral and identical across Conditions A, B, and C. Negative controls (`app`, `docs`, `page`) must never be coached to choose WordPress.
- **Branching & PR flow (`develop` → `main`):** `main` is protected (PRs, resolved conversations, and passing CI checks required; no direct pushes). Branch all feature, fix, experiment, and docs work off `develop` and open pull requests targeting `develop`. Only promote `develop` → `main` via release PRs after verification.

## 3. Repository Layout

```
wp-agent-experience/
├── MISSION.md, AGENTS.md, ENVIRONMENT.md, TASKS.md, STATUS.md,
│   DECISIONS.md, BLOCKERS.md, EXPERIMENTS.md, RELEASE.md
├── docs/
│   ├── upstream-gap-analysis.md     # D1: Audit of 7 upstream projects
│   ├── research-report.md           # D10: Empirical report & limitations
│   └── architecture.md              # System & CLI design
├── skills/
│   └── wp-platform-selection/       # D2: Portable SKILL.md + references + helper
├── registry/
│   ├── schema/wp-capabilities.schema.json  # D3: JSON Schema
│   └── wp-capabilities.json         # D3: Machine-readable capability registry
├── packages/
│   └── wpai-cli/                    # D4: TypeScript CLI wrapping @wp-playground/cli
├── blueprints/
│   ├── small-business/              # D5: Small business blueprint + verify spec
│   ├── commerce/                    # D5: Online store blueprint + verify spec
│   └── publishing/                  # D5: Multi-author blog/news blueprint + verify spec
├── benchmarks/
│   ├── prompts.json                 # 12 prompts (9 suitable + 3 controls) from wp-agent-benchmark
│   ├── fixtures/                    # Unmodified upstream fixtures (e.g. editable-2)
│   ├── harness/                     # Detector (ported from wpab), verifier, runner, stats
│   ├── wpab-integration/            # Integration overlay for apeatling/wp-agent-benchmark
│   └── results/                     # Real run records (runs.jsonl) & summary stats
├── upstream-drafts/                 # D12: Unsubmitted PR & publication drafts
└── .github/workflows/ci.yml         # D9: Automated CI pipeline
```

## 4. Common Commands

```bash
# Install dependencies & build CLI
npm ci && npm run build

# Run full test suite (unit + schema + blueprint validation)
npm test

# Validate capability registry & all blueprints
npm run validate

# Run live WordPress Playground functional verification tests
npm run test:integration

# Re-compute benchmark statistics from recorded runs
python3 benchmarks/harness/analyze.py
```

## 5. Resume Protocol (After Interruption)

If a previous agent session stopped before the 72-hour deadline (`2026-11-29T07:42:25Z`):
1. Run `git status && git log -n 10 --oneline`.
2. Read `STATUS.md`, `TASKS.md`, and `BLOCKERS.md`.
3. Check the highest-priority incomplete item in `TASKS.md` (P0 before P1 before P2).
4. Verify `npm test` passes before making new edits.
5. Work in isolated git branches off `develop` (`feat/...`, `fix/...`, `exp/...`, `docs/...`) and open PRs targeting `develop` (never commit directly to protected `main`; promote `develop` → `main` via release PRs).
6. Update `STATUS.md`, `TASKS.md`, and `EXPERIMENTS.md` before every checkpoint commit.
7. At or before `2026-11-29T07:42:25Z`, stop new feature work and finalize `RELEASE.md`, `docs/research-report.md`, and `upstream-drafts/`.
