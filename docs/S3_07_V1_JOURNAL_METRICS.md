# S3-07 — основной прогноз и неизменяемые отчёты статистики

Срез `S3-07/V1-journal-primary-metrics` добавляет backend и owner CLI поверх [реальных назначений и проверенных исходов](S3_07_V1_REAL_TARGET.md). Это статистика фактически выданных прогнозов, не разрешение на активацию модели. Весь S3-07 остаётся открытым: HTTP/UI журнала, lifecycle отмен и adapters расписания ещё нужны.

## Выбор одной записи на карту

Политика `last_successful_pre_start_v1` выбирает максимум `(issuedAt, createdAt, lowercase prediction UUID)` среди допустимых записей одной canonical pro-карты. Времена выдачи и создания сравниваются с точностью PostgreSQL до микросекунд, оба строго раньше actual start. Cutoff не позже actual start; используется frozen gate на момент выдачи, а не сегодняшняя активность модели. Старые прогнозы продолжают учитываться после деактивации модели.

Сначала определяется основная запись по полному журналу владельца, затем применяются фильтры. Фильтр модели или периода не повышает предыдущий пересчёт до основного. Период относится явно к `forecast_created_at`, интервал `[fromAt, until)`. Отдельная статистика совпавших составов также строится после выбора основной записи; mismatch/unknown не удаляются из общей статистики. Вероятность берётся из immutable snapshot без округления.

Все попытки сохраняются в аудите: `what_if`, `unavailable`, `pending_verification`, `unlinked`, `excluded`, `primary`, `superseded`. Без подтверждённой привязки карта не угадывается. Проверенный исход может существовать у исключённого прогноза; число verified maps поэтому отдельно от числа scored primary maps.

## Проверка текущего результата

Создание отчёта читает полный набор V1 snapshots владельца в одной repeatable-read транзакции. Уже сохранённая проверенная связь одного пересчёта с actual map позволяет проверить остальные пересчёты с точно тем же `(provider, providerSeriesId, mapNumber)`. Каждый из них заново проходит `verify_v1_forecast_outcome`; старый исход не переносится без проверки. Разные привязанные map IDs для одного selector означают конфликт. Автоматического поиска новых карт и моста PandaScore → OpenDota здесь нет.

Так последний прогноз не потеряется лишь потому, что outcome refresh выполнялся для предыдущего. Report capture ничего не записывает в outcome ledger. Новые исправления источников отражаются только в новом отчёте; исходные prediction/outcome/report bytes не переписываются. Отчёт сохраняет snapshot SHA, binding revision/SHA, текущую проверку и признак изменения результата относительно последнего refresh.

## Метрики

`forecast-binary-v1` использует одну строку на выбранную actual map:

- Accuracy: доля верно выбранных фаворитов, отдельный `accuracyN`. При точном `p=0.5` фаворита нет: запись увеличивает `ties`, но не знаменатель accuracy.
- Brier: среднее `(p_teamA - outcome_teamA)^2` по всем основным записям, включая `p=0.5`.
- Log loss: натуральный логарифм, вероятность ограничена `[1e-15, 1-1e-15]` только для этой метрики.
- Reliability: 10 заранее фиксированных Team-A bins `[0,.1), …, [.9,1]`; в каждом N, средняя вероятность и наблюдаемая частота побед A. Это описательная таблица, не автоматическое подтверждение калибровки.

Пустая выборка возвращает N=0 и `null` rates/ошибки; пустые bins тоже имеют `null` rates. Counters попыток, выданных real-map прогнозов, pending/unlinked/excluded/superseded и уникальных verified/primary maps разделены. **Отмены пока не реализованы: `cancelled:null` и явное предупреждение**, а не ложный нулевой счётчик.

## Хранение и CLI

SQL028 добавляет `v1_journal_reports`, линейную revision/previous SHA цепочку на владельца, requestId idempotency и запрет UPDATE/DELETE/TRUNCATE. SQL проверяет полный inventory, ключевые поля исходных snapshots, source bindings и свежую verification. Input/report bytes имеют SHA-256; чтение повторяет pure aggregation по frozen input и сверяет summary. Сохраняется fingerprint расчётного кода. Повтор того же requestId/filters возвращает старый отчёт, изменённое тело с тем же ID отклоняется. Новый requestId создаёт новую версию даже при прежней выборке.

Лимиты: полный inventory до 5000 попыток, input/report до 32 MiB каждый; превышение даёт отказ, не усечение выборки. Сборка и `pnpm db:migrate` обязательны. Используется единственный активный CLI-provisioned owner.

Пример запроса, UUID заменить новым:

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "filters": {"fromAt": null, "until": null, "modelId": null, "status": null}
}
```

```powershell
$requestSha = (Get-FileHash -Algorithm SHA256 -LiteralPath '.tools/journal-request.json').Hash.ToLowerInvariant()
pnpm journal:v1 create .tools/journal-request.json $requestSha
pnpm journal:v1 get REQUEST_ID
pnpm journal:v1 export REQUEST_ID .tools/new-journal-export.json
```

Export содержит frozen input и report; файл создаётся только новым. Хранить в локальной игнорируемой `.tools`: внутри owner/scenario/player identifiers. `get` и `export` воспроизводят сохранённый отчёт без повторной проверки сегодняшних исходов. Для обновления создать новый requestId.

Следующий точный срез: **S3-07/V1-journal-owner-API-UI** — owner/session/CSRF создание, чтение и история отчётов, фильтры, таблица попыток, метрики и объяснение исключений. Lifecycle отмен и target adapters остаются открытыми. Независимый release gate и активация модели не заменяются этим журналом.

Проверено2026-11-03: frozen install/typecheck/build,684 unit/CLI и43 isolated PostgreSQL tests, applied/retry migration028. Рабочий CLI создал один пустой отчёт с N=0, одинаковый при create/get/retry/export; активных моделей и прогнозов0. [Evidence](evidence/s3-07-v1-journal-metrics.json), [текущее состояние](PROJECT_STATE.md), [append-only журнал работ](PROGRESS.md). Числовые positive tests используют synthetic fixtures в изолированных БД; это не live accuracy.
