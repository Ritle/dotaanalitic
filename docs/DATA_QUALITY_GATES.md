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

## Измерение S0-08 (2026-10-31)

[Ограниченный source audit](S0_08_SOURCE_AUDIT.md): 40 unique maps, six observed provider patch IDs, 50 HTTP 200 attempts. Покрытие полей не является training/prediction gate. Unknown canonical identity/verified patch/historic lineup/draft timing остаётся unassessed/null. На recent five maps отсутствуют teams/series, одна имеет 12 raw picks при десяти final heroes. Пороги моделей по этим наблюдениям не устанавливаются; readiness cohorts — S0-09, corpus — S1-08.

## Context readiness S0-09

context-availability-v1 разделяет strict_verified_asof, owner_asserted_asof и conditional_lineup_reconstructed. Unavailable/unknown факты имеют null value; ready означает только достаточность явно запрошенного контекста, не разрешение обучать/показывать вероятность. Подтверждённые Pos1–5 отдельно от оценок; source account coverage не подменяет canonical lineup proof. [Правила и тесты](S0_09_DATA_READINESS.md).

## Описательные выборки S1-02

pro-map-display-v1 показывает только завершённые is_pro=true карты, независимо учитывая missing canonical roster/patch/opponent/series. Cutoff ограничивает map events; late backfill остаётся текущим retrospective_descriptive чтением, predictionEligibility=not_assessed. Raw filters не используют model weights. Coverage denominators и отказ при >5000 кандидатах закреплены в [S1_02_PRO_MAPS](S1_02_PRO_MAPS.md); частота побед не становится win probability.

## Реализованные индивидуальные метрики S1-04

Player×hero×confirmed role использует pro/completion/verified source identity gates и отдельный фактический N каждой численной метрики. Неполная K/D/A тройка не входит в KDA, но доступный GPM/XPM может входить в своё среднее; missing не равно0. Unknown role сохраняется отдельно. Default current patch без reviewed release coverage даёт unavailable, не all-patch fallback. [Контракт и знаменатели](S1_04_PLAYER_HERO.md).

## Рейтинг и историческая доступность S1-05

Elo update требует verified-asof canonical identity на старт и reviewed availability для pro/outcome/actual participation; end не подставляется в known_at. Raw organization WR имеет отдельный denominator. Задержанный исход не меняет prior state до availability; source clocks сохраняют микросекунды. Поздний конфликт останавливает последующие рейтинги, сохраняя ранние. Это reconstructed participation audit, не prospective model gate или published probability. [Алгоритм и ограничения](S1_05_CHRONOLOGICAL_ELO.md).

## Sample/prior S1-06

Raw N и nullable rate не заменяются N+prior mass. Prior берётся из отдельного более раннего same hero-role-patch reference, исключает серии target observations и требует двух типов исхода. Unknown context/series, overflow и degenerate reference дают null estimate с reason. Band10/30 — продуктовая категория, не confidence. Kish N_eff доступен только для явно заданных весов; unweighted HTTP reports оставляют его null. См. [контракт и ограничения](S1_06_SAMPLE_EVIDENCE.md).
