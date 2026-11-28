# Security Policy

## Supported Versions

Security fixes are applied to the latest `0.2.x` release line of `wpai-cli` on `main` (staged via `develop`).

| Version | Supported |
|---|---|
| `0.2.x` | Yes |
| `< 0.2.0` | No |

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security issue in `wpai-cli`, the MCP server, `wpai export`, or bundled Blueprints:

1. Use GitHub's **Private Vulnerability Reporting** ("Report a vulnerability" under the **Security** tab of [`patilswapnilv/wp-agent-experience`](https://github.com/patilswapnilv/wp-agent-experience/security/advisories/new)), **or**
2. If private advisories are unavailable, open a minimal contact request without exploit details and we will arrange a private channel.

Please include:
- Affected component and version (`wpai --version` or commit SHA)
- Minimal reproduction steps or proof-of-concept Blueprint
- Impact assessment (e.g., command injection, path traversal, credential exposure)

We aim to acknowledge reports within **48 hours** and provide a fix timeline within **5 business days**.

---

## Security Architecture & Known Threat Model

WPAI documents its explicit trust boundaries and `wpai export` threat catalog (`T1`–`T7`) in [`docs/export-security-and-parity.md`](./docs/export-security-and-parity.md), covering:
- **T1:** Shell command injection & unsafe WP-CLI global flags in `wp-cli` Blueprint steps
- **T2:** Untrusted PHP execution (`runPHP` replay & inline `writeFile` PHP)
- **T3:** Path traversal & symlink escape during bundle export
- **T4:** WP-CLI option/flag injection via plugin/theme slugs
- **T5:** Credential & sensitive file leakage (`wp-config*.php`, `.env`, `*.sql`, `debug.log`)
- **T6:** Untrusted `process.cwd()` asset shadowing (mitigated in `v0.2.2`)
- **T7:** Unauthorized production mutation (offline bundle-only export + `--dry-run` / confirmation roadmap)
