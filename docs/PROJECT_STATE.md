# Текущее состояние репозитория — Codex handoff

**Обновлено:** 2026-10-30. Комплект v9; S0-00 / DX-00 проверены локально. **Функциональный MVP ещё не реализован.**

## Реально присутствует

- Vue 3 техническая оболочка (не драфт/статистика), Fastify `/health` (не Auth/API продукта).
- SQL 001–006 применены на чистом нативном PostgreSQL 16.15; повторный запуск — шесть SKIP. Хэши 001–005 совпадают с golden; содержимое SQL не изменено, LF закреплён через `.gitattributes`.
- Синтетические fixtures, node fixture-tests, Vitest golden tests для аналитических чистых функций; Python bootstrap train/evaluate с запретом применения синтетики в production.
- Валидация temporal cutoff/series splits/confirmed outcome, Python/JS golden parity для logistic.
- Локально PASS: frozen install, preflight с DB, typecheck, 26 Vitest + 10 Node + 4 PostgreSQL + 6 Python тестов, build, health smoke, Chromium E2E (1), Python/JS parity (12). Экран визуально проверен, ошибок страницы нет.
- CI unit/DB/ML/E2E команды сверены с локальными запусками; удалённый GitHub Actions, production compose/Dockerfiles/backup-restore ещё не выполнялись.

## Ограничения сборки комплекта

- `pnpm-lock.yaml` с registry integrity создан pnpm 10.19.0 и проверен frozen install. Испытаны Node 22.15.0 и Python 3.11.9 в изолированной `.venv`.
- Docker/Compose отсутствуют: контейнерный запуск/production build не проверены. Для S0-00 использован настоящий PostgreSQL 16.15 из EDB ZIP, localhost-only + SCRAM; это не тест Docker. Подробности и команды: [S0_00_VERIFICATION](S0_00_VERIFICATION.md).
- Нет OpenDota collector, Auth, real-case fixtures/API endpoints кроме `/health`, реальной train pipeline / модельной активации, полноценного интерфейса.
- Train demo использует **только синтетические исходы и признаки**; `deployable:false` и `synthetic_only:true`.

## Следующая задача

**S0-01:** настоящий OpenDota provider spike со статусом полноты полей и договорённостью об условиях использования. В рамках S0-00 не начинался; сохранять known-at/source evidence и границы профессиональных карт.

## v9 — draft data integrity specification (не код основного импортера)

- Учтены пользовательские результаты live аудита 50 недавних pro-карт и аномалии raw `picks_bans`.
- Добавлены `docs/DRAFT_DATA_INTEGRITY.md`, миграция 006, расширенный auditor schema v2, синтетические регрессии, правила в AGENTS и этапы S0-10/QA-04.
- Проверены Node regression tests; при S0-00 миграция 006 и её immutable/composite FK ограничения проверены на PostgreSQL. Live v9 аудит и реальные процессы импортера в S0-00 не проверялись. Исходные миграции 001–005 сохранены.
- Следующая задача S0-01. S0-10 выполнять при S0-02, до публикации предиктивных моделей.
