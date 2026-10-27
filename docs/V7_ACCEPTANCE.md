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
