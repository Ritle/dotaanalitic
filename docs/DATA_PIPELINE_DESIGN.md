# Данные, ingestion и point-in-time contracts

## 1. Источники и статус доказательства

OpenDota REST — первичный адаптер. STRATZ — потенциально дополнительный, выключен до проверки условий доступа. `ProviderAdapter` получает только заранее утверждённые endpoints (не произвольный URL), выдаёт `RawProviderPayload {provider, endpointVersion, fetchedAt, payloadHash, body}`. Zod validator проверяет предельные размеры/типы, не удаляет важные provider meta поля; raw JSON сохраняется по policy только в течение ограниченного срока.

Нормализатор создаёт **каноническую карту**, не «матч» в значении BO3. `match_id` однозначен; десять слотов включая стороны, герой, player external id либо null, уровни достоверности. Если `is_pro` не подтверждён, карта **не участвует в обучении**.

## 2. Три времени — не одно

- `event_at` / `started_at`: когда событие действительно произошло.
- `known_at`: с какого момента факт мог быть известен аналитической системе/наблюдателю **с подтверждением источника**.
- `fetched_at`: когда мы загрузили факт в PostgreSQL.

`known_at` **никогда не выводить автоматически из fetched_at или даты матча**. Если API даёт только текущее состояние и не сохраняет дату публичной публикации, historische backtest имеет ограничение: отдельный `reconstructed/offline` режим и только факты, чья доступность к cutoff достоверно обоснована. Нельзя утверждать истинный prospective accuracy, если исторические lineups стали известны только из end-of-map участников.

### Leak-proof доступность по stage

| Признак | Pre-map cutoff | Post-draft cutoff |
|---|---|---|
| Team identity / past completed maps | Только подтверждённые до cutoff | Да |
| Текущий точный состав | Только объявлен до cutoff или введён владельцем | Может быть подтверждён при завершении draft, если evidence |
| Radiant/Dire, first pick | Только если были известны до момента запроса | Только если известны |
| 10 picks, draft order | **Запрещено** | 10 heroes допустимы после draft finish |
| End game outcome, GPM, kills, duration текущей карты | **Запрещено** | **Запрещено** |
| Сила оппонента / win rates | До cutoff, от старых pro-карт | До cutoff |
| Patch/hero availability | Verified effect at cutoff | Verified effect at cutoff |

При построении исторического backtest следует фиксировать `forecast_stage`, `cutoff_at`, `availability_policy`, `feature_schema_version`, `source_evidence`, `retrospective_vs_prospective`. **Важно:** постматчевое знание фактической пятёрки можно использовать для отдельного *условного* исследования качества, но нельзя выдавать это за настоящий pre-map прогноз по заранее известному ростеру.

## 3. Import state machine

```text
queued -> downloading -> validating -> normalizing -> persisted -> aggregated
                           |                 |
                           v                 v
                      quarantined          rejected/partial
```

`rawPayloadHash`, `normalizedFactsHash`, `adapterVersion`, `sourceFetchedAt`, `canonicalRevision`, `evidenceUrlOrKey`, `validationWarnings`. Заявленный `match.id` сверить с запрошенным. Матч без десяти достоверных участников может сохраняться как `partial`, но не получать `validated_lineup=true`. Загрузки будут дополнять сведения без подмены исторической видимости.

## 4. Ограничения и индексы

- `matches(external_id unique)`, `match_players(match_id, player_slot unique)` с проверкой диапазонов Radiant 0..4, Dire 128..132.
- `(is_pro, started_at DESC)` частичный/композитный индекс, а также `(player_id, started_at)`, `(team_id, started_at)` по фактическому plan/EXPLAIN.
- `draft_actions(match_id, order)` unique, но order nullable без фальсификации chronology.
- Исторические roster пары вычисляются из `match_players` одной стороны по canonical player_id; допускаются **10** unordered pairs на карту и **25** directed hero A→B межкомандных пар на карту. Никогда не перемножать join так, чтобы матч учитывался несколько раз.
- Для больших sample расчётов сначала profile `EXPLAIN (ANALYZE, BUFFERS)` на synthetic 30k/100k maps; добавлять материализованные агрегаты только по доказанному bottleneck.

## 5. Patch metadata и feature-specific decay

- `patch` определяется датой начала карты относительно verified patch release timestamp; no guessing for uncovered windows.
- Свой набор time/patch decay для `hero_meta`, `hero_pair`, `player_hero`, `team_form`, `roster_pair`; hero major rework отдельный change event. Параметры decay/version сохранять в training config, выбирать на temporal validation.
- Считать `n_raw` и Kish `n_eff=(Σw)^2/Σw²`, а также coverage missingness. Weighted raw WR и smoothed WR не смешивать.
- Переобработка patch registry → новая policy/revision, invalidation только derived datasets; frozen report/forecast не меняется.

## 6. Provider throttling и backfill

Используем один server-side transport с priority queue: интерактивный ограниченный sync (`on-demand`) выше длительного backfill. Ограничение запросов централизовано в worker (один worker процесс для MVP); поддерживать Retry-After (`seconds` и HTTP date), random jitter, max retries, timeout, circuit-breaker-open/cooldown state по provider. Provider лимиты вынесены в config, не hardcoded «60/мин» как вечная истина. Backfill пачками/по cursor/checkpoint, resumable после рестарта, не сканировать полностью каждый день. Endpoint может быть неполным или upstream rate-limited — это отражается в `sync_status`.

## 7. Canonical identity

Не объединять по никнейму и `team_id`. `player_external_accounts` с confidence/evidence + effective period. Известный player ID сменил команду — профиль переносится; старые карты остаются под прежним team ID, но в identity history игрок один. Mis-link correction versioned и инициирует пересчёт соответствующих pair features, не переписывает frozen datasets.

## 8. Данные для мониторинга импорта

Табличные counters: imported/partial/rejected pro maps, invalid provider payloads, last successful fetch, age, source coverage, 429/5xx, queue backlog, reprocessed after patch metadata change. Health API не должен в каждом запросе делать upstream fetch.

## 9. v9 — raw draft isolation and per-use eligibility (P0)

Normative: [DRAFT_DATA_INTEGRITY.md](DRAFT_DATA_INTEGRITY.md). A provider response may contain `picks_bans` with **more or fewer than 10 picks** despite ten final heroes in `players`. Keep original events (and provider/adapter/hash) via `match_draft_source_observations`, independently keep final played heroes in `match_players`, and publish only verified timeline events into `match_draft_actions`.

Implement a versioned validator producing quality dimensions / machine-readable anomaly codes; do not collapse entire map to valid/invalid. A map with unknown historical organization IDs but verified final heroes still contributes to hero pair/counter statistics **when those features are eligible**; it is excluded from organization-specific Elo until identification. `series_id=0` becomes unknown (nullable series), never BO1. Timeline verification requires `game_mode`, `lobby_type` and historically correct patch-specific rules. `lane_role` is a hint rather than evidence of a published pre-match role.

Stage-specific `training_eligible` is a **query/reproducible decision**, not a permanent column in `matches` or `match_quality_assessments`. Always freeze source + quality policy version in the training dataset. Unknown historical lineup known-at still blocks an unconditional prospective pre-map cohort. Import the raw evidence before any lossy normalization; record repeated source corrections as new observations, not destructive overwrite.
