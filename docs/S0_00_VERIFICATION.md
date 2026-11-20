# S0-00 — проверка bootstrap, 2026-10-30

## Новый локальный checkout — 19 ноября 2026

**Текущее подключение после переноса:** приложение использует `dota_analytics_current` из проверенного `current-20261118T233000Z.rar`. Доступны2285карт,573игрока,213команд,12сохранённых прогнозов и2отчёта. Логин `test-owner`, пароль со старого ПК сохранён. Прежние `.env` и dump начальной базы — `.tools/database-switch`; начальная БД и import-копия также сохранены. [Проверки переключения](evidence/current-database-switch.json). Все71миграция установлены, исторические CRLF-хеши053/054 распознаются корневым мигратором без правок SQL/ledger.

**Модель запущена:** `.tools/start.cmd` использует отдельные `.tools/node22` и `.tools/restored-runtime`. Node22.15.0,323зарегистрированных файла и полный runtime SHA точно совпали с сохранённым допуском; действующий API возвращает model_eligible. [Проверки runtime и полного HTTP-расчёта](evidence/restored-model-runtime.json). Изолированный smoke создал новый условный расчёт по восстановленной истории, проверил сохранение/read/idempotence и удалил тестовую БД; рабочий журнал сохранил12записей. Пароли проверяются нативным Argon2 на Node22, настоящий пароль не сбрасывался. Запуск из PowerShell: `.\.tools\start.cmd`.

**PandaScore работает:** повторная проверка текущего token получила HTTP200. После перезапуска API authenticated refresh загрузил20встреч, status=ready,reason=null,fetchedAt19ноября03:11МСК. Модель model_eligible. [Успешная проверка подключения](evidence/pandascore-token-retry.json). Предыдущий401 сохранён в [историческом отчёте](evidence/pandascore-token-verification.json) и больше не относится к текущей настройке.

Фронтенд работает из текущих исходников, API — из точной восстановленной compiled-копии. Корневые `pnpm dev`/prediction CLI на системном Node24 не используют этот сохранённый runtime; для работающего локального приложения используйте launcher. Изменения backend/scoring требуют отдельного рассмотренного обновления runtime и gates; они не копируются туда автоматически. Проверка через восстановленный CLI: `.tools/node22/node.exe --env-file=.env .tools/restored-runtime/scripts/retest-model.mjs readiness`. Live-обновление расписания требует собственного `PANDASCORE_API_TOKEN` в корневой `.env`; из дампа ключ не переносится. Последующее описание первоначального bootstrap относится к начальной пустой базе, до переноса.

Репозиторий `https://github.com/Ritle/dotaanalitic.git` клонирован в `C:\Users\Kristina\Desktop\ritle_project` с исходного коммита `5251109`. Установлены зависимости из неизменённого lockfile: Node 24.17.0, локальный pnpm 10.19.0, PostgreSQL 16.15. EDB ZIP проверен по SHA-256, указанному ниже. Docker не установлен; используется отдельный native cluster `.tools/pgdata`, SCRAM, `127.0.0.1:5432`, timezone UTC, новая БД `dota_analytics`.

Созданы игнорируемые `.env`, локальные Corepack shims/cache, файлы паролей и launcher. Владелец `owner` создан штатным CLI со случайным паролем через stdin; данные входа находятся в `.tools/owner-credentials.txt`. Секреты не выводятся в журнал и не добавляются в Git. Для повторного запуска из PowerShell:

```powershell
.\.tools\start.cmd
```

Приложение доступно на `http://localhost:5173`, API — `http://127.0.0.1:3000`. В отдельном терминале для команд pnpm можно открыть `cmd /k .tools\activate.cmd`; после этого доступны команды из README. Локальные helper-файлы создавались при этой настройке и не переносятся через Git: при новом clone повторите установку из README и инструкции native PostgreSQL ниже.

Проверены frozen install, typecheck, build, все 1067 пакетных тестов, 71 migration checksum, применение всех миграций и повтор с 71 SKIP, четыре PostgreSQL bootstrap-теста, 11 интеграционных тестов авторизации, strict preflight с подключением к БД (0 failures; Docker WARN), ссылки документации, HTTP smoke и полный login/me/logout с отзывом сессии. Логи текущей проверки находятся в `.tools`.

Для воспроизводимости байтов `.gitattributes` закрепляет LF для текстовых файлов; manifest `packages/contracts/package.json` сохраняет CRLF, так как эти байты закреплены прежними executable freezes. Исправлена сломанная ссылка на AGENTS и тестовая фикстура совместимости runtime: положительный пример теперь использует текущие runtime-метаданные вместе с текущим кодом. Архивные freezes, production-проверка совместимости и отказ при несовпадении runtime не менялись.

База новая: прежняя история матчей, секреты источников и артефакты активных моделей не восстанавливались из Git. Для расписания нужно добавить собственный `PANDASCORE_API_TOKEN` в `.env`; для старых данных понадобится отдельная резервная копия. Следующая продуктовая задача остаётся **S3-09/series-independent-scope**; этот bootstrap её не выполняет. Контейнерные, полные PostgreSQL, browser и Python/ML suites в этом checkout не запускались.

S0-00 выполнен для локальной разработки на Windows: реальный frozen install, чистая PostgreSQL 16, API/Web, миграции, тесты и сборка. Проверялся Git checkout `dotaanalitic` внутри внешнего стартового комплекта; ветка `main`, origin `https://github.com/Ritle/dotaanalitic.git`, исходное дерево чистое. Изменения не отправлялись на сервер.

## Исправления

- Настоящий lockfile создан `node scripts/bootstrap-lockfile.mjs` через pnpm 10.19.0 и npm registry. Следующие этапы не добавляли пакеты.
- Windows `core.autocrlf=true` менял байты SQL. `.gitattributes` закрепляет LF для миграций, lockfile и shell-скриптов. Восстановлены исходные LF; SQL 001–006 не изменён, baseline 001–005 совпадает с golden.
- `rosterOverlap` теперь возвращает положительный ноль при отсутствии сохранённых пар (существовавший golden-тест падал на `-0`). Счётчик co-play исправлен для `noUncheckedIndexedAccess`; правила временного cutoff и идентичности сохранены.
- Vitest исключает Playwright suite; E2E запускается отдельно. Vite использует `strictPort`, чтобы не переключаться незаметно с 5173.
- API `dev`/`start` читают корневую `.env`, как и db/integration/preflight команды; отсутствие файла допустимо для CI с переменными процесса. Zod проверяет порт, host и HTTP(S) origin; ошибки называют поля, не выводя значения env.
- Минимальный Node уточнён до 22.12.0 в соответствии с установленным Vite 7. PostgreSQL preflight проверяет подключение независимо от наличия Docker в dev.
- DB-тесты сверяют реальные SHA файлов с ledger, проверяют BIGINT за пределами JS safe integer, ограничения слотов/идентичности, immutable guards и запрет связи assessment с draft observation другой карты. Записи тестов откатываются транзакциями.

## Реально выполненные проверки

Проверенное окружение: Node 22.15.0, pnpm 10.19.0, TypeScript 5.9.3, Vite 7.3.7, Vitest 3.2.7, PostgreSQL 16.15, Python 3.11.9, scikit-learn 1.8.0. Полные JS-версии закреплены lockfile, Python — `tools/ml/requirements-ci.txt`.

| Команда / проверка | Результат |
|---|---|
| `node scripts/bootstrap-lockfile.mjs` | PASS, registry resolve |
| `pnpm install --frozen-lockfile` | PASS |
| `node scripts/verify-migrations.mjs` | PASS, 6 файлов; baseline 001–005 сохранён |
| `node scripts/check-doc-links.mjs` | PASS |
| `node --test tests/node/*.test.mjs` | PASS, 10 |
| `pnpm typecheck` | PASS, все workspace |
| `pnpm test` | PASS, 26: analytics 17, API 9; web/contracts unit-тестов пока нет |
| `pnpm build` | PASS, API + Vue/Vite |
| `pnpm db:migrate` дважды | PASS: 6 APPLIED, затем 6 SKIP |
| `pnpm test:integration` | PASS, 4 на настоящей PG16 |
| `pnpm preflight:strict --require-db` | PASS, 7 проверок / 0 ошибок; Docker WARN |
| `pnpm dev`, `pnpm smoke` | PASS, `/health` через HTTP |
| `pnpm test:e2e` | PASS, 1 Chromium bootstrap smoke |
| `python -m pytest tools/ml/tests -q` с локальным `--basetemp` и `PYTHONPATH=tools/ml` | PASS, 6 |
| `tools/ml/train.py --allow-synthetic` + `evaluate.py` + `scripts/check-ml-parity.mjs` | PASS; 12 Python ↔ JS сравнений |
| Браузерный рендер + screenshot | PASS, русские тексты читаемы, API доступен, page errors отсутствуют |

Синтетический ML smoke использовал только fixture, результат лежит в игнорируемой `.tools/synthetic-demo.json`, `synthetic_only:true`, `deployable:false`. Он не активировался в API. Реальные матчи/прогнозы не создавались.

Некоторые первые команды были остановлены Windows sandbox (`spawn EPERM`, доступ к pytest temp / browser cache). Проверки повторены с разрешённым запуском; это не исправлялось отключением тестов.

## Повторный запуск на этой Windows-машине

Все команды выполняются из Git-репозитория `dotaanalitic`. Системные настройки Corepack не менялись: shims и cache находятся в игнорируемой `.tools`.

```powershell
$env:COREPACK_HOME = Join-Path (Get-Location) '.tools\corepack'
New-Item -ItemType Directory -Force .tools/bin | Out-Null
corepack enable --install-directory .tools/bin
$env:Path = (Join-Path (Get-Location) '.tools\bin') + ';' + $env:Path
pnpm install --frozen-lockfile
```

Основной путь нового clone — PostgreSQL через `pnpm db:up` и `.env` из README. На этой машине Docker отсутствует, поэтому использован нативный [PostgreSQL 16 из EDB](https://www.enterprisedb.com/download-postgresql-binaries): только `bin/lib/share` из ZIP распакованы в `.tools/pgsql`. Архив `postgresql-16.15-5-windows-x64-binaries.zip` получен по HTTPS с `get.enterprisedb.com`; измеренный SHA-256: `43bb45f173a6f08cf1d29a97a6d8deb119e8e8093a24c00d2d1001a0ccaa8281`.

Создан отдельный cluster `.tools/pgdata`, БД `dota_analytics`, SCRAM, случайный пароль в игнорируемых локальных файлах, bind `127.0.0.1:5432`, timezone UTC. Windows-служба не устанавливалась. После перезапуска машины существующий cluster запускается так:

```powershell
& .tools/pgsql/bin/pg_ctl.exe -D .tools/pgdata -l .tools/postgres.log start
pnpm db:migrate
pnpm test:integration
pnpm preflight:strict --require-db
pnpm dev
# В другом терминале:
pnpm smoke
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.tools\playwright'
pnpm --filter @dota/web exec playwright install chromium
pnpm test:e2e
# После остановки API/Web, при необходимости остановить только этот cluster:
& .tools/pgsql/bin/pg_ctl.exe -D .tools/pgdata -m fast stop
```

Установка Python зависимостей выполнена в `.venv` по pinned requirements; тесты использовали `PYTHONPATH=tools/ml`. `.tools`, `.venv`, `.env`, screenshots и browser artifacts в Git не входят. При новом clone эти локальные файлы нужно создать заново, по README/DEVELOPMENT_PREFLIGHT; они не являются переносимой частью репозитория.

## Границы проверки

- Docker/Compose не установлены: `compose.yaml` проверен чтением (PG16, loopback port, обязательный пароль, named volume, healthcheck), но `docker compose config/up`, container builds и production smoke **не выполнялись**. Это остаётся отдельным контейнерным/deployment gate; локальные DB-критерии S0-00 проверены на нативной PG16.
- GitHub Actions не запускался: workflow проверен на соответствие командам и PG16 service; локально выполнены его code/DB/ML/E2E проверки. Push и deploy не выполнялись.
- Backup/restore drill и реальная модель/источники не входят в результат bootstrap.

Следующая задача: **S0-01**, OpenDota provider spike; в этой работе не начиналась.
