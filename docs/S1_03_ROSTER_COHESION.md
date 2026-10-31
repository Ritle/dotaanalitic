# S1-03 — выбранная пятёрка, совместные карты и замены

Реализован описательный срез FR-03a: `POST /api/v1/teams/:id/roster-cohesion` и ручной редактор на странице организации. Запрос читает локальную БД и ничего не сохраняет. Cookie, Origin и CSRF обязательны, ответы `no-store`. Сохранение 5+5 сценария, expected lineup, optimistic revision и scenario endpoints остаётся **S2-01**; история предсказаний не изменяется.

## Вход и границы

- Strict JSON: `lineup` — пять `{playerId:string|null, rolePos:1..5, isStandin:boolean=false}`; роли уникальны, непустые canonical IDs уникальны и существуют в каталоге. `expectedLineup` — такая же пятёрка или `null` (default). Пустые слоты явно неизвестны.
- Optional `fromAt`, `cutoffAt`: UTC ISO с миллисекундами. Начало включительно, старт карты строго раньше cutoff, завершение не позже cutoff. SQL проверяет микросекунды до преобразования в JS Date. Future cutoff/invalid input/unknown player — 400, unknown organization — 404.
- Default: вся доступная **локальная** история до времени запроса. Recent = последние 90 дней до cutoff в пределах выбранного периода. Организационный churn = последние 20 eligible карт того же периода.
- Candidate discovery включает организацию и любые source accounts выбранных/базовых игроков, независимо от прежнего тега. Более 5000 кандидатов — `status:unavailable`, `WINDOW_TOO_LARGE`, без статистики; требуется сузить период. Никакой скрытой last-N обрезки co-play.
- `scope:retrospective_descriptive`, `policyVersion:roster-display-v1`. Текущая проверенная identity/release/role evidence допустима для описания истории, **не** доказывает historical known-at. Для обучения и прогнозов нужен отдельный as-of reader. `model:null`, `predictionEligibility:not_assessed`.

## Подсчёты и неизвестные данные

- Только `is_pro IS TRUE`, без source conflict, с завершённым известным исходом. Источник игроков — native `player_slot` 0–4/128–132 и заново проверенные source-account links. Ник, membership flags и cached canonical projections не подтверждают личность.
- Exact-five и каждая из десяти unordered пар используют только полные пять подтверждённых уникальных личностей на стороне. Пары учитываются через **любые организации**, карта один раз на пару. Сумма pair N не является числом карт. Встреча пары друг против друга не является co-play.
- Дубликат canonical ID на разных слотах обнуляет атрибуцию обеих сторон этой карты и увеличивает `duplicateIdentityMaps`; дубликат map ID в pure builder отвергается. DB discovery не размножает карты через JOIN. Неполные исторические стороны исключены из exact/pair counts и видны в coverage; личная история достоверно определённого игрока может оставаться доступной.
- Непроверенный выбранный ID → `nRaw:null` для его личной истории и затронутых пар/пятёрки. Проверенный ID без наблюдений → `nRaw:0`, `winRate:null`, даты null. Ноль не означает плохую сыгранность; история локальной БД не объявляется полной.
- Exact-five/pairs/player samples: raw N, wins, nullable observed rate, recent N, первая/последняя дата, последнее sync, распределение по проверенным патчам (включая null). Существующий source patch hint не становится verified release evidence. Веса и smoothing не применяются; `n_eff` не имитируется.
- Личная история сохраняется через организации; observed first/last dates по organization — даты участия, **не** гарантированные периоды контракта/членства. Ролевая история принимает только согласованную ref-linked confirmed evidence с confidence null/1, совпадающую со слотом и canonical ID. Inferred/conflicting/duplicate side-role positions остаются null. `confirmedRoleMaps` и `selectedRoleMaps` имеют знаменатель личного N и не меняют fingerprint пятёрки.
- Expected comparison — структурное сравнение явно введённых canonical IDs: retained/changed players, retained/lost/added pair links, role changes. Если одна пятёрка неполна или expected отсутствует, comparison=null. Ручные ID задают гипотезу, не официальное участие. Для базовой пятёрки возвращаются отдельные исторические samples. Stand-in не меняет расчёт силы/вероятности и не получает штраф.
- Churn сравнивает соседние фактические pro-карты организации. Неполная промежуточная карта не пропускается; её переходы неизвестны. `uniqueFives` неизвестно при неполном окне, `changedTransitions` неизвестно при пропусках или отсутствии переходов. `meanRetainedPlayers` — среднее только по `knownTransitions`, оба счётчика возвращаются явно.

## Аудит и интерфейс

Repeatable-read охватывает карты, identity и registry. Ответ содержит input snapshot, effective cutoff/recentFrom/snapshotAt, policy/source/identity/registry revisions и per-map dataRevision, source clocks и proof IDs. Это текущий ответ, не immutable сохранённый prediction snapshot. Coverage candidates/exclusions относится к объединённому candidate window; eligibleMaps — уникальные завершённые pro-карты, incompleteSides — стороны, не карты.

Vue Query key включает team ID и весь submitted input; смена ID/роли/stand-in/даты/baseline убирает прежний результат, повтор одинакового запроса перечитывает БД. AbortSignal, logout/401 cache clear, explicit unknown/empty/error states. На 360px таблицы прокручиваются внутри контейнера. Поле роли — ручное назначение пользователем, не вывод из membership.

`@dota/analytics` теперь имеет compiled ESM/declarations и workspace dependency из db. pnpm обновил только локальную workspace-связь в lockfile; новых внешних библиотек нет. Общий `readProMapInventory` сохраняет S1-02 selection boundary. SQL 001–013 не менялись; миграция не нужна.

Проверки: pure roster/contract cases входят в `pnpm test`; `pnpm test:roster` использует временную PostgreSQL БД и реальный HTTP inject; Chromium flow — `pnpm test:e2e`. Синтетические личности и карты не попадают в рабочую БД. Следующий этап: **S1-04 — Игрок × герой × позиция**.
