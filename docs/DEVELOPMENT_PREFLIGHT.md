# Проверки перед началом работы / S0-00

## Подготовка

1. Node.js >=22.12.0; Corepack, pnpm **10.19.0**; PostgreSQL 16 через Docker + Compose или нативно; Python 3.11–3.13 для ML-тестов.
2. `corepack enable`. Настоящий `pnpm-lock.yaml` уже создан из registry при S0-00. `node scripts/bootstrap-lockfile.mjs` нужен только при отсутствии lockfile; ручная генерация запрещена. Для Windows без прав записи в Program Files см. [локальные shims](S0_00_VERIFICATION.md).
3. `corepack pnpm install --frozen-lockfile`, `cp .env.example .env` (Windows: `Copy-Item`). Изменить пароль dev DB; `pnpm preflight`.
4. `pnpm db:up` (пропустить при нативном PostgreSQL), `pnpm db:migrate` и повторить последнюю команду для проверки идемпотентности; затем `pnpm test:integration` (не пропускать). Мигратор и тесты читают `.env`; CI может передавать `DATABASE_URL` непосредственно. `pnpm preflight:strict --require-db` проверяет реальное подключение; отсутствие Docker в dev — предупреждение, если доступен нативный сервер.
5. `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm dev`; отдельным терминалом `pnpm smoke`.
6. `pnpm --filter @dota/web exec playwright install --with-deps chromium`, затем `pnpm test:e2e` (после `pnpm install`). На Windows достаточно `install chromium`. Playwright-тесты выполняются отдельным runner и исключены из Vitest.

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

Локальная `.env` не коммитится. Никогда не сохранять реальные API ключи, токены или пользовательские Steam данные в test fixtures. Исторические миграции `001–005` защищены checksum-фикстурой; новые изменения — только новая миграция `006+`.
