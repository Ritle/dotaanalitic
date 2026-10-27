# Текущее состояние репозитория — Codex handoff

**Версия комплекта:** v9 — Data Integrity specification on top of v8. **Функциональный MVP ещё не реализован.**

## Реально присутствует

- Vue 3 техническая оболочка (не драфт/статистика), Fastify `/health` (не Auth/API продукта).
- SQL 001–005 как исходные файлы, checksum-инвариант и мигратор; фактическое применение DB здесь **не проверялось**.
- Синтетические fixtures, node fixture-tests, Vitest golden tests для аналитических чистых функций; Python bootstrap train/evaluate с запретом применения синтетики в production.
- Валидация temporal cutoff/series splits/confirmed outcome, Python/JS golden parity для logistic.
- CI unit/DB/ML, Playwright bootstrap smoke, production compose/Dockerfiles/backup-restore *как подготовленные конфигурации, ещё не запущенные*.

## Ограничения сборки комплекта

- В среде подготовки нет доступа к npm registry, pnpm и Docker/PostgreSQL. `pnpm-lock.yaml` **не включён**. Сначала создать/закоммитить реальный lockfile; до этого CI и Docker build преднамеренно не проходят.
- Нет OpenDota collector, Auth, real-case fixtures/API endpoints кроме `/health`, реальной train pipeline / модельной активации, полноценного интерфейса.
- Train demo использует **только синтетические исходы и признаки**; `deployable:false` и `synthetic_only:true`.

## Следующая задача

**S0-00:** на машине с сетевым доступом и Docker установить зависимости, зафиксировать `pnpm-lock.yaml`, мигрировать чистый PostgreSQL, запустить integration/e2e, при необходимости исправить выявленные проблемы в **новой** миграции, не переписывая 001–005.

Затем S0-01 — настоящий OpenDota provider spike со статусом полноты полей и договорённостью об условиях использования.

## v9 — draft data integrity specification (не код основного импортера)

- Учтены пользовательские результаты live аудита 50 недавних pro-карт и аномалии raw `picks_bans`.
- Добавлены `docs/DRAFT_DATA_INTEGRITY.md`, миграция 006, расширенный auditor schema v2, синтетические регрессии, правила в AGENTS и этапы S0-10/QA-04.
- Проверены Node regression tests и синтетический аудит; **не** проверены live v9 аудит, PostgreSQL миграция 006 или реальные процессы импортера. Исходные миграции 001–005 сохранены.
- Первая задача Codex остаётся S0-00 / DX-00. S0-10 выполнять при S0-02, до публикации предиктивных моделей.
