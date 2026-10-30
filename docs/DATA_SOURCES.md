# Источники данных и техническая проверка

## OpenDota — основной источник

- Base: `https://api.opendota.com/api`
- Документация: `https://docs.opendota.com/`, `https://opendota.apidocumentation.com/`
- Основные: `GET /teams`, `/teams/{id}`, `/teams/{id}/players`, `/teams/{id}/matches`, `/proMatches`, `/matches/{id}`, `/heroes`, `/proPlayers`.
- Старые API-документы публиковали **50 000 запросов/месяц и 60/мин**. На 2026-10-30 актуальный OpenAPI имеет версию 31.1.1; defaults upstream-кода содержат 60/мин без ключа и 3000/день, что не гарантирует deployed-конфигурацию. В live spike получены remaining-minute/day headers, remaining-month отсутствовал. Проверенные ссылки и условия — [S0-01](S0_01_PROVIDER_SPIKE.md). Локальный клиент ограничен 45/мин и 25 попытками на запуск; durable общие дневные/месячные счётчики реализуются в S0-02, `OPENDOTA_MONTHLY_BUDGET` пока только целевой конфиг.
- `/players/{id}/matches`, `/players/{id}/heroes`, `/heroStats`, `/heroes/{id}/matchups` могут включать общие выборки: **не являются источником pro-only аналитики без соответствующего подтверждения**.

## Canonical import contract (checked against actual API responses at S0-01)

S0-01 реализует provider boundary и CLI, **не** canonical importer: `apps/api/src/providers/opendota/{schemas,client,spike}.ts`, `pnpm provider:spike`. Consumed fields проходят Zod без coercion строк в булевы/числа; ID преобразуются в десятичные строки только после проверки безопасного integer/decimal string. Нулевые team/series/account sentinel становятся `null` в typed projection; оригинальный UTF-8 body + SHA-256 сохраняются отдельно внутри observation и не попадают в stdout/отчёт. Неизвестные поля верхнего уровня исключены из projection; raw draft action order и дополнительные поля не удаляются из source observation.

Normalize OpenDota match object into:
`match_id`, `start_time` Unix seconds, `duration`, `radiant_win`, `radiant_team_id`, `dire_team_id`, `leagueid`, `players[]` (0..4,128..132), `picks_bans[]`, `radiant_score`, `dire_score`.

- `picks_bans` может отсутствовать; NULL и пустой массив — разные сигналы, указывать completeness.
- Аккаунт игрока может отсутствовать; хранить NULL, не создавать вымышленный account_id.
- Для proMatches принять факт pro-marking только из подтверждённого источника; не считать каждую detailed-map профессиональной.
- Убедиться на реальном матче, что `player_slot` и `picks_bans.team` маппятся правильно.
- Сырой ответ можно хранить как отдельный debug fixture **без персональных секретов** для повторяемого тестирования; очистить лишние поля.

## Rate limiting, retries и обновление

- Единая глобальная очередь для провайдера независимо от числа задач, максимум `OPENDOTA_RPM_BUDGET`, плюс месячный счётчик.
- Timeout, exponential backoff + jitter для 429/5xx/сетевых ошибок, уважать `Retry-After`. Не повторять бесконечно 4xx.
- Idempotent UPSERT по match_id, team OpenDota ID, player OpenDota ID; DB transaction на одну карту.
- Статусы: queued/partial/complete/unavailable. Запросы из браузера к OpenDota запрещены.
- Связь с источником и момент `synced_at` сохраняются, при stale-данных честная отметка.

## Остальные источники

- `dotaconstants` для справочников героев и патчей; сохранять версию набора.
- STRATZ: необязательный адаптер, выключен по умолчанию; возможные ограничения API/договора отдельно проверить.
- Dotabuff: **не парсить** и не обходить защиту сайта в MVP; допустим только как продуктовый референс.

## Patch metadata & change detection — обязательно

- Синхронизировать справочник patch ID/label и UTC release times из dotaconstants/OpenDota, сверять релизы и важные изменения с **официальными** новостями/patch notes Valve (`https://www.dota2.com/patches/`, `https://www.dota2.com/news`).
- Учитывать `7.41` и `7.41a` как **разные** патчи; severity по одному только номеру — гипотеза, не факт. Изменения отдельного героя фиксировать только с подтверждённой ссылкой; отсутствие строки ≠ отсутствие изменений.
- Для матчей на временной границе патча сохранять неизвестное значение, если нельзя доказать фактическую игровую версию. Иметь audit coverage таких матчей.
- При новом патче помечать derived features stale, обновлять registry и предупреждать об отсутствии репрезентативных pro-данных; prediction engine должен работать по договору `docs/PATCH_AWARE_ANALYTICS.md`.

## S0-01: обязательный API spike

Проверить несколько реальных pro матчей (включая неполный), отобразить в `docs/PROGRESS.md` реальные поля, их nullability, достаточность данных для статистики и ingestion strategy, оценить бюджет запросов и пригодность patch metadata. Только после этого писать массовый importer. Никаких придуманных данных.

## Roster reliability

По официальной документации OpenDota, `GET /teams/{team_id}/players` даёт исторических игроков и `is_current_team_member`, но **не подтверждает реальную пятёрку будущего матча**. Для сыгранности и actual map lineups нужна нормализованная детальная карта `/matches/{match_id}` и 5 валидных известных IDs каждой стороны. `GET /players/{account_id}/matches` сам по себе может содержать не-pro игры. Никнеймы и team tags не являются персональными первичными ключами. Reference: https://docs.opendota.com/ .

В S0-01 реально проверен также `GET /players/{account_id}`: profile — идентификатор источника, не pro-only статистика и не verified canonical merge. Значение membership flag может быть `null`; клиент различает true/false/unknown и не назначает роли/пятёрку. `proMatches` сохраняется как discovery evidence; adapter не выставляет `is_pro=true` и не подтверждает league/tier без отдельной политики.

## v8 Prediction data feasibility

Read [PREDICTION_DATA_SPEC.md](PREDICTION_DATA_SPEC.md); before training run `node scripts/audit-prediction-sources.mjs --sample 20 --out reports/opendota-coverage.json` in a networked environment. This audit measures source fields but **cannot** prove historical pre-start roster knowledge.
