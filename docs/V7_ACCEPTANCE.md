# v7 acceptance checklist — DX / QA components

| Component | Prepared | Executed in generation environment | Remaining release gate |
|---|---|---|---|
| Preflight + migration checksum checks | yes | Node checks PASS | real pnpm lock & DB |
| Synthetic fixtures + Node golden tests | yes | Node tests PASS | Vitest after install |
| Vitest TypeScript golden/model tests | yes | not run (npm blocked) | `pnpm test` |
| SQL integration tests + CI PostgreSQL service | yes | not run (Docker/pg absent) | run against PG16 |
| Python ML training/validation | yes | pytest/train/eval PASS | real frozen dataset later S3 |
| Python↔JS logistic parity | yes | PASS (synthetic) | TS Vitest parity after install |
| Playwright E2E scaffold/bootstrap | yes | not run (browsers/npm blocked) | chromium CI execution |
| Personal VPS compose/Caddy/Dockerfiles | yes | not run (Docker absent) | production smoke/security gate |
| Backup and staging restore scripts | yes | shell syntax available | restore drill staging |
| Work handoff / PROJECT_STATE / plan | yes | document checks | real Codex handoffs |
| UI tokens + design system contracts | yes | files written | full UI stages S1–S2 |
| Provider coverage/monitoring contracts | yes | documents written | real importer S0-01+ |

**This is a starter engineering kit, not a complete statistical/ML product.** No marketing of 70% win probability before independently validated training and accurate sources.

## Local bootstrap verification — 2026-10-30

The table above records the original generation environment. S0-00 subsequently executed frozen install, migration checksum checks, typecheck, build, 26 Vitest tests, 10 Node fixture tests, 4 PostgreSQL integration tests, 6 Python tests, 12 Python/JS parity comparisons and 1 Chromium E2E test: all PASS. SQL 001–006 applied to a fresh native PostgreSQL 16.15 database and a second run skipped all six. Preflight with actual DB connectivity and HTTP health smoke passed; the rendered Russian technical shell was visually checked.

Docker/Compose, production images, remote GitHub Actions and restore drills remain unexecuted; native PostgreSQL verification is not container verification. See [S0-00 evidence and restart commands](S0_00_VERIFICATION.md). No production model or provider collector was implemented.
