# S2-02 — Draft Lab одной карты

Владелец продолжил конкретно предложенную S2-02 после S2-01. S1-07 остаётся открытой: никакие герои, данные источников или сохранённые сценарии не включают production probabilities/training.

## Контракт и интерфейс

`ScenarioInputSchema` расширен optional `draft: {assignments,bans}` и optional nullable `context.leagueId`. Assignment — `{teamSlot:'A'|'B',rolePos:1..5,heroId:int32}`; от0 до10 назначений. Ban — `{teamSlot,heroId}`. Слоты и hero IDs уникальны; один герой не может одновременно быть назначен/забанен. Ограничение40 банов — технический предел размера запроса, не утверждение об исторических правилах режима.

Ручные player IDs/роли остаются в lineup5+5; assignment связывается по slot+role, поэтому смена героя/игрока/роли меняет полный вход и revision. Team A/B не становятся Radiant/Dire/first pick. Hero IDs — SQL int32, player/team/league bigint — строки. Все герои и лига должны существовать в локальном каталоге; источник не вызывается браузером.

`/scenarios/:id/draft` открывает тот же атомарный редактор с Draft Lab. Есть поиск имён/ID в локальном каталоге,10 селекторов player-role-hero, необязательные unordered bans с явной стороной, удаление/очистка назначений и предупреждения. Поиск не удаляет выбранного героя, который отсутствует в текущем результате. Повторы отвергаются контрактом/API; при временной перестановке их можно исправить в форме до сохранения.

`POST /api/v1/scenarios/draft-check` — owner/CSRF/no-store, полный ScenarioInput, stateless preview `DraftAssessmentSchema`. Не создаёт scenario, receipt или подтверждение владельца; UI может проверить ввод до финального checkbox. Результат привязан к конкретному введённому состоянию и сбрасывается при правках. Ошибки каталога/контракта400. Предварительная проверка не заменяет серверную проверку сохранения.

Создание/редактирование остаётся единственным полным `POST /scenarios` / `PUT /scenarios/:id {expectedRevision,input}`. Подтверждённая недоступность любого указанного пика/бана даёт422 `DRAFT_UNAVAILABLE`, без изменения revision/проекций/истории. При unknown/conflict сценарий сохраняется с явным предупреждением. Отдельный planned `PUT /:id/draft` не реализован: второй способ записи не нужен для этого атомарного среза.409 по-прежнему сохраняет правки в форме до явного reload.

## Evidence и время

Чистая `assessScenarioDraft` переиспользует `resolvePatchAt`/`resolveHeroAt` из S0-06/S1-07. Не создаёт новую политику определения патчей по labels/current hero list. Дата карты — явно заданное `scheduledAt` как гипотеза. При её отсутствии `MAP_TIME_UNKNOWN`, без подстановки cutoff. Лига — явный optional manual context; при известной series проверяется отсутствие противоречия её известной лиге, но пропущенная лига не угадывается.

Knowledge horizon — min(user cutoff, server checkedAt): будущий cutoff не даёт доступа к будущим знаниям. Рассматриваются только accepted/conflict proofs с known/event не позже horizon, release/coverage interval и hero validity intervals с exclusive validTo. Late fetched proof может подтвердить ранний knownAt только если сам trusted evidence writer его проверил; fetchedAt не заменяет knownAt. Существующий консервативный resolver требует известные patch и league для hero decision, даже если отдельный rule глобальный; неполный контекст не превращается в allowance. Противоречие источников даёт nullable value/reason CONFLICT, не last-write-wins.

Assessment содержит assigned count/fullDraft, status available/unknown/blocked для указанных героев, nullable решения по каждому пику/бану, patch/league/mapTime, policy/registry revision, checkedAt/knowledgeAt и использованные patch/hero proof IDs с source/evidenceRef/eventAt/knownAt/fetchedAt/reviewState. available означает только проверку указанных вариантов в гипотетическом контексте, не официальное участие/hero timeline/model eligibility. При10 героях всё равно `predictionStatus='unavailable'`, probability=null, `draftOrderValidated=false`. Full sequence/phase rules остаются S2-05, статистика пары/матчапов — S2-03, player-hero/report integration — S2-04.

## Persistence и совместимость

Additive016 добавляет nullable scenarios.league_id, scenario_bans и nullable scenario_input_snapshots.draft_assessment. Assigned heroes пишутся в existing scenario_lineup.hero_id; unordered bans не подменяют timeline в scenario_draft_actions. Существующий015 immutable trigger защищает также assessment от UPDATE/DELETE. Исторические SQL001–015 не меняются.

Транзакция сохраняет full input, lineup/baseline/hero/ban projections, SHA-256 и frozen assessment вместе. После optimistic row lock проверяются references. `game_context_registry_state FOR SHARE` удерживается от чтения revision/proofs до commit: все trusted writers увеличивают эту же revision в собственной транзакции. Нельзя получить mix старой revision и новых proofs. Assignments сортируются по slot/role, bans по slot/hero для input hash; это canonical representation, не последовательность драфта.

Старые JSON snapshots без draft/league не дополняются defaults и не переписываются; ответы и hash input сохраняют прежнюю форму. У новых optional полей нет синтезирующих defaults. Migration не backfill-ит исторические proofs/assessment. Старый клиент без draft при существующих назначениях/банах получает409 вместо их потери. Явный `draft:{assignments:[],bans:[]}` очищает драфт новой редакцией. Legacy ordered scenario_draft_actions по-прежнему блокируют этот PUT до отдельной S2-05 compatibility policy.

Чтение истории возвращает frozen assessment, не пересчитывает её на новом registry. UI явно показывает «Проверка на момент сохранения», дату/registry revision отдельно от нового preview; каждый save повторяет current check. Durable derived cache не создаётся. Owner assertion knownAt=recordedAt остаётся отдельным от proof knowledgeAt; исторически введённые сегодня игроки не получают pre-known lineup evidence. Ничего не записывается в match_players/context facts/training/prediction tables.

## Проверки

Contracts:0/partial/10, duplicate slot/hero/cross-side/ban, invalid IDs/order injection и старый snapshot без новых defaults. Pure:source allowance/denial, clocks/late knowledge/unverified/conflict, patch coverage/unknown league/map time, validity boundary, future horizon и null probabilities. PostgreSQL/API: auth/CSRF, no-write preview, atomic projections, unknown refs,422 rollback, frozen history после новых proofs, legacy client conflict/explicit clear, player-role hero swap/revision. Chromium: реальная БД, поиск/выбор, partial/full, ban/remove, повтор, source deny, unknown disclosure, reload/history, desktop/360px. Всё synthetic только в disposable test DB; реальное покрытие источников не заявляется.

Следующая предлагаемая задача — S2-03, с отдельным описательным отчётом pro-only ally unordered pairs / directed enemy matchups, raw N и strict cutoff. До prediction остаются S1-07 и остальные temporal/model gates.
