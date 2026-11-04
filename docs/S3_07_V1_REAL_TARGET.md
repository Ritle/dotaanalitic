# S3-07 — назначение реальной карте и проверка результата

**Дополнение2026-11-03:** [scheduled runtime](S3_07_V1_SCHEDULED_RUNTIME.md) добавляет отдельный PandaScore selector с immutable target revision/SHA. OpenDota flow ниже сохранён. Verified result binding новой разновидности ещё не реализован.

Дополнение2026-11-03: [назначение по расписанию](S3_07_V1_SCHEDULE_TARGET_REGISTRATION.md) теперь можно сохранить отдельно без OpenDota ID. Ниже описан прежний OpenDota runtime selector; новый schedule-target ещё не подключён к расчёту/связи результата и не заменяет его автоматически.

Срез `S3-07/V1-journal-real-target` реализует backend и owner CLI. Назначение `real_map` сохраняется до issued_at в исходном immutable runtime snapshot. `what_if_single_map` остаётся отдельным режимом; старую запись нельзя превратить в реальный прогноз новым запросом или UPDATE. Model gate, активный артефакт, точность вероятности, source/features и locked issuance остаются обязательными.

## Явное назначение

Первый поддержанный selector: `provider:'opendota'`, `providerSeriesId`, `mapNumber:1`, HTTPS-источник и обоснование владельца. Это номер **одной карты**, не вероятность серии. В сохранённом сценарии также нужно явно выбрать mapNumber1. Владелец фиксирует намерение, а не заранее удостоверяет исход или фактическое участие игроков. Source review записывается сервером вместе с запросом; произвольный backdated prediction timestamp не принимается.

Нужно знать именно OpenDota series_id. ID встречи PandaScore, tournament ID и canonical UUID серии — другие пространства идентификаторов. Автоматического моста из расписания в этом срезе нет. При отсутствии проверенного соответствия сохраняйте обычный условный сценарий; он не станет prospective задним числом. Расширение target adapters должно сохранять явный single-map selector и доказательство связи с canonical match_id.

Числовая выдача запрещена, если уже известная карта этой source-серии началась: учитываются canonical series и исходные import receipts. Повторная проверка выполняется SQL-trigger перед сохранением. Это дополнительная защита; фактический start после завершения сверяется отдельно. Первый известный локальный матч серии никогда автоматически не считается первой картой.

## Owner CLI

После сборки и `pnpm db:migrate` использовать единственный активный CLI-provisioned owner. Примеры содержат placeholders, а не реальные подтверждения:

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "scenarioId": "22222222-2222-4222-8222-222222222222",
  "expectedRevision": 1,
  "purpose": "real_map",
  "realTarget": {
    "provider": "opendota",
    "providerSeriesId": "123456",
    "mapNumber": 1,
    "sourceUrl": "https://example.test/replace-with-reviewed-source",
    "rationale": "Заменить на реальное обоснование соответствия серии"
  },
  "targetScope": null
}
```

`targetScope:null` допустим для сохранения unavailable, но не числового прогноза. Для расчёта нужен тот же reviewed Tier1 scope, что в [S3-06](S3_06_V1_RUNTIME_SNAPSHOTS.md), и существующий scenario с текущей редакцией. UUID и series ID заменить действительными данными; не запускать пример как реальные сведения.

```powershell
$forecastSha = (Get-FileHash -LiteralPath '.tools/forecast-request.json' -Algorithm SHA256).Hash.ToLowerInvariant()
pnpm forecast:v1 create .tools/forecast-request.json $forecastSha
pnpm forecast:v1 get 11111111-1111-4111-8111-111111111111
pnpm forecast:v1 history 11111111-1111-4111-8111-111111111111
```

Для проверки результата отдельный JSON: `{requestId, predictionRequestId, matchId, expectedRevision}`. Новый requestId — ID операции refresh; predictionRequestId — ID исходного прогноза. expectedRevision равен последней revision из history, для первой проверки0. matchId — предлагаемый canonical ID одной карты. Winner, probability и время проверки не принимаются от пользователя.

```powershell
$refreshSha = (Get-FileHash -LiteralPath '.tools/forecast-refresh.json' -Algorithm SHA256).Hash.ToLowerInvariant()
pnpm forecast:v1 refresh .tools/forecast-refresh.json $refreshSha
```

Refresh не обращается к провайдерам: сперва штатно импортировать завершённую pro-карту и source/context evidence, затем сверить. Новых HTTP endpoints пока нет. Существующая страница условных расчётов продолжает принимать только what-if и не смешивает с ними CLI real-map snapshots. Owner HTTP/UI журнала и основные метрики — следующий срез.

## Проверенная связь и время

`verify_v1_forecast_outcome` использует существующий `verify_training_outcome`: положительный pro-status, завершённый исход, реальные native sides, matching receipt и immutable league proof. Каноническая запись без matching source receipt недостаточна.

Дополнительно требуются ровно одна canonical OpenDota series с указанным providerSeriesId, совпадение league и unordered teams серии, то же series_id в verified outcome receipt, соответствие Team A/B фактическим Radiant/Dire, Tier1 window и явное accepted доказательство `context.map_number=1`. Retrospective/verified context evidence разрешено **для проверки результата после игры**; его known/fetched/recorded clocks не становятся исторически доступными признаками. Owner-asserted/unreviewed/unknown context не подтверждает номер карты. Противоречия, несколько первых карт или неизвестная связь оставляют `unlinked`, `outcome:null` и причины.

`linked` не равно `prospectiveEligible`: successful done, created_at и issued_at строго раньше actual_started_at, cutoff не позже start. PostgreSQL сравнивает полную точность timestamp, без округления через JS Date. Поздний start correction сохраняет связь и причины, но исключает такую запись из prospective cohort. Деактивация модели после выдачи не отменяет старый прогноз.

Actual lineups: пять уникальных canonical player IDs на каждой native side → matched/mismatched; неполные/неизвестные → unknown. Mismatch и unknown **не исключают** корректный pre-start forecast из end-to-end cohort. Роли, patch и draft не используются как дополнительные veto. Выбор primary и accuracy/Brier/log loss этим срезом ещё не реализованы.

## Ревизии и защита

SQL027 добавляет `v1_forecast_outcome_revisions` и `v1_forecast_refresh_requests`, не изменяя SQL001–026 или старые snapshots. Ревизии связаны previous SHA и сохраняют точные JSON bytes. Сервер повторно проверяет результат в SQL-trigger; вручную приписанный winner/eligible flag не проходит. UPDATE/DELETE/TRUNCATE запрещены. Старую legacy `prediction_outcomes` не перезаписываем: версия связи V1 хранится в новом журнале.

Owner/requestId retry возвращает исходную ревизию, включая повтор после последующих исправлений. Новый refresh с тем же содержимым результата возвращает прежнюю revision; проверка только в другое время не увеличивает историю. Новые source receipt/data revision/evidence/roster/status создают следующую revision. Request ID c другим телом и устаревший expectedRevision отклоняются. После первой verified связи обычный refresh не может заменить matchId другой картой и скрыть прежний прогноз. Исключительное исправление ошибочного canonical map mapping потребует отдельной audited correction policy; обычное изменение победителя/времени той же карты поддержано.

Это forecast audit, не training dataset. Число проверок или повторных прогнозов не увеличивает число тренировочных карт. Прогнозы не создают labels, автоматическое обучение и активация не запускаются.

Исполненные проверки и рабочее состояние: [evidence](evidence/s3-07-v1-real-target.json), [PROJECT_STATE](PROJECT_STATE.md), [PROGRESS](PROGRESS.md). Рабочая модель остаётся inactive до независимого release gate. Следующий срез: **S3-07/V1-journal-primary-metrics** — единая primary выборка одной записи на actual map, eligibility/status audit и базовые counts/accuracy/Brier/log loss/reliability; затем owner API/UI журнала.
