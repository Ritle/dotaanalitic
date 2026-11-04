# S4/V1 — аудит приёмки и сквозной путь владельца

**S4-03 preflight continuation (2026-11-04):** [production preflight](S4_03_V1_DEPLOYMENT_PREFLIGHT.md) исправил missing PandaScore forwarding, environment/probe mismatch, unsafe DB errors и checks Engine/rendered services.730 unit/CLI,73 Node PASS, native read-only probe PASS. Реальный production blocked: Docker/production env отсутствуют; CI step prepared, не исполнен. S4-03/staging restore guard/Linux artifact/model/release/active-model restore gates открыты. Все78 working relations/queued Aurora/40 protected artifacts preserved.


**S4-02 localhost V1 завершён:** [full57 browser suite](S4_02_V1_FULL_OWNER_E2E.md) прошёл одним run,26 files, exit0/retries0/skipped0, включая compiled CLI/API restart journey.730 unit/CLI и64 serial Node PASS, source/config unchanged,39 protected artifacts/78 working relations/queued Aurora сохранены. Historical regression/native restore подтверждены прежними checkpoints; нового restore здесь нет. Следующий срез — S4-03/V1-deployment-preflight. Independent Tier1 test/active model/active-model restore/Docker/VPS/remote CI не подтверждены; прежние next-step строки ниже исторические.


**S4-02 historical regression:** [offline-сверка](S4_02_V1_HISTORICAL_REGRESSION.md) воспроизвела frozen development232 maps (152 ready/80 unavailable),232 runtime parity rows и строгие временные ссылки.730 unit/CLI,64 serial Node,50 selected PG PASS;3 новых cases входят в существующий CI unit glob. Existing runtime и все78 working relations/queued Aurora/38 protected artifacts сохранены. Это не model evaluation или release gate. Следующий срез — S4-02/V1-full-owner-e2e; общий S4-02 открыт, прежние next-step строки ниже исторические.


**S4-01 localhost V1 завершён:** [provider conflict review](S4_01_V1_PROVIDER_CONFLICTS.md) подтвердил сохранность canonical/source фактов, sticky conflict, identity re-resolution и draft separation.8 новых cases подключены к test:pro-maps/CI;79 selected PG,727 unit/CLI,64 serial Node PASS. Runtime unchanged, все78 working relations/queued Aurora/37 protected artifacts сохранены. Security/queue/resilience checkpoints остаются действующими. Следующий срез — S4-02/V1-historical-regression. Independent model/release/active-model restore и deployment gates открыты; прежние next-step строки ниже исторические.


**S4-01 provider resilience:** [S4-UPSTREAM-01 исправлен](S4_01_V1_PROVIDER_RESILIENCE.md): OpenDota durable quota учитывает Retry-After всех 5xx. 44 selected PG tests PASS, включая 7 новых cases межклиентского cooldown и stale schedule при 429/503. Внешних provider calls0; queued Aurora job, все78 working relation fingerprints и36 protected artifacts сохранены. Следующий срез — S4-01/V1-provider-conflict-review. Общий S4/model/release остаётся открытым; прежние next-step строки ниже исторические.

**S4-01 queue continuation:** [S4-SEC-03 исправлен и проверен](S4_01_V1_QUEUE_COVERAGE.md) для текущего native verifier. Working dump/restore78 entries включает public+pgboss, copied sessions revoked, bundle verified, source/queued Aurora job unchanged. Старый65-entry evidence не пересчитан; упоминания открытого queue finding ниже исторические. Следующий срез — S4-01/V1-provider-resilience-review, общий S4/model/release/active-model restore открыт.

**S4-01/V1 security continuation:** [HTTP review](S4_01_V1_SECURITY_REVIEW.md) исправил отражение path в ранних router errors и raw URL parameters в логах. Матрица49 private pairs/31 HEAD/18 mutation guards проверена. Отдельно открыт S4-SEC-03: прежний inventory пропускал schema pgboss, поэтому старые65 relation fingerprints — только public. Dump не ограничен этой схемой, но queue verification/restore ещё не доказаны; следующий срез S4-01/V1-queue-coverage. Общий S4 не закрыт.

**Продолжение S4 — Home:** [динамический статус реестра модели](S4_V1_MODEL_READINESS_STATUS.md) реализован через owner-only GET. Фиксированная фраза заменена loading/error/registry states с UTC check time; допуск реестра не выдаётся за проверку сценария, вероятность всегда null. Прежние замечания ниже о Home относятся к историческому checkpoint. Общая приёмка и независимый model/release gate остаются открытыми; следующий срез после QA — S4-01/V1-security-review.

**Продолжение S4:** [фильтр турниров](S4_V1_SCHEDULE_EVENT_FILTER.md) реализован для текущей сохранённой страницы. Предыдущее замечание о его отсутствии ниже относится к owner-smoke checkpoint; прежнее ошибочное утверждение о готовности было исправлено до реализации. Новая реализация не расширяет полноту источника и не присваивает Tier1.

**Уточнение после [проверки рабочих экранов](S4_V1_LOCAL_OWNER_SMOKE.md):** runtime Tier1 gate есть, но фильтра турниров в расписании пока нет. Прежнее утверждение о готовности этого фильтра было ошибочным; статус исправлен в ACCEPTANCE_CRITERIA. Следующий срез — S4/V1-schedule-event-filter. Локальный owner smoke завершён, независимый model gate остаётся открытым.

Продолжение: [native backup/restore текущего inactive состояния выполнен](S4_V1_BACKUP_RESTORE.md). Открытые условия ниже отражают момент первоначального аудита; актуальный следующий срез — PROJECT_STATE.

Дата: 2026-11-03. Область: утверждённый `AGENTS v10` / `TECHNICAL_SPEC §0`, одна pre-match single-map player-mean Elo модель и базовый forecast journal. Это аудит существующих функций. Числовая выдача требует независимой оценки и активации; положительный synthetic protocol test не подтверждает качество модели.

## Матрица требований

«Протокол проверен» означает исполненные проверки поведения на синтетике и/или воспроизведение сохранённых артефактов. «Ожидает release test» означает незавершённое условие реального выпуска.

| Требование V1 | Реализация / проверяемый источник | Статус |
|---|---|---|
| Один владелец, ручное создание, session/CSRF, logout/revocation | `apps/api/src/modules/auth`; `apps/api/tests/auth.integration.test.ts`; compiled CLI в новом E2E | Протокол проверен auth suite и сквозным тестом |
| Расписание и отдельные provider/canonical IDs, clocks | `upcoming_source_observations`, `V1ScheduleTargetRepository`; schedule-targets/upcoming-evidence tests | Реализовано; полнота источника не заявляется |
| Ручные ожидаемые 5v5, десять разных игроков, ревизии | `ScenarioRepository`, `ScenariosView`; scenarios/predictions tests | Реализовано; roster announcement не требуется |
| Проверенные numeric account IDs и предыдущая pro-history | `packages/db/src/v1-features.ts`, `packages/prediction/src/v1-features.ts`; V1 feature/runtime tests | Реализовано; sparse/unknown history блокирует выдачу |
| Player-mean Elo без patch/roles/heroes/side/cohesion features | frozen V1 kernel/executable manifest; `S3_02_V1_FEATURES.md` | Реализовано, исходный frozen profile сохранён |
| Строго ранние завершённые исходы, conditional cohort отдельно | feature source, whole-series dataset/release guards; E0/E1/V1 артефакты | Протокол проверен; реальная независимая оценка открыта |
| Явный Tier 1 target scope | `v1-registry`, `v1-runtime`, scheduled-runtime tests; owner-reviewed event scope | Реализован gate; `is_pro` не присваивает Tier 1 |
| Untouched Tier 1 test, baseline/Brier/log loss/calibration/N/coverage | `docs/evidence/s3-01-v1-release-plan.json`, `S3_03_V1_RELEASE_EVALUATION.md` | **Ожидает release test** |
| Только active approved artifact, unavailable/null при отказе | `V1ModelRegistry`, `V1RuntimeRepository`, SQL026/031/033/034; runtime tests | Протокол проверен; рабочая модель неактивна |
| Immutable snapshot до ответа и точный retry | runtime repository; predictions/scheduled-owner tests | Реализовано; старый forecast не превращается из what-if в prospective |
| Verified single-map association и отдельные outcome revisions | SQL027/032, schedule-result service; scheduled-results tests | Реализовано; ручная межпровайдерная связь требует отдельной проверки pro/map/series |
| Один global primary до фильтров, accuracy/Brier/log loss/reliability, N=0→null | journal v1/v2/v3, analytics forecast metrics; forecast/journal tests | Реализовано; число пересчётов не является числом training examples |
| Roster mismatch/unknown сохраняется в общей статистике | outcome verification / journal; `v1-forecast.integration.test.ts` | Реализовано |
| Отмена/открытие и приоритет ever-verified map binding | SQL029/034 и journal v3; scheduled-lifecycle tests | Реализовано; отмена не скрывает проигрыш/исправление источника |
| Сохранение при перезапуске и logout | новый `apps/web/tests/e2e/v1-acceptance.spec.ts` | Сквозная проверка собранного API, CLI, браузера и PostgreSQL |
| Восстановление резервной копии | `DEPLOYMENT_AND_TESTING.md §5`, `OPERATIONS_RUNBOOK.md` | **Отдельная приёмка восстановления ещё не выполнена** |

Ссылки на предыдущие исполненные suites, SHA кода и границы находятся в [последнем checkpoint](evidence/s3-07-v1-scheduled-target-lifecycle.json). При аудите проверяется сохранность этого кода и frozen artifacts. Предыдущие suites не считаются заново исполненными в S4.

## Новый сквозной тест

Тест создаёт отдельную случайную PostgreSQL БД через существующий `testDatabase`, применяет 001–034, публикует явно синтетический cached schedule и каталог. Случайный пароль передаётся через stdin собранному owner CLI; в лог не выводится. API запускается отдельным Node-процессом из `apps/api/dist/server.js`, без загрузки `.env` приложения и без токена PandaScore. Vite/Chromium обращаются к реальному HTTP API; route mocks и готовые forecast/report records не используются.

Владелец входит, сохраняет назначение встречи, создаёт ручные 5v5 через UI, сохраняет unavailable/null расчёт при отсутствии модели, отменяет встречу и создаёт отчёт с N=0. Проверка сохраняет точные bytes/SHA отчёта и forecast. API останавливается и запускается заново на той же тестовой базе, отчёт открывается по постоянной ссылке, встреча открывается повторно, прежний отчёт остаётся с отменой. Logout отзывает исходную сессию: повтор запроса с прежними cookie получает 401, приватная browser-ссылка ведёт на login.

Это подтверждает работоспособность пути **без активной модели**. Выдача реальной вероятности, prospective accuracy и качество источников этим тестом не подтверждаются. Локальный рабочий владелец и рабочая БД не используются для синтетики. Проверка выполняется в development HTTP режиме; это не проверка Docker/VPS/HTTPS развёртывания.

## Воспроизведение

Сначала `pnpm install --frozen-lockfile`, затем `pnpm typecheck`, `pnpm build`. PostgreSQL должен быть доступен через `DATABASE_URL`, роль имеет CREATEDB. Установите Chromium штатной командой Playwright. На данной Windows-машине используйте локальные shims из `S0_00_VERIFICATION.md` и `PLAYWRIGHT_BROWSERS_PATH=.tools/playwright`.

```powershell
node --env-file-if-exists=.env apps/web/node_modules/@playwright/test/cli.js test --config apps/web/playwright.config.ts v1-acceptance.spec.ts
node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run apps/api/tests/auth.integration.test.ts --testTimeout=30000 --maxWorkers=1 --no-file-parallelism
```

Прямой запуск нового E2E требует `pnpm build`: API стартует из dist. Штатная команда `pnpm test:e2e` теперь сама собирает API и его workspace dependencies; ранее она собирала только shared packages, а отдельный CI job не имел API dist. Это единственное изменение команды запуска. Порты 3151/5179 должны быть свободны. После теста закрываются только созданный дочерний API-процесс и его временная БД. Обычный локальный запуск и путь по экрану восстановлены в [README](../README.md).

## Условия выпуска

1. Зарегистрированный Tier 1 release test ещё не выполнен; план фиксирует snapshot не ранее **2026-12-02 00:00 UTC / 03:00 МСК**, после BLAST Slam IX. Это ограничение независимой оценки, а не дата выпуска сервиса. Пороги и окна по результатам аудита не меняются.
2. Прохождение test не гарантировано: недостаток карт/серий/coverage или провал метрик оставляет candidate inactive и probability unavailable. Активация отдельная, явная и аудируемая.
3. Проверка backup/restore на изолированной базе ещё требуется до завершения эксплуатационной приёмки. API process restart не является восстановлением backup.
4. Docker/VPS/production HTTPS и offsite backup не проверялись этим локальным аудитом. Деплой отдельным действием.

Общий `S4/V1 acceptance`, S3-01/V1-evaluation и S3-03/V1-candidate остаются unchecked. Точный следующий срез: **S4/V1-backup-restore** — ограниченный native PostgreSQL dump/restore в новую изолированную БД, проверка контрольных сумм и чтения immutable snapshots, процедура отзыва восстановленных сессий и локальная инструкция владельцу. Публикация вероятностей всё ещё зависит от release gate.

## Исполненные проверки

**QA:** frozen offline install, typecheck/build, strict preflight с реальным PG,34 migration checksums,64 Node fixture tests,717 уникальных unit/CLI,11 auth PostgreSQL tests и1 новый Chromium E2E PASS. Новый E2E отдельно повторён штатной root-командой; это один уникальный тест. Остальные50 browser/120 PG tests предыдущего checkpoint не перезапускались: сохранность их production code проверена по SHA. Desktop/360px journal визуально проверен; таблица имеет собственную горизонтальную прокрутку, page overflow отсутствует.

**Первоначальные сбои:** sandbox install остановился с ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY; повтор offline с доступом к существующему pnpm store прошёл без переустановки. Во время unit run исправлена команда test:e2e в package.json, включённом в candidateCodeManifest; один старый CLI replay test получил mismatch на verify (строка31). После завершения правок неизменённый тест повторён с исходными timeout20s/60s и прошёл, затем выполнен оставшийся пакет ingestion.717 — уникальные проверки после повтора, не сумма запусков. Исходные логи сохранены; production code/старые артефакты ради повтора не менялись. Дополнительно в remaining ingestion suite227/228 PASS: unchanged v1-release-cli frozen-manifest test превысил исходные90s (reported419620ms). Причина задержки не установлена; весь2-test файл повторён без изменения кода и исходных timeout, затем выполнены API40/worker1. Это один дополнительный успешный уникальный случай и один повтор уже прошедшего случая.

**Открыто:** S4/V1 acceptance не закрыта: backup/restore ещё не исполнен; release test и model quality/activation не выполнены. Frozen Tier1 plan/evaluateNotBefore2026-12-02T00:00:00Z и пороги не менялись. Docker/VPS/HTTPS/offsite backup/remote CI не исполнялись. Synthetic данные только в disposable DB, провайдеры/обучение/реальные прогнозы/активации0. Evidence: `docs/evidence/s4-v1-acceptance-audit.json`.
