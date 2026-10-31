# Проверки перед началом работы / S0-00

## Подготовка

1. Node.js >=22.12.0; Corepack, pnpm **10.19.0**; PostgreSQL 16 через Docker + Compose или нативно; Python 3.11–3.13 для ML-тестов.
2. `corepack enable`. Настоящий `pnpm-lock.yaml` уже создан из registry при S0-00. `node scripts/bootstrap-lockfile.mjs` нужен только при отсутствии lockfile; ручная генерация запрещена. Для Windows без прав записи в Program Files см. [локальные shims](S0_00_VERIFICATION.md).
3. `corepack pnpm install --frozen-lockfile`, `cp .env.example .env` (Windows: `Copy-Item`). Изменить пароль dev DB; `pnpm preflight`.
4. `pnpm db:up` (пропустить при нативном PostgreSQL), `pnpm db:migrate` и повторить последнюю команду для проверки идемпотентности; затем `pnpm test:integration` (не пропускать). Мигратор и тесты читают `.env`; CI может передавать `DATABASE_URL` непосредственно. `pnpm preflight:strict --require-db` проверяет реальное подключение; отсутствие Docker в dev — предупреждение, если доступен нативный сервер.
5. `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm dev`; отдельным терминалом `pnpm smoke`. Root-команды явно собирают shared packages, не полагаясь на pre/post hooks.
6. `pnpm --filter @dota/web exec playwright install --with-deps chromium`, затем `pnpm test:e2e` (после `pnpm install`). На Windows достаточно `install chromium`. Playwright выполняется отдельно от Vitest; с S0-03 нужны PG16/CREATEDB. Отдельные API/Vite 3151/5179, временная БД и случайный synthetic password; рабочий owner не меняется.

## Дополнительные проверки (Python требует установленных зависимостей)

```bash
node scripts/verify-migrations.mjs
node scripts/check-doc-links.mjs
node --test tests/node/*.test.mjs
PYTHONPATH=tools/ml python -m pytest tools/ml/tests -q
python tools/ml/train.py --dataset tests/fixtures/ml/synthetic_history.jsonl --output /tmp/dota2-demo.json --allow-synthetic
python tools/ml/evaluate.py /tmp/dota2-demo.json
node scripts/check-ml-parity.mjs /tmp/dota2-demo.json
```

Первая установка Python-пакетов: `python -m pip install -r tools/ml/requirements-ci.txt` и затем `python -m pip install --no-deps -e tools/ml` (нужен Python и сеть; на Windows использовать соответствующий Python executable).

## Блокирующие ошибки

- `pnpm-lock.yaml` не сгенерирован: CI **преднамеренно падает**, никаких fallback `--no-frozen-lockfile` в CI/production.
- Нет PostgreSQL: unit- и Python-тесты можно выполнить, но DB integration gate **не пройден**.
- Отсутствие реальных матче/состав/патч данных запрещает публикацию вероятностей победы.

## Правила

Локальная `.env` не коммитится. Никогда не сохранять реальные API ключи, токены или пользовательские Steam данные в test fixtures. Исторические миграции `001–005` защищены checksum-фикстурой; применённые `006–013` также не редактировать, следующие изменения — `014+`.

## S0-02: importer и очередь

S0-03: `pnpm owner:create` в локальном терминале задаёт первый логин/скрытый пароль. `pnpm test:auth` выполняет реальные DB/CLI проверки, но не создаёт аккаунт в рабочей БД. Для HTTPS production нужен AUTH_COOKIE_SECRET >=32 random characters; development без него использует process-local CSRF signing key. Открывать web точно по WEB_ORIGIN. [Подробности](S0_03_OWNER_AUTH.md).

После всех десяти миграций запускать `pnpm test:ingestion`: требуется реальный PostgreSQL и роль с CREATEDB. Suite создаёт случайные отдельные `codex_ingest_*` databases, выполняет миграции и удаляет только свои тестовые БД; синтетика не импортируется в рабочую БД. `pnpm test:integration` по-прежнему выполняет baseline проверки.

`pnpm worker:dev` + `pnpm ingest:enqueue --match-id 9069021061` либо `pnpm ingest:once --match-id 9069021061` проверяют настоящий импорт. Это расходует API quota и записывает реальную карту. `provider:spike` и `provider:audit` теперь также требуют DB/007, поскольку используют общий persistent budget. Offline audit `node scripts/audit-prediction-sources.mjs --fixture ...` остаётся независимым от сети/БД. [Результаты и ограничения](S0_02_INGESTION.md).

S0-04: `pnpm test:temporal` проверяет as-of evidence в отдельной временной PostgreSQL БД; `pnpm test` включает pure temporal tests. [Контракт](S0_04_TEMPORAL_CONTEXT.md).

S0-05: `pnpm test:identity` проверяет immutable identity/alias evidence, историю через организации, точную пятёрку и role gates. Новый normalizer `opendota-map-v2-identity` требует миграцию 010; legacy links не получают known_at автоматически. [Подробности](S0_05_IDENTITY_LINEUP.md).

S0-06: `pnpm test:game-context` проверяет immutable patch/draft/hero evidence и GameContextRepository; требуется миграция 011. Правила не заполняются автоматически. Для одновременного запуска нескольких DB suites на локальной Windows использовать `--no-file-parallelism`: создание/удаление временных БД конкурирует за ресурсы. [Контракт](S0_06_GAME_CONTEXT.md).

S0-07: `pnpm test:dataset` проверяет pro/source/orientation labels, freeze/reject, concurrent append, серии/хронологию и SHA/timezone. DatasetRepository требует migration 012; raw receipt и professional league evidence обязательны. [Контракт](S0_07_VERIFIED_DATASETS.md).

S0-09: `pnpm test:readiness` проверяет availability/cohort boundaries в реальной PostgreSQL. Reader требует миграцию 013 с серверным recorded_at; legacy NULL не доказывает ранний owner input. Новых dependencies нет, SQL 001–012 сохраняются, следующая миграция 014+. `DataReadinessRepository.assess` — read-only inventory; conditional mode требует явных assumptions, automatic backfill не выполняется. [Контракт](S0_09_DATA_READINESS.md).

S1-01: `pnpm test:catalog` — Fastify/owner session + disposable PG DB; `pnpm test:e2e` — реальный browser/API/DB flow справочников и auth. Локальный установленный Chromium находится в `.tools/playwright`: перед E2E задать `$env:PLAYWRIGHT_BROWSERS_PATH=Join-Path (Get-Location) '.tools\playwright'` из корня checkout. Vue Query установлен, cache очищается при logout/401; SQL 001–013 не менялись. [Контракт](S1_01_CATALOGUE.md).
