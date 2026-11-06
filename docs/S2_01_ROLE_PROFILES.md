# S2-01 — роли из STRATZ/PandaScore и pro-истории

Реализовано по выбору владельца2026-11-04, вместо временно отложенного deployment. Срез описательный: роли не становятся признаками V1 Elo и не меняют исторические роли/identity evidence или сохранённые прогнозы.

**Упрощение редактора по решению владельца2026-11-04:** `role-editor-priority-v1` использует одну однозначную допустимую подсказку на игрока: PandaScore → STRATZ → pro-история. Расхождение показывается, но не требует согласия двух источников. Это отдельная UI-политика: versioned API `role-profile-consensus-v1`, его `rolePos`/`canAutoApply` и проверки identity/team/freshness не переписывались. Редактор выбирает только из кандидатов с `eligible:true`; неизвестная/конфликтная личность автоматическую роль не получает.

## Использование

Проверка на подготовленных реальных пятёрках и объяснение отсутствующей личной истории: [S2-01/role-owner-check](S2_01_ROLE_OWNER_CHECK.md). В списке ролей показаны ники из допустимых числовых source bindings и отдельное покрытие локальных pro-карт.

1. В редакторе сценария или форме будущей встречи выбрать локальную команду и пять игроков в любом порядке.
2. В «Сопоставление источников A/B» указать соответствующий ID команды STRATZ. После обновления профилей видны имена и team ID, сообщённые STRATZ; соответствие выбранной организации подтверждает владелец. Не приравнивать namespace ID автоматически.
3. Для PandaScore указать турнир и команду, сохранить соответствие и нажать «Обновить профили API». В форме будущей встречи эти provider IDs предварительно заполняются из выбранной встречи; это ещё не сохранённое сопоставление с локальной организацией.
4. Выбрать в списке заявки PandaScore запись для каждого локального игрока и сохранить. Неоднозначный ник/похожий ID не создают связь автоматически. Сопоставление сохраняется для команды; повторять при каждом запросе не нужно, при трансферах его следует пересмотреть.
5. Включённая «Автоподстановка ролей» расставляет выбранную пятёрку, когда для каждого игрока есть одна однозначная допустимая подсказка и получаются пять разных позиций. Приоритет: заявка PandaScore, профиль STRATZ, pro-история. Смешанная роль вроде4/5 сама не выбирается: используется следующий однозначный источник либо остаётся неизвестно. У подсказки показаны источник и пометка «Определено автоматически».
6. После выбора пяти любая ручная правка позиций/игроков сама выключает авто, включая правку до прихода первого ответа. Обновление профилей её не перезаписывает. Для новой автоматической расстановки явно включить авто либо нажать «Применить роли». Сохранённый сценарий открывается с выключенным авто. Герой и stand-in следуют за игроком, перестановка сбрасывает подтверждение состава.

При расхождении редактор показывает предупреждение и выбирает однозначную роль по приоритету. При неизвестных/совпавших позициях полная автоматическая перестановка не выполняется, оставшиеся роли не назначаются произвольно. Просроченные/недопустимые кандидаты исключены; при отсутствии профилей может автоматически примениться одна локальная pro-подсказка на игрока. Эта иерархия — удобство редактора, а не измеренная точность источников. Технические поля согласия API продолжают описывать прежний consensus и не управляют новым UI-авто.

## Политика данных

- STRATZ: только одиночный `player(steamAccountId:...)`; bulk endpoint не используется. Возвращённые account/profile IDs обязаны совпадать с запрошенным Steam32. Аккаунт читается через действующий verified identity resolver, конфликт или несколько verified accounts не выбираются произвольно. Прямое поле профиля — `proSteamAccount.position`; `teamId` обязан соответствовать сохранённому owner-selected team binding.
- PandaScore: отдельный named role client читает `/tournaments/:id/rosters` и сохраняет `role`; старый schedule adapter и его frozen contract не менялись. Provider player ID не Steam32. Owner-selected связи используются только для role hints, не являются новыми canonical account proofs и не объединяют pro-историю. Mixed `1/2` сохраняется как `[1,2]`.
- История: 90 дней, максимум20 последних подходящих карт игрока; сначала оценки в выбранной организации, при их отсутствии — за любые организации. Положительно pro, завершение не позднее cutoff, строго earlier start, verified numeric identity и source/receipt bindings сохраняются. Если внутри выбранной организации история неоднозначна, прежняя организация не устраняет эту неоднозначность.
- Профили текущие, `eventAt/knownAt=null`, `fetchedAt` — время получения. Исторический cutoff не превращает текущий профиль в as-of fact. API и UI явно показывают текущий характер профилей, N и период истории. Источники могут иметь общие первоисточники; согласование не является измеренной независимой уверенностью.
- Нет процентов уверенности, утверждения точности или официального участия в будущей карте. Сохранение сценария фиксирует выбранные владельцем позиции; дополнительный profile report не добавляется в старую схему immutable scenario/prediction snapshots. Для будущей role-aware модели понадобятся отдельные versioned feature/data/evaluation contracts.

## Настройка и эксплуатация

`ROLE_PROFILES_ENABLED=false` по умолчанию; `STRATZ_API_TOKEN` и `PANDASCORE_API_TOKEN` только server-side. В текущем локальном `.env` профили включены по запросу владельца, существующие ключи сохранены. Само открытие формы читает локальный кэш; HTTP-обновление запускается кнопкой владельца. Наличие ключа не запускает фоновые задания.

Кэш — один час, PostgreSQL lease30s и cooldown не короче60s. Просроченная запись остаётся видна для диагностики, но не участвует в авто. Максимум пять одиночных STRATZ и одна заявка PandaScore за refresh. STRATZ: общий между процессами лимит250/UTC day, spacing1200ms, учёт Retry-After/remaining-minute/day; PandaScore использует существующий общий quota с расписанием. Таймаут10s на HTTP, response≤2MiB, zero automatic HTTP retries, валидация ID/JSON/shape, 429/5xx/access/GraphQL errors и secret echo не передаются как сырые ответы. Отказ источника не скрывает доступную локальную аналитику.

Compose передаёт новый ключ и флаг только API. Production preflight проверяет синтаксис, ambient overrides и соответствие rendered environment; реальные Docker/Linux build/deploy этим не выполнены. Клиент не получает токены или provider URLs с ключом.

## API и SQL

- `POST /api/v1/lineup-role-profiles`: `teamId`, 1–5 разных `playerIds`, optional `cutoffAt`, `refreshProfiles=false`. Owner session, same-origin, CSRF, no-store; refresh route limit30/min. Ответ: source status/clocks/hash, identity status, binding revision, история, варианты и reasons каждого игрока, `canAutoApply`.
- `GET /api/v1/teams/:id/role-profile-binding`: текущая owner/team редакция либо revision0.
- `POST` на тот же URL: `requestId`, `expectedRevision`, `confirmedByOwner:true`, binding `{stratzTeamId,pandaTournamentId,pandaTeamId,pandaPlayers:[{playerId,providerPlayerId}]}`. Exact replay идемпотентен, stale/изменённый replay→409, неверный локальный ID/дубли→400. Редакции append-only и привязаны к owner; очистка выполняется новой редакцией с nullable IDs/пустыми links.

Migration035 добавляет `role_profile_bindings` (append-only metadata), `role_profile_cache` и `role_profile_stratz_quota`. Не переписывает001–034 и canonical identity/role tables. До применения сделан приватный pg_dump custom archive; `pg_restore --list` проверен, восстановление этого нового архива не выполнялось.

## Фактическая проверка

- Frozen offline install, typecheck, build PASS;750 unit/CLI,74 serial Node,19 targeted tests (включая10 PG/API),6 Chromium E2E. Мобильный screenshot просмотрен.
- Preflight: новая проверка сначала дала corrected red1, затем10/10 PASS. Первые browser-прогоны выявили несоответствие empty-copy и ошибки ожидания ответа/проверки несохранённой формы; диагностический isolated1 и итоговый полный6/6 PASS. Таймауты и configured retries0 не увеличивались; ранние логи сохранены. Одновременная перезапись dist сборкой исключена из финального браузерного прогона.
- Новый reader на рабочей истории: пять verified аккаунтов фактической прошлой стороны →5/5 свежих STRATZ профилей с позициями, пять HTTP requests, повтор из кэша0. Это диагностическая пятёрка, не сохранённый пользовательский сценарий. Binding revision0 оставлен для явной проверки владельцем; `canAutoApply:false` ожидаем без team binding.
- Новый Panda adapter: одна реальная заявка →32/32 непустых позиций, один HTTP request и сохранённый кэш. Это не замер точности/представительная Tier1 выборка.
- Working relations78→81;76 прежних fingerprints неизменны. Разрешённые изменения прежних таблиц: ledger новой миграции и shared Panda quota. Остальное новое — только profile cache/quota; bindings0, scenarios/predictions/training/activation writes0. Queued Aurora сохранена;150 исходных non-barrel runtime modules и43 защищённых артефакта неизменны, native compatibleV1Runtime:true, старый bundle проверен без исполнения его JS.

Полные PG/full owner E2E/Python/Docker/Linux suites в этом срезе не заявляются исполненными. [Evidence](evidence/s2-01-role-profile-reader.json).

Следующий точный шаг — **S2-01/role-owner-check**: один раз сопоставить источники выбранной текущей команды и проверить реальные расхождения. Для проверки/UI подходит GPT-6.1 Sol · High. Deployment остаётся отложен.


## Проверка упрощённой UI-политики2026-11-04

Owner-approved role-editor-priority-v1:8 новых pure tests +4 новых Chromium; всего763 unit/CLI,74 Node,19 unique Chromium и final6/6 PASS. Browser red reproduced single-history auto absence before fix. Final mobile screenshot inspected, no overflow. API/SQL unchanged, provider calls0; all81 working fingerprints/48 artifacts/150 original modules/35 SQL SHA preserved. Backend consensus report deliberately remains old version; UI uses eligible candidates and source priority. No role accuracy evaluation/model activation. [Evidence](evidence/s2-01-role-editor-priority.json).


UI acceptance5 ноября: [проверка](S2_01_ROLE_UI_ACCEPTANCE.md). Если свежего проверенного ника нет, подсказка может подписываться «Выбранный игрок: … · ID …» из текущего локального выбора. Такая подпись не подтверждает аккаунт/роль и не заменяет source evidence. Нечитаемый ник из одних комбинируемых символов показывается как ID; исходные записи остаются прежними.


Проверка5 ноября: [source-profiles](S2_01_ROLE_SOURCE_PROFILES.md). STRATZ teamId=0 нормализуется в неизвестную команду; профиль доступен для просмотра, автоматическая роль без совпадения команды запрещена. TTL1час сохранён; stale требует явного обновления. Общая заявка PandaScore повторно используется между командами одного турнира.


[Пояснения состояний источников](S2_01_ROLE_SOURCE_STATUS.md): отсутствующий профиль, неизвестная команда и устаревшие данные имеют разные сообщения и действия. Cooldown предлагает подождать, ручные роли сохраняются.


[Final acceptance](S2_01_ROLE_FINAL_ACCEPTANCE.md): saved upcoming fives now initialize with role auto OFF per side; owner can explicitly re-enable. Existing saved member order is not a verified pro position. Manual selected positions remain authoritative.
