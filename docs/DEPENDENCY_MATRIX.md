# Dependency Matrix / Порядок внедрения пакетов

Этот файл — **план зависимостей, а не утверждение об установке**. Версии ниже по совместимым major-поколениям; при первом `pnpm install` необходимо разрешить реальные peerDependencies, зафиксировать итоговый `pnpm-lock.yaml` и настроить CI. Нельзя бездумно обновлять `package.json` до нового major только из-за выхода релиза.

| Где | Пакет | Зачем | Когда / тест совместимости |
|---|---|---|---|
| root | `typescript` | strict TS project references | Уже в starter; S0-00 проверка build |
| root | `vitest` | deterministic unit/integration runner | Уже в starter; S0-00 версия должна совпадать с поддерживаемым Vite |
| api | `fastify` 5 | HTTP server | Уже в starter; route `inject` |
| api/contracts | `zod` 4 | DTO/runtime validation | Уже в starter; provider schemas, unknown/null contract |
| api | `@fastify/type-provider-zod` | Совместить Fastify route types и Zod | Внедрять только после проверки Zod 4.x совместимости на `pnpm` и минимальном API test |
| api | `@fastify/cookie` | Owner session cookie | S0-03; HttpOnly/Secure/SameSite tests |
| api | `@fastify/csrf-protection` | CSRF при cookie-auth | S0-03; POST без токена/с неправильным token = 403 |
| api | `@fastify/rate-limit` | Ограничение логинов | S0-03; совместимый Fastify5 plugin major |
| api | `argon2` | password Argon2id | S0-03; нативная установка на Ubuntu/Windows CI |
| db | `pg` 8 | SQL driver | Уже в root starter; migrations and pool test |
| db | `kysely` | Typed select/joins/transactions | S0-02; SQL migration authority remains manually written `.sql` |
| worker | `pg-boss` | Durable scheduled/import jobs | S0-02; at-least-once, restart, dedup test; own schema lifecycle |
| web | `@tanstack/vue-query` | Cache and async fetch | S1-01; queryKey, invalidate after mutate |
| web | `echarts`, `vue-echarts` | Timelines/calibration/graphs | On first analytics visualization (S1/S3), lazy load |
| web | `@vue/test-utils` | Component tests | S1/S2 |
| root e2e | `@playwright/test` | E2E scenario | S4-02 |
| python offline | `numpy`, `pandas`, `scikit-learn` | Training and evaluation | S3-03; independent venv/lockfile or pinned requirements with hashes |
| python optional | `catboost` | Challenger (not baseline) | **P1+**, only after temporal evidence |

## Package policy

1. `pnpm-lock.yaml` committed after first successful resolve; CI always `pnpm install --frozen-lockfile`.
2. Prefer adding package to correct workspace (`pnpm --filter @dota/api add ...`), not root, except build tooling. New `apps/worker` package declared before installing its deps.
3. Frontend bundle budget and ECharts lazy-loading are CI review points. Backend data structures must validate at runtime rather than trust TS types.
4. Do not use both `@fastify/type-provider-zod` and `fastify-type-provider-zod` simultaneously; pick one tested integration.
5. One DB schema ownership: forward-only `.sql` scripts. Kysely type generation is descriptive and must be kept in sync; it does **not** apply DDL.
6. Keep Python dependencies isolated from pnpm; run training offline (subprocess/CLI) with versioned manifest. Do not call a Python model server per request for initial MVP.
7. If package cannot be installed or plugin requires incompatible versions, Codex must record blocker and test, not silently swap core framework.

## Links to vendor documentation

- https://fastify.dev/docs/latest/Reference/Type-Providers/
- https://github.com/fastify/fastify-rate-limit
- https://tanstack.com/query/latest/docs/framework/vue/overview
- https://kysely.dev/docs/getting-started
- https://pgboss.io/introduction
- https://www.npmjs.com/package/%40fastify%2Ftype-provider-zod
