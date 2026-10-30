# Текущее состояние репозитория — Codex handoff

**Обновлено:** 2026-10-30. Комплект v9; S0-00 / DX-00 и S0-01 проверены локально. **Функциональный MVP ещё не реализован.**

## Реально присутствует

- Vue 3 техническая оболочка (не драфт/статистика), Fastify `/health` (не Auth/API продукта).
- SQL 001–006 применены на чистом нативном PostgreSQL 16.15; повторный запуск — шесть SKIP. Хэши 001–005 совпадают с golden; содержимое SQL не изменено, LF закреплён через `.gitattributes`.
- Синтетические fixtures, node fixture-tests, Vitest golden tests для аналитических чистых функций; Python bootstrap train/evaluate с запретом применения синтетики в production.
- Валидация temporal cutoff/series splits/confirmed outcome, Python/JS golden parity для logistic.
- Локально PASS: frozen install, preflight с DB, typecheck, 26 Vitest + 10 Node + 4 PostgreSQL + 6 Python тестов, build, health smoke, Chromium E2E (1), Python/JS parity (12). Экран визуально проверен, ошибок страницы нет.
- CI unit/DB/ML/E2E команды сверены с локальными запусками; удалённый GitHub Actions, production compose/Dockerfiles/backup-restore ещё не выполнялись.
- S0-01: server-side OpenDota client + Zod schemas + bounded CLI, 5 обезличенных synthetic test projections реальных форм ответов. Live audit — 20/20 detailed responses; typed spike — 3 карты/team/roster/player, 7 requests. Новый PASS: frozen install/typecheck/build, 54 Vitest (28 provider), 10 Node, 4 DB, docs/checksums/health. [Отчёт и границы](S0_01_PROVIDER_SPIKE.md).

## Ограничения сборки комплекта

- `pnpm-lock.yaml` с registry integrity создан pnpm 10.19.0 и проверен frozen install. Испытаны Node 22.15.0 и Python 3.11.9 в изолированной `.venv`.
- Docker/Compose отсутствуют: контейнерный запуск/production build не проверены. Для S0-00 использован настоящий PostgreSQL 16.15 из EDB ZIP, localhost-only + SCRAM; это не тест Docker. Подробности и команды: [S0_00_VERIFICATION](S0_00_VERIFICATION.md).
- Нет durable OpenDota collector/importer, Auth, продуктовых API endpoints кроме `/health`, production train pipeline / модельной активации, полноценного интерфейса. Provider boundary/CLI и обезличенные live-shape fixtures уже присутствуют; они не являются импортом в БД.
- Клиент ограничивает один instance/run (<=45/min, 25 attempts для CLI); durable общие дневные/месячные квоты остаются S0-02. S0-08/09 не закрыты: нет исторической стратификации, verified known-as-of, patch rule registry или достаточного model gate.
- Train demo использует **только синтетические исходы и признаки**; `deployable:false` и `synthetic_only:true`.

## Следующая задача

**S0-02:** идемпотентный импорт + происхождение, durable worker/provider quota; включить связанные raw-draft/quality-policy контракты S0-10. Использовать S0-01 provider boundary, не превращать discovery в `is_pro=true` без проверенной классификации. Рекомендуемая модель: **GPT-6.1 Sol · High**.

## v9 — draft data integrity specification (не код основного импортера)

- Учтены пользовательские результаты live аудита 50 недавних pro-карт и аномалии raw `picks_bans`.
- Добавлены `docs/DRAFT_DATA_INTEGRITY.md`, миграция 006, расширенный auditor schema v2, синтетические регрессии, правила в AGENTS и этапы S0-10/QA-04.
- Проверены Node regression tests; при S0-00 миграция 006 и её immutable/composite FK ограничения проверены на PostgreSQL. Live v9 аудит и реальные процессы импортера в S0-00 не проверялись. Исходные миграции 001–005 сохранены.
- S0-01 непосредственно повторил v9 recent coverage audit и сохранил public evidence; он не является историческим/модельным gate. Следующая задача S0-02; S0-10 выполнять при ней, до публикации предиктивных моделей.
