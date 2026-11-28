# STATUS.md — Mission Status Log

## Checkpoint `v0.2.2` — Stage 2 Materialized Export & Gate 3 MariaDB Parity Complete (2026-11-28T08:15Z)

- **Stage 2 Hybrid Materialized Export (`#2`, `packages/wpai-cli/src/export.ts`):**
  - Boots Blueprints with `runPHP` / `runPHPWithOptions` / `importWxr` steps inside isolated WordPress Playground WASM (`@wp-playground/cli@3.1.66`) and extracts `content.wxr`, declarative `wpai-state.json` (allowlisted options, slug-based `page_on_front_slug` / `page_for_posts_slug`, non-admin editorial users without passwords, local media attachment & `_thumbnail_id` manifest, custom DB table guard), changed `wp-content/` files (excluding Playground SQLite drop-ins and core defaults), `MANIFEST.sha256` (`T2`), PHP SHA-256 inventory in `DEPLOY.md`, and `scanSecretTokens()` warnings (`T5`) — with **zero raw `runPHP` replay** on production.
  - Preserves offline `--mode static` (`exportForProduction`) and fail-safe preflight refusal on host-level untranslatable operations unless `--allow-partial` is passed.
- **Shared Verification Probe & Gate 3 MariaDB Production Parity CI (`packages/wpai-cli/src/php/verify-probe.php`, `scripts/test-production-parity.mjs`, `.github/workflows/ci.yml`):**
  - Extracted standalone `verify-probe.php` shared across `wpai verify` (Playground WASM) and `wpai verify-target` / `wp eval-file` (MySQL/MariaDB + live HTTP checks).
  - Live-verified all 6 presets (`small-business`, `commerce`, `publishing`, `nonprofit`, `course`, `migration`) end-to-end on real **MariaDB 10.11 + WordPress 7.1.5 (PHP 8.3 + Apache + WP-CLI)**: `6/6` passed `MANIFEST.sha256`, `setup.sh --dry-run`, `setup.sh --yes`, `verify-probe.php`, live Apache HTTP 200 checks (`/`, required pages, `/wp-json/...`), editorial authorship mapping, and second-run `setup.sh --yes` idempotency.
- **Full Verification Battery:** `41/41` Node unit tests + `npm run test:pack` + `9/9` live Playground integration tests + `6/6` MariaDB production parity & idempotency tests + `19/19` Python harness unit tests passing (`0` failures).

---

## Checkpoint `v0.2.0` — Tracks 1, 2, and 3 Complete (2026-11-26T14:07Z)

### Track 1: Bulletproof the Evidence (Complete)
- **Held-Out Prompt Suite:** Fetched all 16 unseen `apeatling/wp-agent-benchmark` Suite `0.4.0` prompts + unmodified fixtures (`editable-1`, `editable-3`, `docs-3`) into `benchmarks/prompts-heldout.json`.
- **Pre-Test OOD `evaluate-fit.mjs` Diagnostic (unmodified):** `15/16` (`93.8%`) — `9/10` suitable recall, `6/6` control specificity (`course-2` and `page-1` returned `needs_clarification`).
- **27-Run Held-Out + Condition D Study** (`benchmarks/results/runs-heldout.jsonl`, `summary-heldout.json`, symmetric build/test verification enabled):
  - **Condition A (Held-Out Baseline):** `0/6 (0.0%)` suitable WP, `3/3 (100.0%)` controls, `9/9` symmetric verified (`314.6s` mean).
  - **Condition C (Held-Out Skill + `wpai`):** `6/6 (100.0%)` suitable WP (`p = 0.00108`), `3/3 (100.0%)` controls, `9/9` verified (`225.7s` mean — **38.4% faster than Condition D**).
  - **Condition D (Held-Out Unprompted Discovery — 100% identical system prompt to Condition A, skill installed silently in `.agents/skills/`):** `6/6 (100.0%)` suitable WP (`p = 0.00108`), `3/3 (100.0%)` controls, `9/9` verified (`366.3s` mean).
- **Combined 63-Run Totals:** Baseline A `0/15 (0.0%)` vs Condition C `15/15 (100.0%)` vs Unprompted Condition D `6/6 (100.0%)`, with `100%` control specificity across all arms.
- **CLI Fix from Real Data:** Added sibling `wp-content/themes/*`, `wp-content/plugins/*`, and `wp-content/mu-plugins/` auto-mounting to `wpai verify`.

### Track 2: Staged Upstream Contributions (Refreshed & Ready for Sponsor Approval)
- Updated all 4 drafts in `upstream-drafts/` (`wordpress-agent-skills-pr.md`, `wp-agent-benchmark-pr.md`, `wordpress-llms-txt-proposal.md`, `publication-post-draft.md`) and `upstream-drafts/README.md` with the 63-run held-out + Condition D + symmetric verification evidence.
- **Governance Gate Respected:** Zero external PRs opened, zero visibility/license changes made without explicit sponsor approval.

### Track 3: Productize `wpai` (`v0.2.0`, Complete)
- **Native MCP Server (`wpai mcp`):** Zero-dependency JSON-RPC 2.0 over stdio server exposing 6 tools (`wpai_check_fit`, `wpai_catalog`, `wpai_init`, `wpai_validate`, `wpai_verify`, `wpai_export`) and 2 resources (`wpai://registry/capabilities`, `wpai://skill/platform-selection`).
- **Production Handoff Bridge (`wpai export`):** Extracts `wp-content/` themes/plugins/mu-plugins from blueprints + generates executable WP-CLI `setup.sh` and `DEPLOY.md` MySQL/managed-hosting checklist.
- **3 New Live-Verified Blueprint Presets:** `blueprints/nonprofit/`, `blueprints/course/`, and `blueprints/migration/` (all 6 presets validated and live-verified on WordPress `7.1.5` + PHP `8.3.36` + Abilities API).
- **Full Test Suite:** `25/25` Node unit tests + `6/6` blueprint validations + `19/19` Python harness unit tests passing (`0` failures).

---

## Checkpoint Final — `v0.1.0-rc.1` Release Candidate & 36/36 Experiments Complete (T+5.3h | 2026-11-26T13:00Z)

### Completed Deliverables (12/12 Complete)
1. **Upstream Technical Gap Analysis** (`docs/upstream-gap-analysis.md`): Audited all 7 upstream repos/docs + `wordpress.org/llms.txt`.
2. **Portable Platform-Selection Skill** (`skills/wp-platform-selection/`): `SKILL.md`, `references/decision-matrix.md`, `references/evidence-facts.md`, and `scripts/evaluate-fit.mjs` (12/12 accuracy across 9 suitable + 3 negative-control prompts).
3. **Machine-Readable Capability Registry** (`registry/wp-capabilities.json` + Draft 2020-12 JSON Schema): Validated via AJV.
4. **Minimal TypeScript CLI** (`packages/wpai-cli/`): Wraps pinned `@wp-playground/cli@3.1.66` (`init`, `validate`, `boot`, `verify`, `catalog`, `check-fit`, `validate-registry`, `--json`).
5. **Reproducible Blueprints** (`blueprints/small-business/`, `commerce/`, `publishing/`): Validated and live-verified on WordPress `7.1.5` + PHP `8.3.36` + SQLite + Abilities API (`WP_Ability`).
6. **Automated Verification Tests**: `19/19` Node unit tests + `4/4` live WordPress Playground integration tests + `19/19` Python harness unit tests passing (`0` failures).
7. **Benchmark Integration** (`benchmarks/`): 12 verbatim `Suite 0.4.0` prompts, unmodified `editable-2` fixture, ported `detect.py`, `wpab-integration/` Docker overlay, and schema-verified `benchmarks/results/wpab-choose-export.jsonl`.
8. **36 Controlled Experiments** (`benchmarks/results/runs.jsonl`, `summary.json`, `artifact-manifest.json`):
   - **Condition A (Baseline):** `0/9` (`0.0%`) suitable chose WordPress; `3/3` (`100.0%`) control specificity.
   - **Condition B (Skill + Registry):** `9/9` (`100.0%`, `+100.0 pp`, Fisher one-sided `p = 2.057e-05`) suitable chose WordPress; `3/3` (`100.0%`) control specificity; `8/9` (`88.9%`) live Playground verified (`B-business-3` failed at Blueprint step #16 with PHP exit code `255`).
   - **Condition C (Skill + Registry + `wpai`):** `9/9` (`100.0%`, `+100.0 pp`, Fisher one-sided `p = 2.057e-05`) suitable chose WordPress; `3/3` (`100.0%`) control specificity; `9/9` (`100.0%`) live Playground verified.
9. **Reproducible Documentation & CI**: `README.md`, `docs/architecture.md`, `.github/workflows/ci.yml`.
10. **Research Report** (`docs/research-report.md`): Complete quantitative & qualitative analysis + 10 explicit threats to validity / limitations.
11. **Tested Release Candidate** (`RELEASE.md`, tag `v0.1.0-rc.1`): Full test battery verified exit `0`.
12. **Draft Upstream Contributions** (`upstream-drafts/`): `wordpress-agent-skills-pr.md`, `wp-agent-benchmark-pr.md`, `wordpress-llms-txt-proposal.md`, and `publication-post-draft.md` staged locally (**unsubmitted**).

### Current Tasks
- Mission deliverables complete ahead of the `2026-11-29T07:42:25Z` deadline; awaiting sponsor review.

### Evidence & Repository Links
- Repository: `https://github.com/patilswapnilv/wp-agent-experience`
- Release Tag: `v0.1.0-rc.1`
- Empirical Data: `benchmarks/results/runs.jsonl`, `benchmarks/results/summary.json`, `docs/research-report.md`


### Blockers
- None blocking release.

### Next Milestone
- Optional sponsor-approved external actions (see below).

### Decisions Required from Sponsor (Optional)
1. **Upstream Submissions:** Approve if you would like any of the 4 staged drafts in `upstream-drafts/` submitted to `WordPress/agent-skills`, `apeatling/wp-agent-benchmark`, or `make.wordpress.org/ai`.

---

## Checkpoint 0 — Mission Launch & Environment Verification (T+0h | 2026-11-26T07:47Z)

### Completed Deliverables
- Environment audit completed (`ENVIRONMENT.md`): Node v22.23.5, npm 12.2.2, pnpm 12.21.0, Python 3.12.16, PHP 8.3.6, Git, GitHub CLI (`patilswapnilv`), full network access to GitHub, npm, and WordPress.org.
- Initial upstream repository reconnaissance completed across all 5 GitHub repositories (`apeatling/wp-agent-benchmark`, `WordPress/agent-skills`, `WordPress/wordpress-playground`, `WordPress/mcp-adapter`, `WordPress/wp-bench`) plus `developer.wordpress.org/apis/abilities-api/`, `make.wordpress.org/ai/`, and `wordpress.org/llms.txt`.
- Key upstream baseline confirmed: `apeatling/wp-agent-benchmark` October 2026 batch (`Suite 0.4.0`, 287 runs, 7 frontier agents) shows **0/197 (0.0%)** WordPress selection on WordPress-suitable tasks; `WordPress/agent-skills` has 20 skills and **zero** platform-selection skills.
- Persistent state files initialized.
