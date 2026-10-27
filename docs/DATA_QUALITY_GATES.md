# Data quality gates before models (P0)

Collector должен возвращать JSON summary per ingestion batch: `requested`, `received`, `confirmed_pro`, `complete_ten_players`, `verified_team_ids`, `known_patch`, `full_draft`, `known_pre_match_lineups`, `conflicting_fields`, `duplicate_match_ids`, `failed_by_reason`, `upstream_age`.

## Правила качества

- Не утверждать, что все карты полные, если отсутствуют игроки, герой, сторона, duration или pro-provenance.
- `known_at` и `fetched_at` хранятся отдельно: поздний импорт не делает сведения известными исторически.
- Multiple sources: explicit field provenance and disagreements, no silent overwrite.
- Numeric confidence != data completeness. Для каждого отчёта показывать объём выборки и причину missingness.
- Не устанавливать произвольный фиксированный threshold для статистического метода до временной проверки. Фильтры и принятие прогноза версионировать.
- Audit every intended release dataset: provenance, full match IDs, cutoff, patch registry revision, canonical player ID verification.

**Status:** gate definition. Collector and real coverage reports — S0-01/S0-02/S1.

## v9 — дополнительные качественные измерения

- На уровне `match_id` считать независимо: `final_heroes_valid`, `draft_picks_exact`, `draft_heroes_match`, `draft_teams_match`, `draft_order_integrity`, `draft_order_valid` и `draft_structurally_consistent`. Последний означает только согласованную **структуру**, не достоверный исторический Captains Mode order.
- `draft_actions` (непустой массив) — **coverage**, не качество; `role_hint_10` не означает верифицированные профессиональные позиции 1–5.
- Для `draft_order_valid` до реализации исторических правил возвращать `null`/`not_assessed`, а не считать все карты невалидными.
- Отдельные статусы пригодности для исхода, игрока, героев, организации, серии, временного контроля, драфта. Нет глобального `is_valid` и нет статического `training_eligible`.
- Сохранять JSONB raw `picks_bans` со снапшотом и SHA, аномалии по кодам, версию validator и источник; не исправлять дополнительные picks отбрасыванием событий.
- В сводках сегментировать по патчам, датам, лигам, играм с/без team IDs; оспоренные команды/серии НЕ исключать из всех других метрик.
- Подробные acceptance tests перечислены в [DRAFT_DATA_INTEGRITY.md](DRAFT_DATA_INTEGRITY.md).
