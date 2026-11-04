# S3-07/V1-scheduled-runtime-binding — расписание, состав и расчёт

**Продолжение2026-11-03:** [ручное сопоставление и проверка результата реализованы](S3_07_V1_SCHEDULED_RESULT.md). Ограничение refresh ниже описывает предыдущий checkpoint: теперь refresh разрешён после отдельного bind. Без связи по-прежнему запрещён. Следующий срез — S3-07/V1-scheduled-owner-flow.

Реализован backend/owner CLI путь от [сохранённого назначения](S3_07_V1_SCHEDULE_TARGET_REGISTRATION.md) и сохранённого ручного сценария5v5 к immutable runtime snapshot. Назначение использует PandaScore meeting ID; неизвестный OpenDota series ID до игры не требуется. Общие feature builder, model/release/coverage/Tier1 gates сохранены. Это не активация модели или завершение S3-07.

## Вход и запуск

Сначала сохранить назначение встречи и сценарий в обычных owner UI. В сценарии явно указать карту1, те же canonical команды A/B, локальный турнир и scheduledAt, которые закреплены в назначении; seriesId оставить null, pre-map scores — null/0. Игроков выбрать вручную:10 distinct canonical IDs. Роли остаются частью обычного сценария, но V1 Elo их не использует. Редакция сценария и source target сохраняются вместе с попыткой.

Пример структуры запроса — placeholders, не настоящая встреча/оценка:

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "scenarioId": "22222222-2222-4222-8222-222222222222",
  "expectedRevision": 1,
  "purpose": "real_map",
  "realTarget": {
    "provider": "pandascore",
    "bindingVersion": 1,
    "providerMatchId": "12345",
    "mapNumber": 1,
    "targetRequestId": "33333333-3333-4333-8333-333333333333",
    "targetSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "targetScope": null
}
```

`targetRequestId`/SHA брать из сохранённой записи назначения; scenarioId/revision — из сохранённого сценария. SHA ниже — SHA256 **файла запроса**, отдельный от targetSha256. Пример targetScope:null специально означает отсутствие reviewed Tier1 scope и даст unavailable. Для потенциальной числовой выдачи требуется прежний owner-reviewed OpenDota league/event scope из [runtime-контракта](S3_06_V1_RUNTIME_SNAPSHOTS.md), совпадающий с локальным турниром назначения. PandaScore tournament ID не заменяет его.

```powershell
pnpm build
pnpm db:migrate
$requestSha = (Get-FileHash -LiteralPath request.json -Algorithm SHA256).Hash.ToLowerInvariant()
pnpm forecast:v1 create request.json $requestSha
pnpm forecast:v1 get 11111111-1111-4111-8111-111111111111
pnpm predict:v1 export 11111111-1111-4111-8111-111111111111 new-snapshot.json
```

Запуск расчёта этой разновидности сейчас через owner CLI. Новой HTTP create-кнопки для связки расписания/сценария нет; существующий сценарный HTTP endpoint по-прежнему принимает только what-if. Журнал `/forecast-journal` уже показывает сохранённые scheduled attempts, исходные5v5, PandaScore ID и ссылку на исходное назначение. При отсутствии модели — unavailable/null и причины, без50/50.

## Проверки и транзакция

- Перед новой попыткой проверяются owner, target UUID/SHA/provider ID и **последняя** редакция назначения. Старую редакцию нельзя незаметно выбрать после нового сопоставления.
- Источник читается из последних200 сохранённых наблюдений. Новое наблюдение той же нормализованной встречи разрешено; его собственные clocks/SHA замораживаются. Изменение времени/участников/прочих полей встречи требует новой owner-reviewed редакции. Пропуск на более поздних частичных страницах остаётся предупреждением, не отменой.
- Проверяются not_started/future start, реальный server clock, source fetched/recorded timestamps и точное соответствие canonical команд/турнира/времени/карты1 сценарию. A/B могут быть явно переставлены в обеих записях; это не Radiant/Dire. Не выводятся роли/состав по source flags.
- Per-owner target advisory lock и SHARE lock публикации source observations удерживаются до записи snapshot; scenario/activation/release locks сохраняют прежнюю семантику. Нет HTTP внутри транзакции. После расчёта время проверяется повторно: если старт наступил во время вычисления/ожидания, сохраняется unavailable без issuedAt/вероятности.
- Exact UUID/hash retry возвращает прежнюю попытку даже после переноса, смены состава или начала игры. Новый ввод требует нового UUID; старые what-if не переклассифицируются.

`targetReview.scheduleBinding` версии `v1-schedule-runtime-binding-v1` содержит полную исходную запись назначения/SHA, текущий source observation, checkedAt и число пропустивших встречу страниц. SQL031 добавляет nullable FK `v1_runtime_snapshots.schedule_target_request_id` → owner/request назначения, проверяет source/canonical/time binding независимо от TypeScript и сохраняет прежние model/release guards. SQL001–030 не изменяются. Legacy snapshots остаются byte-identical и читаются прежним format; расширен только явно discriminated target provider/version.

## Журнал и результат

Purpose остаётся `real_map`. Новое назначение типизировано отдельно от OpenDota selector: одинаковые числовые ID разных providers не группируются. При успешном gated расчёте попытка pending_verification; при отсутствии gate — unavailable. До verified исхода она не увеличивает N метрик, primary maps или training dataset. Primary-selection/metric kernel не менялся. Старые v1/v2 reports воспроизводятся без переписывания.

`forecast:v1 refresh` и SQL verifier отклоняют попытку связать PandaScore forecast с произвольной OpenDota картой: `forecast_schedule_binding_required`. Не угадываются серия/map1 по первому найденному матчу. OpenDota cancellation ledger не применяется к PandaScore ID; lifecycle новой разновидности ещё впереди.

**Следующий точный срез — S3-07/V1-scheduled-result-binding:** отдельное проверяемое сопоставление pinned PandaScore назначения с OpenDota серией/картой1, сохранение evidence и проверка фактических сторон/start/roster; verified refresh и журнал без изменения исходного prediction snapshot. Затем owner UI запуска связанного расчёта и оставшиеся lifecycle/acceptance проверки. Рекомендуемая модель: GPT-6 Astra · High.

Время из расписания остаётся плановым. При последующем связывании результата нужно независимо проверить фактическое начало карты: расчёт, выданный после него, нельзя учитывать как prospective, даже если плановое время ещё не наступило.

## Проверено2026-11-03

**QA завершена:** offline frozen install, полный typecheck/build PASS; **701 unit/CLI,90 isolated PostgreSQL,23 уникальных browser E2E** PASS. Новая браузерная проверка вынесена в отдельную тестовую БД/owner после срабатывания login rate limit на шестом входе; прежние22 прошли, новый1 прошёл отдельно, production limit не менялся. Первоначальная ошибка cutoff в новой PG-фикстуре исправлена; финальные90tests прошли. Desktop/360px просмотрены; таблица сохраняет горизонтальную прокрутку.31 migration checksums проверены. Evidence: `docs/evidence/s3-07-v1-scheduled-runtime.json`.

**Сохранность:** SQL031 применена, повтор skip31; SQL001–030 и23 protected artifacts неизменны.21 working-table fingerprints, E0 exact replay,232 feature rows и archived/current runtime compatibility PASS. Общие SQL model/release guards и pure primary/metrics kernels сохранены. Старый report SHA bd42a60064c42daa4281bcb0e8972eba79d72737a4fccffe480d8a8725767398 воспроизведён с N0/legacy cancelled null. Рабочие models1/artifacts1/active0/activations0/E1/release0/scenarios0/predictions0/snapshots0/outcomes0/refresh0/reports1/lifecycle0/scheduleTargets0. Dota provider calls/imports/training/реальных оценок/активаций0. Positive probability tests — явно synthetic protocol doubles только в disposable DB.
