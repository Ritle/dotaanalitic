# Инженерные ADR v5 — согласованный набор решений

Каждое решение — **принято для проектирования**, не статус реализации. Изменение требует отдельного ADR и поправки `AGENTS.md`/плана; приоритеты P0/P1/P2 сохраняются.

| ADR | Решение | Альтернатива / причина отказа | Пересмотреть когда |
|---|---|---|---|
| ADR-025 | Modular monolith + one dedicated worker | Microservices добавляют ops overhead без multi-user нагрузки | Реальные изоляционные/масштабные требования |
| ADR-026 | PostgreSQL-backed queue с `pg-boss` | Redis/BullMQ = лишняя эксплуатационная зависимость | Реальные очереди не справляются |
| ADR-027 | SQL-first immutable 001..005 + `pg`/Kysely repositories | Не вводить второй schema migrator (Prisma/Drizzle push) | По отдельному миграционному ADR |
| ADR-028 | Zod 4 boundary и Fastify v5 тип-провайдер после compatibility spike | Не дублировать TS и runtime schema | Новая major версия API |
| ADR-029 | TanStack Vue Query для server state, Pinia для редактируемого UI | Не хранить server cache вручную в Pinia | Если архитектура UI изменится |
| ADR-030 | Offline Python scikit-learn baseline, TS JSON logistic inference | Полноценный Python HTTP сервис лишний; JSON model легко проверять | Candidate CatBoost/Tree model превосходит baseline |
| ADR-031 | Reproducible dataset manifest + parity/sha gate | Pickle без проверок опасен и несовместим с Node | Новый artifact format/version |
| ADR-032 | Side/roster known-at stage-specific | Ретроспективные фактические составы ≠ заранее известный состав | Появится источник timestamped lineups |
| ADR-033 | At-least-once jobs + SQL idempotency | Exactly-once без транзакционной схемы не гарантирован | Никогда не нарушать идемпотентность |
| ADR-034 | Single-owner DB opaque sessions + csrf/rate limit | JWT / public signup лишние и увеличивают риск | Появится multi-user продукт |
| ADR-035 | Cold-patch abstain + temporal quality gate | Произвольные прогностические проценты запрещены | Доказанная метриками политика |
| ADR-036 | Charting через ECharts при появлении экранов | Не тащить графическую библиотеку в bootstrap | Смена UI целей |
| ADR-037 | Provider quota/freshness first, raw payload bounded | Нельзя строить бизнес-логику от live fetch | Новые права/API/коммерческая модель |

См. также прежние ADR-001..024 в `docs/DECISIONS.md`. Утверждение **«принято»** здесь означает архитектурное решение, а не установку пакета или тестирования.

## ADR-039 — First release with conditional player Elo (2026-11-02)

- **Status:** approved by the owner for implementation; runtime changes and model activation are not included in this decision checkpoint.
- **Decision:** [TECHNICAL_SPEC §0](../TECHNICAL_SPEC.md): expected editable 5v5, one pre-match player-mean Elo model; only used features impose data dependencies. No mandatory patch/role/hero/side/cohesion features or post-draft release dependency.
- **Evaluation:** separate reconstructed conditional/strict/prospective cohorts, no clock backdating. Fixed policy uses warmup plus untouched series-aware test; tuning/calibrator fitting gets separate earlier data. Register sample/metric/coverage gate before release testing. Preserve E0/E1 as frozen research.
- **Preserved:** real pro outcomes, verified numeric identity, earlier history only, deduplication/series grouping, model gate/activation and immutable snapshots. Existing nullable schema/descriptive analytics remain.
- **Trade-off:** conditional evaluation does not measure lineup selection errors, and Elo omits meta/role/cohesion effects. Show that limitation, retain mismatched prospective forecasts and assess temporal drift. No claim of unchanged accuracy from simplification.
- **Evolution:** new feature schema/artifact/dependencies and independent validation for logistic, patch/role/cohesion, then post-draft. ADR-030/032/035 remain for their relevant profiles; they do not impose unused dependencies on V1.

## ADR-038 — Separate final heroes, raw picks and validated timeline (v9)

- **Decision P0:** distinct raw draft observation / canonical played heroes / validated timeline; independent versioned quality flags; frozen dataset stage eligibility computed as-of. Persistence in forward migration 006; do not alter 001–005.
- **Evidence:** owner's recent 50-map OpenDota audit, 12 maps without two historical team IDs and series, 6 maps with non-exact pick count; 0/11/12-pick examples. This is a convenience sample, not historical validation.
- **Alternatives rejected:** deleting surplus pick events, assigning old maps to players' current organizations, excluding every imperfect match from all analytics, treating non-empty events as chronology evidence.
- **Trade-off:** more source and assessment records, but transparent provenance, partial usability and reproducible feature policies. See [DRAFT_DATA_INTEGRITY.md](DRAFT_DATA_INTEGRITY.md).
