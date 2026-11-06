# S3-07/V1-schedule-target-registration — назначение будущей карты

**Продолжение2026-11-05:** [проверка свежести расписания](S4_V1_SCHEDULE_FRESHNESS.md) вводит operational age limit 5 минут для новых назначений/прогнозов и отдельный refresh UI. Форматы сохранённых записей и exact retries сохранены; текст ниже описывает исходный checkpoint.

**Продолжение2026-11-03:** [связь с ручным сценарием и runtime через CLI реализована](S3_07_V1_SCHEDULED_RUNTIME.md). Ниже сохранён scope первоначального checkpoint регистрации. Следующий срез — S3-07/V1-scheduled-result-binding.

Срез реализует сохранение выбранной встречи расписания до её начала, даже если OpenDota ещё не выдал идентификатор серии. Это первая часть schedule-target adapter: отдельное immutable назначение карты 1 с ручным сопоставлением организаций. Оно **не выдаёт прогноз**, не связывает результат и не меняет существующий runtime/quality gate. Полный S3-07 остаётся открытым.

## Почему отдельная запись

PandaScore match ID обозначает встречу источника; его нельзя записывать как OpenDota series_id или canonical match_id. Существующий [real-target runtime](S3_07_V1_REAL_TARGET.md) требует OpenDota series ID. Поэтому source-first назначение хранится отдельно, а будущая связь с runtime и проверенной картой потребует собственных versioned contracts. Сохранение этой записи не превращает прежний what-if сценарий в prospective forecast.

## Использование

1. На `/upcoming` обновить расписание и выбрать встречу.
2. Открыть «Зафиксировать назначение первой карты».
3. Явно выбрать участника источника для A и две разные команды локального справочника; B — другой участник источника. A/B не означают Radiant/Dire. Равенство названий не устанавливает идентичность.
4. При необходимости указать ID локального турнира, добавить HTTPS-источник и обоснование сопоставления, подтвердить выбор.
5. Сохранить и открыть постоянную страницу `/schedule-targets/:requestId`. Её можно добавить в закладки; она работает и после исчезновения встречи из первой страницы расписания.

Новый POST допускается только для `not_started`, известного будущего времени и двух разных участников. Перенос/смена соперника или новая редакция требуют перечитать источник и подтвердить выбор. Существующий запрос можно точно повторить после потери ответа, в том числе после начала встречи; это чтение прежнего результата, не новая запись задним числом. История показывает последние 20 редакций; API имеет exclusive cursor. Глобальный список всех сохранённых назначений пока не реализован.

Состав 5v5, сценарий и прогноз в этой записи **не сохраняются**. Ручное сопоставление организаций не подтверждает участие игроков и не задаёт Tier 1. Проверка турнира для выпуска остаётся отдельным gate.

## Источник, часы и неизменность

Используются только уже сохранённые `upcoming_source_observations`; новые endpoints не вызывают внешние API. Поиск ограничен последними 200 наблюдениями первой страницы расписания. Выбирается последнее появление нужного provider ID. Пропуск встречи в более поздних частичных страницах не означает отмену: число таких страниц сохраняется и показывается. При повреждённом новом источнике нет молчаливого возврата к старому.

Запись замораживает нормализованную встречу, provider IDs, snapshot/raw-payload SHA, endpoint/adapter, `fetchedAt`, серверный `recordedAt`, `knownAt:null`, ручное сопоставление и серверный `selectedAt`. Время получения не выдаётся за время первоначального объявления. Нет выдуманного срока достоверности: показывается реальное время источника и предупреждение о пропусках.

SQL030 добавляет `v1_schedule_targets`: owner/provider-match/revision, request UUID/hash, parent SHA и source FK. Короткая SHARE-блокировка публикации observations защищает финальную проверку источника; сетевых запросов внутри транзакции нет. Per-owner advisory lock обеспечивает exact retry и compare-and-swap редакции. SQL проверяет актуальную source binding, будущее время, разные команды, canonical catalog, pending/null и защищает от UPDATE/DELETE/TRUNCATE. Смена данных создаёт новую редакцию; предыдущие bytes остаются прежними.

## API

| Метод | Путь | Результат |
|---|---|---|
| GET | `/api/v1/upcoming/:id/target-preview` | Source observation, checkedAt, eligibility/reasons, omissions |
| GET | `/api/v1/upcoming/:id/targets?beforeRevision=…` | До 20 owner-scoped редакций, nextBeforeRevision |
| POST | `/api/v1/schedule-targets` | Сохранённые record + SHA; exact request retry |
| GET | `/api/v1/schedule-targets/:requestId` | Неизменная запись, независимо от текущего расписания |

Все маршруты приватные, session/no-store; POST требует CSRF/Origin и ограничен 12 запросами в минуту. Строгий Zod body: requestId, providerMatchId, observationId/SHA, expectedRevision, mapNumber=1, providerTeamAId/BId, teamAId/BId, nullable leagueId, reviewSourceUrl/reason. Пользовательские timestamps, результат, вероятность и OpenDota ID отвергаются. В HTTP нет owner ID или provider token. Невалидный запрос400, чужая/отсутствующая сохранённая запись404, изменившийся source/revision409, нарушение integrity503.

## Проверка и ограничения

Синтетические fixtures используются только в disposable PostgreSQL и browser tests. Покрыты авторизация/CSRF, большие строковые IDs, перестановка A/B, exact retry, конкурирующий повтор, CAS, перенос/начавшаяся встреча/неизвестное время, неполные/изменившиеся соперники, пропуск на частичной странице, повреждение source, SQL immutable/forged-probability guards и восстановление после потери ответа. Рабочие прогнозы и synthetic назначения не создаются.

Итог2026-11-03:700 unique unit/CLI,82 isolated PostgreSQL,22 browser PASS; frozen install/typecheck/build, финальная web build,30 migrations/docs/diff PASS. Один прежний20s CLI timeout прошёл отдельно без изменения лимита; оставшиеся workspace tests выполнены последовательно. Первый browser run пересёкся с shared rebuild; после сборки неизменённый22-test набор прошёл. Финальная форма повторно проверена после визуального исправления textarea. SQL030 применена;22 protected artifacts, SQL001–029,21 table fingerprints, E0/232 feature rows/frozen runtime сохранены. Команды и ограничения — [PROGRESS](PROGRESS.md); [машиночитаемое evidence](evidence/s3-07-v1-schedule-target-registration.json).

**Следующий точный срез — S3-07/V1-scheduled-runtime-binding:** versioned runtime input со ссылкой на immutable schedule-target revision/SHA и выбранные 5v5; pre-start time guards, independent model/coverage/Tier 1 gates, pending-result snapshot. Не требовать неизвестный OpenDota ID до игры и не отождествлять его с PandaScore ID. Последующее verified result binding должно отдельно доказывать серию/номер карты/ориентацию и сохранять исходный прогноз. Модель для следующего среза: GPT-6 Astra · High.
