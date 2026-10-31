# S1-02 — качественные описательные выборки pro-карт

## Реализованный срез

`GET /api/v1/teams/:id/matches` и `/players/:id/matches`, ProMapRepository + чистый selectProMaps и таблица/фильтры на entity pages. Только локальные данные, owner cookie и no-store. Новых библиотек/миграций нет; SQL 001–013 и importer не менялись. Следующий SQL 014+.

Query: optional fromAt/cutoffAt (UTC ISO с миллисекундами), patchId/opponentId/leagueId/playerId (decimal bigint string), side=radiant|dire, rolePos=1..5, limit=10|20|50|100 (default 20). Неизвестные параметры отклоняются. Default cutoff — время запроса; будущий cutoff, from>=cutoff и self-opponent команды — 400. В player route playerId query запрещён: target задаётся URL. В team route rolePos требует явный playerId; роль относится к этому игроку на стороне организации, не к номеру элемента массива.

## Время и область истинности

Это **retrospective_descriptive**, не historical-asof feature reader. cutoff ограничивает события: fromAt<=started_at<cutoffAt, положительная duration, известный исход, end<=cutoffAt. Completion проверяется SQL до преобразования микросекунд в JS Date. is_pro IS TRUE обязателен; unknown/false/conflict/unfinished считаются отдельно. Новые данные или исправления, полученные позднее cutoff, не объявляются исторически известными. snapshotAt/computedAt — текущее время чтения; sourceFetchedAt, syncedAt и startedAt сохраняют разные смыслы. Prediction eligibility=not_assessed, model=null; вероятность не вычисляется.

Reports используют текущую согласованную repeatable-read DB snapshot. Каждый map включает dataRevision, source/sync/fetch и identity/role/patch/series proof IDs; report — identityRevision, registryRevision, policyVersion=pro-map-display-v1, effective filters. Это read-only отчёт, не frozen prediction/dataset snapshot. Будущие features обязаны использовать отдельные strict availability gates S0-04/09 и S3.

## Отбор и независимые качества

- Команда: только историческая сторона matches.radiant/dire_team_id, без current-team flags. Это история организации, не сила текущей пятёрки. Неизвестный соперник/состав/серия не уничтожает известный исход этой стороны; они остаются missingness в отчёте.
- Игрок/фильтр playerId: source_account_id разрешается через существующий verified identity resolver по текущим допустимым proof, без nickname и без доверия к cached match_players.player_id. Двойное появление canonical игрока в одной карте или конфликт связи исключают его из персональной выборки. Pro-history следует личности через организации. Legacy verified account links допускаются только как current descriptive evidence; это не historical knownAt.
- Полный roster: ровно 10 native slots, 10 различных verified canonical IDs. Неполнота сохраняется независимо от outcome, не подставляется команда текущих участников.
- Роли: accepted dated/ref-linked context.roles класса verified_asof или retrospective_fact, confirmed basis и confidence null/1, совпадение slot/verified canonical ID. Estimated, conflicting, duplicate confirmed position и missing role остаются null. Post-match факт роли используется только в явно ретроспективном отчёте; scenario/manual assertions не становятся исторической ролью.
- Патч: reviewed release registry на дату старта с current snapshot knowledge/fetch cutoff, проверкой release/coverage/conflicts. matches.patch_id и provider code не служат fallback. Поздно проверенный release может использоваться для текущего описания истории, не для исторического прогноза. Raw filter не применяет decay/smoothing/model weights.
- Серия: canonical seriesId сохраняется как ссылка. verified требует accepted context.series_id proof с ref, согласованный с FK; conflicting evidence даёт conflict. Один FK/default best_of не даёт verified series. Ни series grouping, ни BO-победы не заменяют map observations.

Фильтры применяются **до** последних N карт. Порядок startedAt DESC, numeric match ID DESC; одна canonical карта = одна строка. summary (N/wins/losses/raw WR/mean duration) и patchDistribution относятся только к выбранным последним N; при N=0 rates/duration/dataUpdatedAt=null. Это не оценка вероятности и не доказательство надёжности маленькой выборки.

Coverage candidates/exclusion counters описывают окно найденных target-кандидатов до фильтров. unknownPro/nonPro/conflict/unfinished — последовательные взаимоисключающие этапы. identityUnresolved означает, что запрошенный игрок не имеет единственного verified появления в карте-кандидате; это включает отсутствие доказанной связи и отсутствие нужного игрока в карте команды. filterMismatch — последующие фильтры, eligibleBeforeLimit — после фильтров до N. knownPatch/completeCanonicalRosters/knownSeries/knownOpponent/confirmedTargetRole/lateFetchedMaps относятся к выбранным N; роль без target не оценивается. `unattributedOrganizationMapsInWindow` — **общий** count pro-карт с отсутствующим ID хотя бы одной организации в временном окне базы, без остальных target-фильтров; его нельзя прибавлять к N команды.

Safety bound: более 5000 target-кандидатов в окне возвращает status=unavailable, reason=WINDOW_TOO_LARGE, просьбу уточнить fromAt; никакой правдоподобный процент по тихо обрезанным данным не выдаётся. HTTP read не вызывает Dota provider и не создаёт jobs/models.

## Проверки и следующий этап

11 новых pure tests и `pnpm test:pro-maps` (7 реальных PG/API tests) проверяют unknown/non-pro, swap сторон, verified cross-org identity, конфликты/роли, patch registry, series evidence, bigint tie ordering, пустую выборку, start/end cutoff, future microsecond и oversized window. Chromium E2E добавляет raw N/WR, side filter, empty/invalid states, desktop/360px screenshots. Фактические результаты/ограничения — [PROGRESS](PROGRESS.md).

Далее **S1-03 [P0] Состав и замены**: exact-five, cross-organization unordered pairs, роли/churn/freshness и baseline vs выбранный состав без фиксированного штрафа. Рекомендуется GPT-6 Astra · High по проектной матрице; поддерживаемый effort ранее проверен в [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6-astra).
