# S4-03/V1 — production preflight

Checkpoint 2026-11-04 (Europe/Moscow). Local configuration/tooling slice. Native development probe прошёл; production preflight **blocked**: Docker Compose/Engine отсутствуют и `.env.production` не создан. Контейнеры, VPS и model activation не запускались. Весь S4-03 остаётся открытым.

## Исправленные проблемы

| Finding | До | После |
| --- | --- | --- |
| S4-DEP-01 | API в compose.production.yaml не получал PandaScore token, даже если он задан в env-файле | Токен передаётся только API; добавлен пустой optional field в production example. Worker сохраняет OpenDota key/budgets |
| S4-DEP-02 | --production --require-db проверял production-файл, но подключался по ambient DATABASE_URL, в том числе development | Выбранный файл используется для validation и read-only probe. Противоречащие ambient Compose variables блокируют production до подключения |
| S4-DEP-03 | HTTPS с неверным host/path, несогласованные Postgres credentials и example domain могли пройти; версия Compose не доказывала доступность daemon | Проверяются HTTPS origin/SITE_HOST, согласованность DATABASE_URL/POSTGRES_*, placeholder/secret format, текущие worker budgets, Compose CLI и Engine отдельно |
| S4-DEP-04 | DB exception печатался без обработки, клиент не гарантированно закрывался после ошибки | Диагностика содержит безопасный code без исходных messages/values; client.end выполняется в finally |

Новый `scripts/lib/deployment-preflight.mjs` сохраняет лёгкий preflight без зависимости от compiled application. `scripts/preflight.mjs` — entry point. `.env` и `.env.production` не менялись; production file или реальные secrets автоматически не создаются.

## Команды

```powershell
pnpm preflight:production --json
node scripts/preflight.mjs --production --strict --env-file path/to/private.env --json
node scripts/preflight.mjs --strict --require-db --json
```

Новая production-команда не загружает development `.env` в process environment. По умолчанию production читает `.env.production`, development — `.env`; --env-file выбирает другой файл. На development без файла допустим process environment. При отсутствии production-файла нет fallback к development connection.

Production renderer выполняет только `docker compose ... config --format json`, без up/build/pull; результат с credentials остаётся в памяти. Проверяются все пять сервисов, private backend ports, публичные80/443 web, auth/provider/DB forwarding. Docker получает исходное process environment, как ручная команда; secrets из файла не подставляются скрыто. Поэтому различия dotenv/Compose interpolation не маскируются. Проверка БД — только SELECT1 и только при --require-db, с ограниченными connection/query timeout.

JSON содержит safe checks и scope preflight_only; containerBuildExecuted/deploymentExecuted/modelActivationExecuted всегда false. Даже passed не доказывает DNS/TLS, image build, model quality или прохождение release gate. Отсутствующий optional PandaScore token даёт warning и явную недоступность свежего расписания.

## Выполнено и ограничения

Девять Node cases используют **fake Docker/pg в отдельных temp directories**, не реальный daemon. Они проверяют happy path, запрет ambient DB override, origin/credential/query mismatch, engine down, потерю token/private ports в rendered payload, очистку client/error sanitization, explicit env file, example domains и redacted JSON. Fixture первый раз требовал Windows file URL для --import: initial harness log сохранён; исправленный red-run дал7 failures/1 pass старого preflight. После implementation8/8 PASS, добавлен JSON case;9/9 PASS. Дополнительный guard выявил скрытое изменение child env при rendering:8 pass/1 red →9/9 PASS после коррекции.

В CI postgres-integration добавлен шаг с временным синтетическим env-файлом: реальные Compose CLI/Engine и config renderer на Docker runner, без запуска production-сервисов. Проверен только shell syntax через Git Bash `bash -n`; remote CI здесь не исполнялся. Первое извлечение shell body не учло CRLF; extractor исправлен до syntax PASS, сами команды step локально не запускались.

Реальный native preflight: PASS, failures0, read-only probe выбранной `.env` БД. Реальный production preflight: exit1/blocked, missing_file,12 failed checks (включая обязательные env fields и Docker); реальные production values не выводились. Наличие Docker проверено spawnSync с ENOENT, а не симуляцией успешного запуска.

Frozen offline install/typecheck/build,730 unit/CLI и73 serial Node cases — PASS.73=64 прежних+9 новых, targeted9 не прибавляется повторно. Финальные unit/Node прошли одним запуском без изменения существующих timeout; browser/Python/remote CI/Docker build не исполнялись. Git Bash -n нового CI shell body PASS, не запуск самого step.

Все78 working relation fingerprints(public65+pgboss13), queued Aurora/team321 с attempt/processed/accepted/retry0 и started_on null,40 protected artifacts/34 SQL ledger SHA/старый report/весь runtime/frozen bundle unchanged, compatibleRuntime:true на текущем native Windows. Working active/scenarios/predictions/snapshots/release/E1/activations0, artifacts1/reports1. Provider/training/real evaluation/activation0. PROGRESS только append. Evidence: `docs/evidence/s4-03-v1-deployment-preflight.json`.

S4-03 не закрыт: реальные Docker/Compose/image/HTTPS/staging restore и model release gates не пройдены. Отсутствие Docker/production settings — зафиксированное ограничение среды, не успешный Docker-test.

## Открытые условия S4-03

- Docker image build/start/Compose runtime/HTTPS/VPS и remote CI ещё не проверены. Требуются Docker host и реальные private production settings владельца.
- Frozen executor имеет node v22.15.0/platform win32/arch x64. Dockerfile выбирает Linux base. По exact runtime policy ожидается несовместимость старого Windows artifact с Linux runtime; фактический Linux build не исполнялся. Нужен отдельный проверенный freeze/registry путь до выпуска, без ослабления policy и изменения архивных E0/E1/V1 artifacts.
- Legacy `scripts/restore-postgres.sh` использует `.env.production` и обычный Compose project; текстовый RESTORE_ACK не проверяет изоляцию target. Этот скрипт в review не запускался. До добавления staging guard он не является разрешённым путём восстановления production; native isolated drill уже проверен отдельно.
- Independent Tier1 quality test, явная активация и restore с реальной active моделью остаются отдельными release gates.

**Следующий точный срез — S4-03/V1-staging-restore-guard:** explicit isolated project/env и проверка пустого target, отказ до SQL для working/filled DB; затем реальная container-проверка на Docker host. Рекомендуемая модель: **GPT-6 Astra · High**, поскольку ошибка target может затронуть рабочие данные.
