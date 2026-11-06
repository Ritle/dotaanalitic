# S4/V1-schedule-freshness — актуальность расписания

Закрывает finding A01 из [аудита API](evidence/s1-09-api-usage-reliability-audit.json): раньше `not_started`, будущее начало и два участника могли допускать назначение по наблюдению многократной давности существующего кэша.

## Правило и использование

Operational policy `schedule-source-age-v1`: наблюдение **именно выбранной встречи** актуально, если `0 <= server_checked_at - source_fetched_at < 5 minutes`. Ровно 5 минут уже stale. Будущее/невалидное время источника отклоняется. Порог соответствует существующему schedule cache TTL; это ограничение допуска, а не статистическая гарантия достоверности расписания или коэффициент Elo.

В «Зафиксировать назначение первой карты» и на странице сохранённого назначения блок «Свежесть расписания» показывает время получения, причину недоступности и кнопку «Обновить расписание перед прогнозом». На открытой странице допуск истекает по прошедшему времени без автоматических запросов к провайдеру. Сервер перепроверяет его независимо от браузера.

Обновление использует существующий owner/session/CSRF `POST /api/v1/upcoming/refresh`: общий PostgreSQL lease, пятиминутный cache TTL, durable quota и Retry-After/cooldown. Нового провайдера, endpoint, обхода TTL или фонового polling нет. При ошибке сохраняется старое наблюдение для просмотра; оно не становится пригодным для новой выдачи. Отсутствие встречи в успешной новой первой странице не обновляет её `fetched_at` и не означает отмену. Такое состояние требует новых сведений источника; повторять запрос до окончания задержки бессмысленно.

Обновление сохраняет выбранный сценарий/пятёрки. Изменение нормализованных участников, времени или остальных полей встречи по-прежнему требует новой проверенной редакции назначения. История и исходные назначения/прогнозы доступны после устаревания. Exact UUID/hash retry возвращает прежнюю запись; новый UUID проходит свежую проверку.

## Границы API и БД

`GET /api/v1/upcoming/:id/target-preview` сохраняет прежний формат. Additive `FreshScheduleTargetRepository` дополняет `reasons` значениями `SCHEDULE_SOURCE_STALE` / `SCHEDULE_SOURCE_CLOCK_INVALID` и `eligible:false`. GET не вызывает provider HTTP. Перед новым scheduled HTTP forecast проверяется текущий источник; существующий request передаётся исходному executor для точного retry/conflict handling.

Ошибки новых сохранений/расчётов: HTTP409 `schedule_source_stale` или `schedule_source_clock_invalid`, с русским сообщением и requestId. Credentials не возвращаются. Статус/время/два участника, owner mapping, scenario revision, model/release/Tier1 gates продолжают проверяться.

Forward-only **044_schedule_freshness.sql** добавляет independent AFTER INSERT guards для `v1_schedule_targets` и `v1_runtime_snapshots`. Сравнение идёт по реальному `clock_timestamp()` и связанному immutable source observation. Финальная проверка после inference/ожиданий existing validation locks откатывает всю новую попытку, включая `prediction_runs`, если источник успел устареть. Работает для CLI/direct service, не только HTTP. Historical SQL001–043, исходные150 compiled modules, record formats, старые bytes/SHA, release protocol и Elo kernel сохраняются. Новые modules попадают в существующий runtime code manifest; policy дополнительно закреплена именем SQL-функции/миграцией.

В будущем изменение срока требует новой policy/migration и проверок; здесь порог не является owner-controlled полем запроса. Отдельные тесты сверяют TS и PostgreSQL на микросекундных границах, чтобы Date округления не меняли решение. Проверка будущего `fetched_at` также поддержана уже существующим source-table constraint.

## Проверка

Новые regression cases покрывают старый источник с недавним recorded_at, новые страницы без выбранной встречи, future clocks, exact retries, прямой CLI/service, истечение срока во время расчёта и TS/SQL parity. Browser cases проверяют запрет/обновление, сохранение выбранного сценария, persistent cooldown после ошибки/reload, omission и истечение на открытой странице без provider polling. Итоговые результаты и рабочая проверка фиксируются после QA в PROGRESS и evidence.

Этот срез не подтверждает качество модели и не активирует её. Следующий точный шаг — **S3-01/V1-evaluation: проверка готовности независимого release protocol/collector**, затем оценка по неизменному календарю. Зарегистрированная оценка не ранее **2 декабря 2026, 03:00 МСК**; более ранний scoring не разрешён этим изменением. Рекомендуемая модель следующего этапа — **GPT-6 Astra · Extra High**.


## Выполненная проверка 5 ноября 2026

Frozen offline install, финальные root typecheck/build,825 unit/CLI,74 Node,47 PG/API в6 suites и11 Chromium в4 suites — PASS. Синтетический regression case с270-minute источником сначала воспроизвёл ошибку; исправлены fractional-time parsing и eager import cycle, после них общий прогон прошёл заново. Проверены SQL/TS микросекундные границы и rollback при истечении срока во время расчёта. Full PG/Chromium/Python/Docker/Linux suites не запускались.

Live YeS—GL1756313: финальное read-only наблюдение уже актуален, повторное чтение — eligible, русский статус/кнопка и cooldown отображаются; bounded refresh POSTs=1. Выбранные5+5 сохранены,360px без переполнения/page errors. Назначения, сценарии, история и прогнозы не записывались. SQL044 применена и повторно SKIP; API PID9100, отдельный history worker17732 сохранён, general worker не запускался. Сохранены245 files/150 исходных compiled modules/frozen bundle/340 карт3400 slots/1288 receipts/10 reports/3 other jobs и модельные записи; active0. [evidence](evidence/s4-v1-schedule-freshness.json).

Следующий точный шаг: **S3-01/V1-evaluation/readiness**, GPT-6 Astra · Extra High; ранний scoring/активация не выполнялись.

Первый browser run имел4 ошибки подготовки нового fixture: переход выполнялся до завершения входа. Стандартное ожидание authenticated heading исправило гонку; финальный отдельный прогон всех11 — PASS. В рабочей проверке подтверждён один refresh HTTP200: старое наблюдение31 было получено примерно107 минут назад, новое32 сохранено с фактическим временем получения. Финальное чтение не делало дополнительного refresh. Диагностика сравнивает числовые IDs по каждой команде: существующие автоматические подсказки ролей могут переставить строки во время загрузки, составы5+5 при этом не изменились; owner bindings не сохранялись.
