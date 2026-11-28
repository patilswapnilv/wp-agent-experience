# TASKS.md — WPAI Execution Board

**Priority Rule:** Never compromise P0 for P1 or P2.  
**Board Status:** All P0, P1, and P2 deliverables completed and verified (`v0.1.0-rc.1`).

## P0 — Core Mission (Must Deliver)

- [x] **T0.1** Verify remote environment, GitHub auth, network, and orchestration capabilities (`ENVIRONMENT.md`)
- [x] **T0.2** Initialize persistent repository state (`MISSION.md`, `AGENTS.md`, `ENVIRONMENT.md`, `TASKS.md`, `STATUS.md`, `DECISIONS.md`, `BLOCKERS.md`, `EXPERIMENTS.md`, `RELEASE.md`)
- [x] **T0.3** Complete WordPress Playground CLI smoke test (`@wp-playground/cli@3.1.66`) and verify WordPress 7.1.5 + PHP 8.3.36 + SQLite + Abilities API runtime (`WP_Ability` native)
- [x] **T0.4** Complete Deliverable 1: Upstream technical gap analysis covering all 7 upstream repos/docs + `wordpress.org/llms.txt` (`docs/upstream-gap-analysis.md`)
- [x] **T0.5** Complete Deliverable 3: Machine-readable WordPress capability registry + JSON Schema Draft 2020-12 + AJV validator (`registry/`)
- [x] **T0.6** Complete Deliverable 2: Portable platform-selection agent skill (`skills/wp-platform-selection/`)
- [x] **T0.7** Complete Deliverable 4: Minimal TypeScript CLI wrapping official `@wp-playground/cli` (`packages/wpai-cli/`) with `init`, `validate`, `boot`, `verify`, `catalog`, `check-fit`, `validate-registry`
- [x] **T0.8** Complete Deliverable 5 (core): First verified reproducible blueprint (`blueprints/small-business/`)
- [x] **T0.9** Complete Deliverable 6 (core): Automated unit (`19/19`) + functional WordPress Playground verification tests (`4/4`)
- [x] **T0.10** Complete Deliverable 7: Benchmark integration with `apeatling/wp-agent-benchmark` (12 verbatim prompts, ported deterministic detector, functional verifier, `19/19` Python unit tests, `wpab` overlay & `choose-run` schema exporter)
- [x] **T0.11** Execute pilot + P0 controlled experiment batch (Conditions A, B, C) and verify artifact inspection pipeline

## P1 — Full Experimental Evidence, Blueprints & Upstream Drafts

- [x] **T1.1** Complete Deliverable 5 (full): Commerce (`blueprints/commerce/`) and Publishing (`blueprints/publishing/`) blueprints + live WordPress Playground verification
- [x] **T1.2** Complete Deliverable 8: Full 36 controlled experiments (12 prompts × 3 conditions A/B/C, including 3 negative controls) with real saved artifacts (`benchmarks/results/runs.jsonl`, `summary.json`, `artifact-manifest.json`, `wpab-choose-export.jsonl`)
- [x] **T1.3** Complete Deliverable 9: Reproducible documentation (`README.md`, `docs/architecture.md`) and GitHub Actions CI (`.github/workflows/ci.yml`)
- [x] **T1.4** Complete Deliverable 10: Empirical research report (`docs/research-report.md`) with actual evidence, Fisher's exact tests, artifact inspection, threats to validity, and honest limitations
- [x] **T1.5** Complete Deliverable 12: Draft upstream contributions (`upstream-drafts/` for `WordPress/agent-skills`, `apeatling/wp-agent-benchmark`, `make.wordpress.org/ai` / `wordpress.org/llms.txt`, and `publication-post-draft.md`) — staged locally, unsubmitted

## P2 — Release Candidate & Polish

- [x] **T2.1** Complete Deliverable 11: Verified release candidate (`v0.1.0-rc.1`), full test suite pass (`npm run build`, `npm run validate`, `npm test`, `npm run test:integration`, Python harness tests, `analyze.py`), clean packaging audit (`RELEASE.md`)
- [x] **T2.2** Final sponsor summary report with repository links, evidence table, and approval requests for any external/upstream actions
- [x] **T2.3** Complete Stage 2 Materialized Export (`#2`: `content.wxr` + `wpai-state.json` + `MANIFEST.sha256` + `T5` token scanner) and Gate 3 MariaDB 10.11 + WordPress 7.1.5 Production Parity & Idempotency CI (`verify-probe.php`, `wpai verify-target`, `scripts/test-production-parity.mjs`, `.github/workflows/ci.yml`)

