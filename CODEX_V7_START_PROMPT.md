# Первый промпт для Codex — v7 DX/QA

Проверь корень проекта и `AGENTS.md`, прочитай `docs/PROJECT_STATE.md`, `docs/DEVELOPMENT_PREFLIGHT.md` и только раздел S0-00 в `docs/IMPLEMENTATION_PLAN.md`. Это v7 инженерный каркас, **не законченный MVP**.

Начни с `git status`, Node/pnpm/Docker/PostgreSQL наличия. Сначала **сгенерируй реальный** `pnpm-lock.yaml` посредством `pnpm install` на машине с доступом к npm registry и **не редактируй вручную**. Затем `pnpm install --frozen-lockfile`, `pnpm verify:migrations`, `pnpm verify:docs`, `pnpm test:fixtures`, `pnpm db:up`, `pnpm db:migrate` дважды, `pnpm test:integration`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`. Прогони ML bootstrap по `docs/MODEL_VALIDATION.md`.

Если найдёшь SQL/TS/compose несовместимость, исправляй минимальными патчами с тестами; миграции 001–006 **не изменять**, любое новое поведение БД — 007+.

Не запускать реальные запросы к OpenDota, пока не начата S0-01 и не проверены API quotas/условия. Синтетический logistic candidate помечен `deployable:false`; никогда не подключай его в production/API. Не выдумывай успех отсутствующих тестов. После работы обнови `docs/PROGRESS.md`, `docs/PROJECT_STATE.md`, сообщи PASS/FAIL/BLOCKED и следующие шаги.
