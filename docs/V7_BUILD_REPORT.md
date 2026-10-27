# Фактически выполненные проверки при подготовке v7

Дата сборки: 2026-10-27. Относится **только к инженерному комплекту**, а не к полнофункциональному сервису.

| Команда / проверка | Результат |
|---|---|
| `node --test tests/node/*.test.mjs` | PASS: 4/4 |
| `node scripts/verify-migrations.mjs` | PASS: 001–005 совпадают с v6 по SHA256 |
| `node scripts/check-doc-links.mjs` | PASS |
| `node --check` для `.mjs` скриптов и интеграционного теста | PASS |
| `bash -n scripts/*.sh` | PASS |
| `tsc --noEmit --target ES2022 --module ESNext --strict packages/analytics/src/model-inference.ts` | PASS: изолированный scorer |
| `PYTHONPATH=tools/ml python -m pytest tools/ml/tests -q` | PASS: 6/6 |
| Demo training на синтетике + `tools/ml/evaluate.py` | PASS; `synthetic_only=true`, `deployable=false` |
| `node scripts/check-ml-parity.mjs` | PASS: Python ↔ JS на 12 примерах |
| Синтаксическая проверка YAML/TOML/JSON | PASS |
| `pnpm install --frozen-lockfile`, `pnpm typecheck/test/build` | **BLOCKED**: нет сети к npm registry и отсутствует реальный lockfile |
| PostgreSQL 16 migrations/integration tests | **BLOCKED**: нет Docker/Postgres в среде подготовки |
| Playwright Chromium e2e | **BLOCKED**: нет node_modules/browser runtime |
| Production Docker build + HTTPS smoke / backup-restore drill | **BLOCKED**: Docker отсутствует; Auth не реализована |

Обязательное действие владельца/ Codex на сетевой машине: `node scripts/bootstrap-lockfile.mjs`, затем `pnpm install --frozen-lockfile`; прогнать весь S0-00 по `CODEX_V7_START_PROMPT.md`. Успех в CI нельзя предполагать до фактического зелёного запуска.
