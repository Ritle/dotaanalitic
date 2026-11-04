# S3-07 — API и страница журнала прогнозов

Срез `S3-07/V1-journal-owner-API-UI` подключает [сохранённые отчёты и метрики](S3_07_V1_JOURNAL_METRICS.md) к личному кабинету. Страница `/forecast-journal` доступна из кабинета после входа. Новый отчёт проверяет локальные исходы и сохраняет новую версию; открытие истории читает прежнюю версию без обновления её данных. Модель для создания пустой статистики не нужна. Выдача новых вероятностей по-прежнему требует отдельного release gate.

## HTTP

Все маршруты наследуют owner/session auth и `Cache-Control:no-store`. POST требует CSRF и допустимый Origin; owner берётся исключительно из сессии.

Назначение `real_map` и первичный verified outcome refresh пока выполняются через `forecast:v1` CLI. HTTP этого среза создаёт/читает aggregate reports, не принимает исходы от пользователя и не угадывает новые map IDs. На странице отдельно объяснено, что новый отчёт перепроверяет уже привязанные локальные карты.

| Метод и путь | Вход | Результат |
|---|---|---|
| POST `/api/v1/forecast-journal` | `V1JournalRequestSchema`: requestId, filters | `V1JournalViewSchema`, первая страница попыток |
| GET `/api/v1/forecast-journal` | optional beforeRevision, положительный integer | `V1JournalHistorySchema`, до20 версий по убыванию revision |
| GET `/api/v1/forecast-journal/:requestId` | optional offset0..5000 | `V1JournalViewSchema`, до50 попыток из выбранного frozen отчёта |

`nextBeforeRevision` задаёт exclusive revision cursor истории. Создание новой версии между страницами не дублирует старые записи. Внутри immutable отчёта допустим offset: строки сортируются по createdAt DESC, canonical prediction UUID DESC. **Пагинация не выбирает primary по видимым строкам и не меняет метрики frozen отчёта.** Repository дополнительно проверяет целостность повторением pure aggregation по полному сохранённому input. Summary относится ко всей отфильтрованной выборке, а не только видимым50 строкам.

HTTP projection содержит request/revision/SHA/capture metadata, summary без исходного массива rows и текущую страницу строк. В строке: статус/причины, сценарий/редакция/команды, ожидаемые5v5 numeric canonical IDs, точная вероятность, фаворит/correct, модель, времена, map/primary IDs, roster status, source correction marker, snapshot SHA и краткий outcome receipt/SHA/data-revision metadata. Manifest кода, raw source payload, полный input и owner UUID не передаются. Полный локальный export остаётся в CLI.

POST ограничен6 запросами в минуту. Service допускает только одно создание одновременно до получения DB connection; параллельное создание возвращает429/JOURNAL_BUSY с Retry-After1. Сохранённые чтения доступны независимо. Повтор requestId с теми же нормализованными filters возвращает прежний отчёт; другое тело —409/REQUEST_CONFLICT. Unknown поля/некорректные даты/ID/paging —400. Чужая/отсутствующая запись —404. Превышение полного inventory/byte limit —422/JOURNAL_LIMIT, целостность —503/JOURNAL_INTEGRITY. Пользовательские ошибки на русском, внутренние SQL/validation dump не возвращаются.

Долгоживущий HTTP service фиксирует fingerprint расчётного кода при старте. Repository проверяет его перед capture и сопоставляет с code manifest captured input до INSERT. При обновлённых файлах503/JOURNAL_CODE_CHANGED требует перезапуска локального сервера; transaction не оставляет новый отчёт. Уже сохранённые request retries и GET остаются доступны. Optional startup fingerprint не меняет прежние CLI вызовы repository и не меняет primary/metric policy.

## Интерфейс

Форма «Фильтры нового отчёта» задаёт период **создания прогноза в UTC**, модель UUID и статус. Границы `[fromAt, until)` явно подписаны. У открытого отчёта показаны собственные effective filters; редактирование формы не меняет сохранённый результат. Для каждого actual map применяется уже выбранный глобальный основной прогноз, фильтры и matched-lineup slice не повышают предыдущий пересчёт до основного.

История и выбранная версия адресуются через `?report=REQUEST_ID`. Потерянный POST response допускает повтор с прежним requestId/body. Успешное чтение уже сохранённого запроса также восстанавливает результат. Новая попытка создаёт новый UUID; завершение сессии очищает query cache и переводит на вход. Loading/error/empty состояния и обновление истории доступны явно. Серверные данные находятся в Vue Query, локальные поля формы — в component state.

Счётчики различают попытки, реальные выдачи, основные/verified карты, pending/unlinked/unavailable/excluded/superseded и what-if. N и nullable accuracy/Brier/log loss видны вместе; p=.5 показан отдельно от accuracyN. Reliability — раскрываемая таблица из10 фиксированных bins. Условные/недоступные попытки не дают фиктивные50%. Несовпавшие и неизвестные составы остаются в общей статистике, matched slice подписан отдельно. Отмены пока неизвестны и явно отмечены: lifecycle отмен ещё не реализован.

Статус участия в audit cohort отделён от `calculationStatus` и первоначальных `attemptReasons`: у исключённого what-if видна также причина недоступности вероятности. Счётчик unavailable относится к реальным попыткам; what-if считаются отдельно.

Таблица прокручивается по горизонтали внутри страницы, доступна с клавиатуры; макет рассчитан на360px. Подробности строки показывают ожидаемые составы, модель, выдачу/cutoff, target/источник и контрольные суммы. Нет графиков или нового ML поведения.

Следующий точный срез: **S3-07/V1-journal-cancellation-lifecycle** — явное версионируемое подтверждение отмены single-map target, отдельный audit/status/counter и правила повторного открытия без изменения forecast/report originals. Затем target adapters расписания. Весь S3-07/V1 release остаётся открытым до этих условий и независимой проверки модели.

Проверено2026-11-03: frozen install/full typecheck/build,690 unique unit/CLI,48 isolated PG,15 browser tests; desktop и360px просмотрены визуально. Один прежний CLI-test timeout повторён отдельно без изменения теста, retry2/2 PASS. Рабочая модель inactive, новых рабочих forecasts/reports0; существующий empty report воспроизводится. [Evidence](evidence/s3-07-v1-journal-owner-api-ui.json), [состояние](PROJECT_STATE.md), [журнал работ](PROGRESS.md). Для локальной установки Chromium в `.tools/playwright` тестам нужен `PLAYWRIGHT_BROWSERS_PATH`, указывающий на эту папку.
