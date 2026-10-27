# Паттерны разработки и правила границ модулей

## 1. Общий принцип: modular monolith, vertical slice, Ports & Adapters

Один Fastify API и один worker, разделение на use cases (application), domain/pure functions и adapters (infrastructure). **Не** вводить microservices, CQRS/Event Sourcing frameworks или «абстрактный репозиторий всего». Порты создаются только при появлении второго адаптера/тестовой необходимости.

```text
HTTP route (parse Zod, auth) -> AnalysisUseCase (coordination)
                                  -> MatchRepository (Kysely/SQL)
                                  -> Analytics pure functions
                                  -> persisted analysis_run
                               <- DTO (serialize IDs as string)
```

Минимальный рабочий паттерн (пример контракта, не готовый код):

```ts
export type Cutoff = { asOf: Date; stage: 'pre_map' | 'post_draft' };
export interface ProMatchReader {
  findBefore(cutoff: Cutoff, teams: readonly [string, string]): Promise<ReadonlyArray<ProMap>>;
}
export interface Clock { now(): Date }
export class BuildAnalysis {
  constructor(private maps: ProMatchReader, private clock: Clock) {}
  async execute(req: AnalyzeRequest): Promise<AnalysisResult> {
    const asOf = req.asOf ?? this.clock.now();
    const matches = await this.maps.findBefore({ asOf, stage: req.stage }, req.teams);
    return calculateAnalysis(matches, req); // pure function
  }
}
```

`new Date()` в route допустим, но не внутри исторических feature builders. В тестах `Clock` фиксируется; side-effect функции нельзя вызывать из domain layer.

## 2. Контракт identity/lineup/role и временем известности

- `team_id` = организация; `player_id` = canonical физический игрок, подтверждённые accounts; `map_player` = фактическое участие; `scenario_lineup` = предположение пользователя.
- `expected_lineup` vs `actual_lineup` — разные сущности. Никакого прямого вычитания силы игрока и «штрафа 40% за замену».
- `players.is_current_team_member` и историческая пятёрка из финального матча **не являются доказательством**, что будущий состав был известен **до драфта**. Для честного pre-map backtest нужны подтверждённые `announcement.known_at` или отдельный эксперимент «conditional on lineup observed» без заявления о настоящей предматчевой точности.
- Роль — отдельный `role_assignment` с источником/quality и временной привязкой. Позиция в массиве API не равна роли 1–5.

## 3. Scenario aggregate + immutable Prediction snapshot

Editable aggregate:

```text
Scenario(id, ownerId, teamAId, teamBId, seriesContext?, revision, lineupSlots, draftActions)
```

- Транзакционно `UPDATE scenarios SET revision=revision+1 WHERE id=? AND revision=? RETURNING revision`; если `0 rows`, `409 conflict` + актуальная ревизия.
- Для pre/post prediction в одной транзакции фиксируем `scenario_revision`, `cutoff_at`, `data_revision`, сырые inputs/features/unknown mask, active `model_id`, artifact SHA, projection version и status.
- Terminal prediction `immutable`: `no UPDATE/DELETE` на уровне DB; новые варианты — новая запись; actual outcome в отдельной таблице. Вызов post-draft при неполной пятёрке или повторном герое даёт validation error, а не прогноз.
- UI: Pinia для локального редактируемого Draft Lab; TanStack Query для server persisted states. После mutate `revision` инвалидируется соответствующий query key.

## 4. Result types instead of exceptions for expected states

```ts
type PredictionResponse =
  | { status: 'ready'; teamAWinProbability: number; modelVersion: string;
      computedAt: string; coverage: Coverage; warnings: string[] }
  | { status: 'unavailable'; teamAWinProbability: null;
      reasons: Array<'missing_lineup'|'no_valid_model'|'cold_patch'|'insufficient_pro_maps'|'unknown_side'>;
      coverage: Coverage };
```

`ready` допустим **только** если quality gate разрешает этот сценарий. `unavailable` — нормальный доменный ответ, не 500. Неподтверждённый source → `source_unavailable` + stale cache metadata. Не возвращать фальшивые 50/50.

## 5. Transaction boundaries, idempotency and concurrency

1. HTTP validation/auth; create durable job **с idempotency/business key** (source+external match id+revision) и быстрый `202`.
2. Worker fetch -> raw hash -> validation -> normalization -> DB transaction `UPSERT` map, ten player slots, draft, source observations, provenance + canonical `data_revision` only upon effective change.
3. Publish completion/recompute job **in same database transaction**, где поддерживается библиотекой; иначе outbox table + dispatcher. `at-least-once` means duplicate execution possible, NEVER assume exactly once.
4. Уникальные SQL ограничения: `(provider, external_match_id)`, `(map_id, player_slot)`, `(dataset_version_id, stage, match_id)`; `ON CONFLICT` upsert and recheck hash. Не делать fetch и сетевые вызовы внутри длительной SQL transaction.
5. `pg-boss` workers: start once/process, graceful stop, capped local concurrency, exponential backoff + dead-letter/failed status; configure separate queue import vs training. Для batch ML: one active training per stage/dataset fingerprint через DB uniqueness/advisory lock. Не создавать scheduler на каждый web-request.
6. Save errors and source evidence; unknown player/patch must not silently convert to default ID.

## 6. Observer / cache invalidation: domain revision, not random TTL

Обновление patch registry, identity aliases, verified outcomes или состава может изменить агрегаты на большом историческом окне. Поэтому:

- `data_revision`: increment only after canonical facts effectively change;
- cache key = `report_kind + teams + lineup hash + cutoff + filters + patch_policy_version + feature_version + data_revision`;
- old immutable reports stay frozen, new runs use new revision;
- фоновые агрегаты могут быть пересчитаны частично по затронутым героям/командам **либо** полно при изменении scoring policy; downstream может временно вернуть `stale`.

## 7. Ошибки, retries, availability

Классификация:

| Событие | Переобработка | Поведение |
|---|---|---|
| 429 upstream | Да с Retry-After, global per-provider limiter | Sync pending, не 500 пользователю |
| 502/503, timeout | Да, bounded exponential + jitter | После max retries failed + retry command |
| 400/404 missing player | Нет/ограниченно | `not_found`, provenance, не «нет матчей» |
| Validation schema mismatch | Нет automatic retry | quarantine raw response, raise adapter issue |
| DB unique conflict during import | Перепроверка, deterministic UPSERT | Нет дубля карты |
| Prediction insufficient data | Не retry по таймеру без изменений данных | `unavailable` + причины |
| Worker crash | Повтор at least once | Только идемпотентные side effects |

## 8. Tests: pattern -> mandatory invariant

- Pure functions: arbitrary order / repeated map / swapped Radiant/Dire / all-null / zero sample / weight=0 cases.
- Provider adapters: fixtures v1/v2 with absent player accounts/picks/slots and partial malformed response.
- Database: concurrency import, unique ids, nullable patch, session expiry, immutable prediction trigger, atomic promotion rollback.
- User flow: optimistic conflict, offline stale cache, 10 unique hero picks, confirmation of five players.
- Model: as-of cutoff check, no outcomes of current map, whole series in one fold, prospective vs retrospective separated, Python-vs-TS inference parity.

## 9. Code-review anti-patterns (Codex MUST reject)

- `const winRate = wins / (matches.length || 1)` — creates 0% instead of `null`.
- `getTeamWinrate(teamId, allTime)` as direct input to current five prediction.
- `.map((player, index) => role = index+1)` on provider array.
- `Math.random()` / manual `0.65` as a prediction placeholder.
- Storing provider auth keys or session tokens in a frontend env variable.
- Updating `prediction_runs` after score confirmed.
- Using `Date.now()` to fill missing historical known_at.
- Importing/learning in GET handler.
