# Текущее состояние репозитория — Codex handoff

**Обновлено:** 2026-10-31. S0-00/DX-00, S0-01, S0-02 + S0-10 и **S0-03** выполнены локально. **Функциональный MVP ещё не готов.** Рабочий Git checkout — `dotaanalitic`; родительский starter не редактировать.

## Реально присутствует

- Vue 3 login/loading/error/logout, router guard и личная оболочка. Fastify health и auth login/me/logout; аналитические страницы/API ещё planned.
- CLI `owner:create`/`owner:reset`: единственный owner, hidden password/UTF-8 stdin, Argon2id; reset отзывает все сессии. Аккаунт владельца в рабочей БД не создавался автоматически, пароль задаёт владелец.
- DB opaque sessions: только SHA-256 tokens, TTL 12h, rotation/revocation/expiry/inactive checks. Cookies Secure/HttpOnly/host prefix в HTTPS production; local HTTP cookies только для loopback origin. CSRF session-bound, exact Origin, per-IP + restart-safe global PG login budget, no secret logging.
- PostgreSQL 16.15 native localhost/SCRAM; 001–008 применены, повтор 8 SKIP. 001–007 не редактировались в S0-03, 001–005 golden сохранены; следующая миграция 009+.
- Shared `@dota/db` pg/Kysely 0.28.18, `@dota/ingestion`, `@dota/worker` pg-boss 12.38.0. `@dota/contracts` теперь compiled dist/declarations для API/web; root shared:build и filtered Docker builds учитывают contracts dependency.
- Import: per-map lock/idempotency, immutable provenance/raw/quality, durable Retry-After, global PG quotas. Raw 0/11/12 picks сохранены, draft_order_valid/patch/known_at/verified roles не угадываются. Canonical identities только verified account links.
- Live S0-01: 20-map recent coverage ([отчёт](S0_01_PROVIDER_SPIKE.md)). Live S0-02: карта `9069021061` дважды через очередь, одна карта/10 slots/revision 1; canonical IDs 0/10, historic availability не подтверждена ([отчёт](S0_02_INGESTION.md)).
- S0-03 PASS: frozen install/typecheck/build; 66 unit + 11 auth PG/CLI + 16 ingestion/queue PG + 4 baseline DB + 10 Node + 2 Chromium tests. Visual mobile/desktop checked; migrations/checksums, strict preflight DB (Docker WARN), compiled Node health=200/private me=401. [Отчёт S0-03](S0_03_OWNER_AUTH.md).
- S0-00 ранее: 6 Python tests и 12 Python↔JS parity comparisons; в S0-03 не повторялись. Demo остаётся synthetic_only/deployable:false, production models 0.

## Запуск и ограничения

- Frozen install, `pnpm db:migrate`, `pnpm owner:create`, `pnpm dev`. Открывать web точно по WEB_ORIGIN (обычно http://localhost:5173), не менять hostname на 127.0.0.1 без согласованной настройки.
- Production требует HTTPS WEB_ORIGIN и случайный AUTH_COOKIE_SECRET >=32 символов. В development без secret CSRF signing key process-local; DB session остаётся, после рестарта reload/me перевыпускает CSRF.
- Root-команды явно собирают shared packages. `pnpm test:auth`, `test:ingestion`, `test:e2e` требуют PG16/CREATEDB; synthetic owners/maps живут только в отдельных temporary test DB, затем cleanup. Browser E2E использует API/Vite 3151/5179 и случайный synthetic password, без mocks/записи в рабочую БД.
- Provider defaults 45 RPM/2000 day/45000 month, shared PG UTC budget; live spike/audit требуют DB/007. `.env`, `.tools`, browser artifacts и passwords не коммитятся.
- Node 22.15.0, pnpm 10.19.0; Argon2 Windows bundled native prebuild исполнен. Docker/Compose отсутствуют: production images/TLS/restore и remote CI не проверены. CI/Compose подготовлены, это не deployment gate. Push/deploy не выполнялись.
- Нет bulk/backfill scheduler, полного identity/context/patch resolver, production training/activation или вероятностей. Accepted import не равен model eligibility. S0-08/09 и temporal/ML gates открыты.

## Следующая задача

**S0-04 [P0] Point-in-time schema / temporal semantics.** Читать POINT_IN_TIME_AND_MATCH_CONTEXT и текущие provenance/match field observations; отличать event/start, known_at, fetched_at, map/series/side и stage-specific availability. Backfill завершённой карты не подтверждает pre-start lineup knowledge. Рекомендуемая модель: **GPT-6 Astra · High**.
