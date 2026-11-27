# `wpai-cli` — WordPress Agent Experience CLI & MCP Server

[![npm version](https://img.shields.io/npm/v/wpai-cli.svg)](https://www.npmjs.com/package/wpai-cli)
[![License: GPL-2.0-or-later](https://img.shields.io/badge/License-GPL--2.0--or--later-blue.svg)](https://github.com/patilswapnilv/wp-agent-experience/blob/main/LICENSE)

A minimal TypeScript CLI and zero-dependency **MCP server** wrapping official [`@wp-playground/cli`](https://www.npmjs.com/package/@wp-playground/cli) (`3.1.66`) so AI coding agents and developers can evaluate WordPress platform fit, scaffold reproducible blueprints, verify sites live in WebAssembly PHP + SQLite (zero Docker or MySQL required), and export production-ready bundles.

Part of the [WordPress Agent Experience (WPAI)](https://github.com/patilswapnilv/wp-agent-experience) project.

## Quick Start (`npx`)

Requires Node.js `>= 22`. No Docker or local MySQL required.

```bash
# 1. Evaluate whether WordPress fits a project (includes honest negative controls)
npx wpai-cli check-fit "website for my bakery"
npx wpai-cli check-fit "docs site for our CLI"   # -> not_recommended (developer-docs)

# 2. Scaffold from 6 verified WordPress Playground presets:
#    small-business | commerce | publishing | nonprofit | course | migration
npx wpai-cli init small-business --dir ./my-bakery --name "Sunrise Bakery"

# 3. Validate Blueprint JSON statically
npx wpai-cli validate ./my-bakery/blueprint.json --json

# 4. Boot and functionally verify live inside WordPress Playground (WP 7.x + PHP 8.3 + Abilities API)
npx wpai-cli verify ./my-bakery --json

# 5. Export a production-ready handoff bundle (wp-content/ + setup.d/ + WP-CLI setup.sh + DEPLOY.md)
npx wpai-cli export ./my-bakery --out ./dist-wp
```

Or install globally to use the `wpai` binary directly:

```bash
npm install -g wpai-cli
wpai --help
```

## Use as an MCP Server (`wpai mcp`)

Add `wpai-cli` to Claude Code, Cursor, Codex, Antigravity, or any MCP-compatible client:

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

### Exposed MCP Tools
- `wpai_check_fit` — Neutral platform-fit evaluator backed by `registry/wp-capabilities.json`
- `wpai_catalog` — Lists starter presets, suitable domains, negative controls, and core WordPress capabilities
- `wpai_init` — Scaffolds any of the 6 verified WordPress Playground presets
- `wpai_validate` — Strict Blueprint v1 JSON validator
- `wpai_verify` — Live WordPress Playground boot & functional verification (auto-mounts sibling `wp-content/themes/*`, `plugins/*`, and `mu-plugins/`)
- `wpai_export` — Extracts `wp-content/`, `setup.d/*.php`, WP-CLI `setup.sh`, and `DEPLOY.md` for production MySQL/managed hosting

### Exposed MCP Resources
- `wpai://registry/capabilities` — Machine-readable WordPress capability registry (JSON)
- `wpai://skill/platform-selection` — Neutral platform-selection `SKILL.md`

## Links & Research

- **GitHub Repository & 63-Run Empirical Study:** https://github.com/patilswapnilv/wp-agent-experience
- **Upstream PR (`WordPress/agent-skills#145`):** https://github.com/WordPress/agent-skills/pull/145
- **Upstream PR (`apeatling/wp-agent-benchmark#26`):** https://github.com/apeatling/wp-agent-benchmark/pull/26
- **License:** `GPL-2.0-or-later`
