# Источники данных и техническая проверка

## Valve IGCVersion_570 — активная техническая версия, S1-07

Проверка2026-11-01:4 backend GET/4 HTTP200, raw snapshots/SHA включены в репозиторий. GetClientVersion и GetServerVersion сообщили active_version6969; UpToDateCheck(app570,version0) — required_version37. Official API list подтвердил два IGC GET метода. Сохранённое наблюдение пригодно как technical-version fact, но буквенный patchLabel и связь6969→7.41f не доказаны; prospective patch proof не создан. Нельзя приравнять одноимённое поле active_version к reviewed balance-patch evidence. [Acceptance policy/ограничения](S1_07_ACTIVE_VERSION_SOURCE.md), [manifest](evidence/s1-07-active-version-source-review.json).

## BALLDONTLIE — проверка доступа 2026-11-01

По прямому запросу владельца проведён bounded read-only audit с локальным `BALLDONTLIE_API_TOKEN`: 3 GET, интервал не менее13с, timeout25с, без повторов/автопагинации. `GET /dota/v1/teams?search=GamerLegion` →200, одна команда с provider ID113. `GET /dota/v1/matches?dates[]=2026-11-02&per_page=25` и `/tournaments?per_page=5` →401 с body `Unauthorized`. Ключ принимается справочником, но доступ к матчам/турнирам не подтверждён. По документации401 означает неверный ключ **или** отсутствие доступа к endpoint; точный тариф аккаунта не установлен. Не считать401 пустым расписанием или отсутствием встречи.

Расписание GamerLegion—CyberHero, турнирные составы и завершённые карты через этот источник пока не проверены. Тарифная документация относит турниры/составы к ALL-STAR+, матчи/карты/статистику к GOAT. Следующий шаг: владелец проверяет доступ именно к Dota 2 в dashboard; после исправления повторить bounded audit выбранной встречи/пятёрок/исторических карт. Покупка/активация trial не выполнялась. [Документация и тарифы](https://dota2.balldontlie.io/#account-tiers), [ошибки](https://dota2.balldontlie.io/#error-codes), [manifest](evidence/balldontlie-access-audit.json).

Source IDs остаются отдельным namespace; nickname joins, DB import, training и изменение gates не выполнялись. Full local captures и одноразовый probe находятся в ignored `.tools/balldontlie-audit/`; manifest содержит только URL/время/status/SHA без credential/header. Это проверка доступа, не production client и не доказательство live coverage платных endpoints.

## OpenDota — основной источник

### S1-08: воспроизводимая диагностика патчей

Офлайн pnpm patch:diagnose принимает SHA-bound map audits v3, pinned raw constants и schema projection Valve list. Source code/coarse label/latest declared feed label/nullable verified patch показаны отдельно. На шести сохранённых live audits40 observations дали36 unique pro maps,4 duplicate; повторные отчёты побайтно совпали, новых HTTP0 и canonical assignments0. Native OpenDota dates без миллисекунд нормализуются, противоречивые timeline/коды не принимаются молча. [Контракт и происхождение inputs](S1_08_PATCH_DIAGNOSTICS_CLI.md), [manifest](evidence/s1-08-patch-diagnostics.json).

### S1-08: patch code60 — первичная проверка2026-11-01

Pinned odota/dotaconstants определяет60 как7.41; odota/core вычисляет индекс по start_time и датам, после последней записи возвращает60. Буквенные7.41a–f этим кодом не различаются; это не независимое измерение версии. Valve list/notes/Steam подтверждают наличие опубликованной7.41f; notes/news timestamps расходятся на42265с, точные release/coverage/knownAt не доказаны.14 GET/14 HTTP200 (7 GitHub +7 Valve),16 карт повторно дали60, canonical assignments0; DB writes0. [Pinned primary sources, timestamps и решение](S1_08_PATCH60_SOURCE_AUDIT.md), [SHA manifest](evidence/s1-08-patch60-source-audit.json). Использовать labels только в диагностике с provenance.

### S1-08: пересечение patch/as-of evidence с рабочим корпусом

Инвентаризация2026-11-01 без новых Dota HTTP:36 карт/6 source patch codes,27 точных ID/start совпадений с прежним40-map audit. Для20 исторических карт есть только nominal feed candidates7.29d/7.30d/7.32c/7.34d/7.37c; code60 у16 недавних карт остаётся без candidate (7 старых open-interval observations,9 вне того audit).5 archive proofs относятся только к announcement body7.34d, не к deployment/hero availability. Canonical registry пуст; strict pre/post0 eligible. [Матрица, источники и границы](S1_08_PATCH_CONTEXT_INVENTORY.md), [manifest](evidence/s1-08-patch-context-inventory.json). Следующий источник для проверки — определение code60 и официальные Valve metadata; старый архивный body повторно не искать.

### S1-08: BO2 — подтверждение формата 2026-11-01

Valve GetLeagueData для16935 сопоставляет series_type3 с node_type4 в24 однозначных группах, включая903379/903582; одна type3 запись без однозначного node остаётся вне подтверждённого сопоставления. Pinned SteamTracking protobuf dump определяет ELeagueNodeType.BEST_OF_TWO=4; зеркало не принадлежит Valve. Это разные enums: series_type4 остаётся unsupported. [URL, SHA, временные отметки и numeric IDs](evidence/s1-08-bo2-source.json), [контракт и первичные ссылки](S1_08_SERIES_PROVISION.md).

Policy v2 зарегистрировала последние2 серии; reimport прежних captured OpenDota maps без HTTP дал series coverage36/36 и28 групп. BO2 допускает1:1; winner/status/порядок/предшествующий счёт не выводятся. Текущие official metadata не превращаются в исторический knownAt, training/model gates закрыты. [Применение и проверки](evidence/s1-08-bo2-series.json). Следующие разделы фиксируют предыдущие состояния корпуса.

### S1-08: расширение исторической выборки 2026-11-01

Добавлены20 completed pro-карт: по5 равномерных временных рангов в лигах13256/14268/15728/16935. Это повтор прежней S0-08 sampling policy на свежих данных, без отбора по победителю/полноте. Лига2021 включает июнь/июль: не считать все её карты основным этапом TI. Перед импортом штатный `audit-prediction-sources.mjs --league ID --sample 5` выполнил28 HTTP200. Named client затем сохранил20 подробных ответов и2 каталога (22 HTTP200); все20 detail SHA совпали с audit. Бюджет максимум84 audit +66 capture attempts, реально50, ошибок0. Дополнительный download нужен потому, что league audit не сохраняет полный replay capture.

До apply проверены20 уникальных IDs/0 уже импортированных, positive league tier, completed outcome, schema/endpoints/SHA/clocks. Существующий IngestionService использовал только проверенные captured observations;20 новых карт,0 conflict, повтор20 duplicate/0 HTTP с неизменными inventory/revisions/counters. Существующие16 карт сохранены. Сейчас36 карт/6 лиг/7 UTC месяцев/6 source patch codes; outcome/heroes/teams36/36, canonical players17/36, series16/36.209/360 participant links разрешены;106 source accounts пока unknown. Ни nickname joins, ни backdating/series/identity proofs не выполнялись. Canonical patch и pre-start контекст неизвестны, strict pre/post preview36 candidates/0 eligible.

[Manifest/SHA/точные IDs](evidence/s1-08-expansion-manifest.json), [preview](evidence/s1-08-expansion-plan.json), [apply](evidence/s1-08-expansion-apply.json), [replay](evidence/s1-08-expansion-replay.json), [качество](evidence/s1-08-expansion-quality.json). Четыре полных audit reports связаны через manifest. Full raw capture и одноразовый orchestration helper остаются локально в ignored `.tools/s1-08-expansion-capture.json` / `.tools/s1-08-expand.mjs`; checkout без них не воспроизводит exact bytes. Helper вызывает существующие exported runtime/importer/quality boundaries; production CLI/API/SQL не изменены. `node --env-file-if-exists=.env .tools/s1-08-expand.mjs replay` возможен только с локальными plan/capture и новым именем выходного отчёта; текущие immutable файлы не перезаписывать. Новый network capture требует нового аудита/плана и повторного review.

Следующий checkpoint выполнен без новых HTTP:18 поддерживаемых source series зарегистрированы через `series:provision`; после reimport series coverage34/36, registry26. Две группы903379/903582 с `series_type=3` остаются unknown, decoder policy не расширялась. [Evidence](evidence/s1-08-historical-series.json).

Historical identity checkpoint завершён:83 из106 unknown IDs подтверждены двумя сохранёнными `/proPlayers`;23 отсутствующих в registry проверены отдельными `/players/{id}` (23 HTTP200 из max69 attempts). Existing reviewed-current-accounts/profile policies создали106 distinct canonical players/account proofs/aliases без nickname merge. Source-specific knownAt=fetchedAt сохранён; старые identities не переписаны. Reimport19 изменений/1 duplicate, повтор20 duplicate/0 HTTP; теперь165/165 source accounts,360/360 slots, complete players36/36. [Evidence](evidence/s1-08-historical-accounts.json). Следующий шаг — независимая проверка значения series enum3; broad corpus/temporal backtest/model gates открыты, strict eligible0.

- Base: `https://api.opendota.com/api`
- Документация: `https://docs.opendota.com/`, `https://opendota.apidocumentation.com/`
- Основные: `GET /teams`, `/teams/{id}`, `/teams/{id}/players`, `/teams/{id}/matches`, `/proMatches`, `/matches/{id}`, `/heroes`, `/proPlayers`.
- Старые API-документы публиковали **50 000 запросов/месяц и 60/мин**. На 2026-10-30 актуальный OpenAPI имеет версию 31.1.1; defaults upstream-кода содержат 60/мин без ключа и 3000/день, что не гарантирует deployed-конфигурацию. В live spike получены remaining-minute/day headers, remaining-month отсутствовал. Проверенные ссылки и условия — [S0-01](S0_01_PROVIDER_SPIKE.md). С S0-02 все live entry points используют shared PostgreSQL quota: defaults 45/мин, 2000/день, 45000/месяц, UTC reset, Retry-After/remaining headers. Дополнительно каждый CLI/job ограничивает число собственных попыток; restart не обнуляет общую квоту.
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

- PandaScore: owner-selected source для расписания и expected tournament rosters; основной источник фактических карт/статистики остаётся OpenDota. `schedule:audit` реализует ручной bounded spike с приватным Bearer token. Живые20 upcoming rows и турнир22231/8 teams/5+5 нужных игроков проверены2026-11-01. PandaScore match/player/team IDs — отдельный namespace; canonical mapping не создаётся по никам. Заявки не гарантируют map attendance. S1-10 добавляет защищённый API/UI, PostgreSQL cache5мин и общую runtime quota900/час. Обновление ручное; автоматических jobs пока нет. [S1-10](S1_10_UPCOMING_UI.md). [S1-09](S1_09_UPCOMING_SOURCE.md).

- `dotaconstants` для справочников героев и патчей; сохранять версию набора.
- STRATZ: необязательный адаптер, выключен по умолчанию; возможные ограничения API/договора отдельно проверить.
- Dotabuff: **не парсить** и не обходить защиту сайта в MVP; допустим только как продуктовый референс.

## Patch metadata & change detection — обязательно

- Синхронизировать справочник patch ID/label и UTC release times из dotaconstants/OpenDota, сверять релизы и важные изменения с **официальными** новостями/patch notes Valve (`https://www.dota2.com/patches/`, `https://www.dota2.com/news`).
- Учитывать `7.41` и `7.41a` как **разные** патчи; severity по одному только номеру — гипотеза, не факт. Изменения отдельного героя фиксировать только с подтверждённой ссылкой; отсутствие строки ≠ отсутствие изменений.
- Для матчей на временной границе патча сохранять неизвестное значение, если нельзя доказать фактическую игровую версию. Иметь audit coverage таких матчей.
- При новом патче помечать derived features stale, обновлять registry и предупреждать об отсутствии репрезентативных pro-данных; prediction engine должен работать по договору `docs/PATCH_AWARE_ANALYTICS.md`.

S1-07 live primary audit: официальный `/datafeed/patchnoteslist` и `/datafeed/patchnotes` не согласованы по времени с Steam app570 announcements для7.34c/d/e. **Не считать patch_timestamp или news.date verified effective release.** `pnpm patch:sources` сохраняет bounded projection/SHA, не принимает severity/availability/knownAt автоматически; нет NLP или DB writes. [Факты и ограничения](S1_07_SOURCE_EVIDENCE.md).

## S0-01: обязательный API spike

Проверить несколько реальных pro матчей (включая неполный), отобразить в `docs/PROGRESS.md` реальные поля, их nullability, достаточность данных для статистики и ingestion strategy, оценить бюджет запросов и пригодность patch metadata. Только после этого писать массовый importer. Никаких придуманных данных.

## Roster reliability

По официальной документации OpenDota, `GET /teams/{team_id}/players` даёт исторических игроков и `is_current_team_member`, но **не подтверждает реальную пятёрку будущего матча**. Для сыгранности и actual map lineups нужна нормализованная детальная карта `/matches/{match_id}` и 5 валидных известных IDs каждой стороны. `GET /players/{account_id}/matches` сам по себе может содержать не-pro игры. Никнеймы и team tags не являются персональными первичными ключами. Reference: https://docs.opendota.com/ .

В S0-01 реально проверен также `GET /players/{account_id}`: profile — идентификатор источника, не pro-only статистика и не verified canonical merge. Значение membership flag может быть `null`; клиент различает true/false/unknown и не назначает роли/пятёрку. `proMatches` сохраняется как discovery evidence; adapter не выставляет `is_pro=true` и не подтверждает league/tier без отдельной политики.

## v8 Prediction data feasibility

Read [PREDICTION_DATA_SPEC.md](PREDICTION_DATA_SPEC.md); before training run `pnpm provider:audit --sample 20 --out reports/opendota-coverage.json` with network, configured DB and migration 007. Offline `--fixture` remains available directly via Node. This audit measures source fields but **cannot** prove historical pre-start roster knowledge.

## S0-02: текущий canonical importer

Provider client/schema теперь находятся в `packages/ingestion/src/opendota`; старые API exports совместимы. `IngestionService` сохраняет immutable receipt перед catalog lookup, минимальную source projection + исходный body SHA, отдельный raw draft и field observations. Полный body/chat/profile не сохраняются. Typed repositories используют `@dota/db`/Kysely, очередь — `apps/worker`/pg-boss.

Профессиональность подтверждается отдельной политикой по `/leagues`: ровно одно совпадение ID, tier `professional`/`premium`; `amateur`/`excluded` false, прочее null. Outcome требует завершения карты. Справочники и политика версионированы; это не historic known-as-of. Player histories объединяются только существующими verified account links, source account хранится отдельно. Missing team/series не уничтожают valid final heroes, patch/roles/first pick остаются unknown без доказательства.

Конфликт известных фактов сохраняет старое canonical значение и новую source revision; карта получает conflict и `is_pro=null`. Raw 0/11/12 picks не обрезаются, `draft_order_valid=null` до historical mode/patch rules. [Отчёт S0-02](S0_02_INGESTION.md) содержит live повтор карты, проверки и CLI. Одна импортированная карта не закрывает исторические S0-08/09 или model gates.

## S0-08 — bounded source coverage

2026-10-31 выполнены 20 recent и 20 исторических карт TI-лиг 2021–2024 через --league. Клиент использует typed /leagues/{id}/matches, те же quota/timeout/retry ограничения; requestStats считает все HTTP attempts, включая recovered 429/5xx. Audit schema 3 публикует observability, source hashes и отдельную coverage для confirmed-pro subset; historic known-at остаётся неоценённым. [Evidence и ограничения](S0_08_SOURCE_AUDIT.md).
