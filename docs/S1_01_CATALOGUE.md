# S1-01 — локальные справочники и обзоры

## Реализованный срез

Главная страница после входа: вкладки «Команды / Игроки / Герои», поиск, 25 записей на страницу, ID и tag/internal name, отдельные syncedAt/metadataUpdatedAt. `/teams/:id` — организация и фактические участники последней доступной pro-карты. `/players/:id` — canonical player и catalogue account, без утверждения verified identity или текущей команды. Это базовая навигация FR-01/03/04, не завершение всех статистических требований этих FR.

`CatalogRepository` читает существующие таблицы. Новых миграций нет: 001–013 неизменны, следующий SQL 014+. Никаких fixture fallback или provider requests в HTTP. Справочник может быть неполным/пустым. Синтетика существует только в тестовых DB.

## Контракты и корректность

- Authenticated GET `/api/v1/teams`, `/players`, `/heroes`: query/limit/offset с Zod, literal case-insensitive substring search и точный decimal ID, стабильная сортировка lower(name), numeric ID, hasMore через limit+1. ID и count страницы не теряют bigint точность; неизвестный record ID — 404, некорректный — 400 с русским сообщением.
- Query bound values исключают SQL interpolation из поисковой строки. Закрытый enum задаёт таблицу/колонки; `%`/`_` не расширяют поиск как wildcard. Одинаковые имена остаются отдельными ID, nickname не объединяет игроков.
- Organization overview выбирает последнюю завершённую карту с is_pro IS TRUE, ingest_state!=conflict, started_at<cutoff и completion<=cutoff; затем берёт только её native map side. Не откатывается к старой полной пятёрке при partial последней карты. Metadata/map/members читаются в repeatable-read.
- Пять разных nonnull canonical IDs дают complete observed lineup. Неполные/неизвестные участники сохраняются как partial/null; current-members flags не читаются. Роли не назначаются по слоту. Наблюдавшийся состав не становится pre-match evidence или актуальной пятёркой. currentLineup всегда null в этом срезе.
- Player metadata не превращает legacy opendota_account_id в verified link. accountVerification=not_assessed; currentTeam=null. Персональная история через организации требует существующего identity boundary и последующих pro-only readers, не public totals.
- Source=local_catalog означает место чтения, не неподтверждённый provider source. syncedAt отражает только сохранённую sync отметку; metadataUpdatedAt — время локального изменения. У heroes нет проверенной source-fetch отметки, поэтому syncedAt=null. computedAt и latest-map startedAt также не подменяют друг друга.

## UI и lifecycle

Vue Query 5.105.0 установлен pnpm из registry; lockfile сгенерирован pnpm, frozen install выполнен. Query keys включают resource, kind, query/page или entity ID. Network запрос использует AbortSignal; retry=false, staleTime=0, gcTime=60s. Cache только в памяти, очищается при logout и 401; session expiry возвращает на login. Immutable historical caches этим срезом не создаются. [Официальный Vue Query quick start](https://tanstack.com/query/latest/docs/framework/vue/quick-start).

Loading/error/retry/empty states доступны с клавиатуры. Таблица прокручивается внутри контейнера на 360px. Даты явно UTC; отсутствие даты отображается «неизвестно». Рядом с observed lineup указан N=1 карта или N=0, native side и partial warning. «Перечитать базу» обновляет локальный read, не запускает загрузку у провайдера. Нет вымышленной WR, качества модели или вероятности.

## Проверки и ограничения

`pnpm test:catalog` использует реальный Fastify/owner session/PostgreSQL в disposable synthetic DB: auth/no-store, duplicates/bigint/pagination, literal search/injection text, invalid query/ID, nullable freshness, native side, public/unknown/future/incomplete/conflict exclusions, missing canonical IDs, отсутствие current-roster fallback. Contract tests проверяют invalid ID safeParse без броска BigInt exception.

`pnpm test:e2e` покрывает реальный login/logout и новый catalogue flow, detail/reload, desktop/360px screenshots, empty/error/retry и expired-session redirect. Synthetic HTTP 503/401 используются только в явно названном browser test; happy path идёт через реальную БД/API. Фактически выполненные результаты — [PROGRESS](PROGRESS.md).

Live source audit S0-08 не повторялся: importer/provider boundary не менялся. Sync admin UI, выбор A/B/сохранение сценария, manual roles и фильтрованные показатели относятся к дальнейшим задачам; они не подменяются каталогом. Следующая задача — **S1-02 [P0] Качественные pro-map выборки**; рекомендовано GPT-6.1 Sol · High по проектной routing matrix.
