## Summary

<!-- Briefly describe what this PR changes and why. -->

## Linked Issue(s)

<!-- Example: Fixes #123, Related to #2 -->

## Type of Change

- [ ] Bug fix (`fix:`)
- [ ] New feature (`feat:`)
- [ ] Blueprint preset or verification contract
- [ ] Security hardening (see `docs/export-security-and-parity.md`)
- [ ] Documentation / DX (`docs:`)
- [ ] Benchmark / evaluation (`exp:`)

## Checklist

- [ ] **Base branch is `develop`** (do not target `main` directly; `main` is updated via `develop` → `main` release PRs)
- [ ] `npm run build` succeeds cleanly
- [ ] `npm run validate` passes (capability registry + all blueprints)
- [ ] `npm test` passes (all Node unit tests)
- [ ] `npm run test:pack` passes (standalone tarball smoke test, if `packages/wpai-cli/` changed)
- [ ] Python harness tests pass (`python3 -m unittest discover -s benchmarks/harness -p 'test_*.py' -v`, if `benchmarks/` changed)
- [ ] Added or updated tests covering the change
- [ ] No credentials, `.env` secrets, or fabricated benchmark data committed
