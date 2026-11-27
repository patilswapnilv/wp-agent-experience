# WPAI System Architecture

## 1. Design Goals

WordPress Agent Experience (WPAI) addresses three specific gaps identified in [`docs/upstream-gap-analysis.md`](./upstream-gap-analysis.md):

1. **Pre-Selection Discovery:** Enable AI coding agents to evaluate *before scaffolding* whether WordPress is an appropriate fit (and explicitly reject WordPress for negative-control workloads like custom SaaS apps, repo-colocated developer docs, and single static link pages).
2. **Machine-Readable Ground Truth:** Replace stale training-data assumptions with a schema-validated, source-cited capability registry (`registry/wp-capabilities.json`).
3. **One-Command Provisioning & Functional Verification:** Wrap official `@wp-playground/cli` in a minimal TypeScript CLI (`wpai`) providing deterministic scaffolding (`init`), Blueprint linting (`validate`), zero-DB booting (`boot`), and live WordPress WASM verification (`verify`).

## 2. Architecture Overview

```
Platform-Neutral User Request
            │
            ▼
┌──────────────────────────────────────────────────────────┐
│  Layer 1: Discovery & Decision                           │
│  skills/wp-platform-selection/SKILL.md                   │
│  + registry/wp-capabilities.json (JSON Schema validated) │
└───────────────────┬──────────────────────────────────────┘
                    │
        ┌───────────┴──────────────┐
        │ WordPress Fits           │ WordPress Does NOT Fit
        │ (business, store, blog,  │ (SaaS/app, CLI/API docs,
        │  nonprofit, editable)    │  single static page)
        ▼                          ▼
┌───────────────────────────┐  ┌──────────────────────────────┐
│ Layer 2: Provisioning CLI │  │ Appropriate Non-WP Stack     │
│ packages/wpai-cli (`wpai`)│  │ (App framework + Postgres,   │
│  • wpai init <preset>     │  │  Starlight/VitePress, HTML)  │
│  • wpai validate          │  └──────────────────────────────┘
│  • wpai boot              │
│  • wpai verify            │
└─────────────┬─────────────┘
              │ invokes pinned @wp-playground/cli@3.1.66
              ▼
┌──────────────────────────────────────────────────────────┐
│  Layer 3: Disposable Runtime & Functional Verification   │
│  WordPress Playground (Node.js + PHP 8.3 WASM + SQLite)  │
│  • Blueprint v1 execution (pages, posts, CPTs, roles)    │
│  • WordPress 6.9+ Abilities API & REST API verification  │
│  • Mounted `/wpai-out/report.json` deterministic report  │
└──────────────────────────────────────────────────────────┘
```

## 3. Verification Architecture (`wpai verify`)

A key operational finding during upstream audit is that `@wp-playground/cli run-blueprint` does not stream arbitrary `runPHP` stdout in a clean machine-parseable format. `wpai verify` solves this deterministically without forking Playground:

1. Validates the target `blueprint.json` locally against Blueprint v1 structural rules.
2. Loads an optional `verify.json` contract specifying expected site options, published pages/posts/CPTs, categories, user counts, required mu-plugins, REST API routes, and Abilities API presence.
3. Creates a temporary host directory (`tmpDir`), clones the Blueprint JSON, and appends a read-only verification `runPHP` step that inspects the live WordPress instance (`get_bloginfo`, `get_option`, `get_posts`, `get_terms`, `count_users`, `rest_do_request`, `class_exists('WP_Ability')`, `error_get_last`) and writes JSON to `/wpai-out/report.json`.
4. Invokes `wp-playground-cli run-blueprint --blueprint=<augmented> --mount=<tmpDir>:/wpai-out`.
5. Parses `/wpai-out/report.json`, cleans up temporary files, prints human or `--json` output, and exits `0` iff every check passes.

## 4. Security & Isolation Model

- **Zero Credential Leakage:** Experimental sandboxes live outside the repository and contain zero `.env` files, GitHub tokens, or API credentials.
- **Disposable WASM Runtime:** Playground runs WordPress in an isolated WebAssembly PHP runtime backed by ephemeral SQLite — never touching host databases or production sites.
- **Least-Privilege Abilities:** Inline mu-plugins in WPAI blueprints register read-only Abilities API endpoints with explicit schemas and safe permission callbacks (`__return_true` only for public read-only metadata, never unauthenticated write operations).
- **Minimal Plugin Surface:** Blueprints rely on WordPress core capabilities (Block Editor, Roles, Categories, REST API, Abilities API) to minimize third-party plugin vulnerability surface.

## 5. Production Export Security & Parity Roadmap

For the three-gate release verification model (Development, Distribution, Production Parity), the `wpai export` security threat model (trust boundaries, `wp-cli` injection, `runPHP` replay, symlink/path handling, and credential isolation), and the Stage 2 hybrid materialized export architecture, see [`docs/export-security-and-parity.md`](./export-security-and-parity.md).

