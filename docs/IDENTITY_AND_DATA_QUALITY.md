# Canonical Identity, Data Provenance & Confidence — P0 contracts

## Канонический игрок и команды

`teams` = организации, не составы. `players` = канонические личности, `player_external_accounts` = источники/account IDs. Сначала связываем по подтверждённым внешним идентификаторам, затем только с проверяемым evidence. Схожий ник, флаг `is_current_team_member` или участие в организации **не разрешают** автоматическое объединение двух личностей. `player_alias_history` — история отображаемых ников, а не primary ID. Спорная связь получает `provisional` и не объединяет статистику до подтверждения.

Исторические lineups выводятся из 5 уникальных подтверждённых игроков одного `match_id`/`side`; role/line assignment на дату игры из соответствующих observed facts с confidence. История игрока и его пары с другими учитывается при смене организаций; тег команды не переносит Elo пятёрки автоматически. Пара работает со множеством всех прошлых организаций и считается по уникальным map IDs.

## Источники

`match_source_snapshots` сохраняет fingerprint payload/адаптера, извлечённое coverage, timestamp и provider match id. `match_field_observations` фиксирует значение поля, источник, известность (`known_at`), историю конфликтов. При противоречии OpenDota vs вторым источником нельзя «последний ответ победил»: оставить конфликт, применить документированный source precedence и ручной review при необходимости.

`detail_status`/`draft_status` не означают, что *все* численные поля известны. Missing `kills/GPM/role` — не ноль. У ответа API есть schema version, batch ID, error classification, fetched timestamp; обновления идут идемпотентно.

## Правила coverage и Data Confidence

Data coverage по модулю: `maps_eligible`, `maps_with_outcome`, `lineup_players_resolved`, `roles_verified`, `heroes_assigned`, `patch_known`, `context_known`, `source_conflicts`, `n_raw`, `n_eff`, `freshness`. `n_eff` (Kish) применим к взвешенной выборке, `n_raw` — количество уникальных карт. Не превращать `quality` в win-probability, не писать «70% достоверности» без валидированной интерпретации.

**Shrinkage:** оценку малых выборок притягивать к релевантному prior (например, pro hero+role+patch) с параметрами, подбираемыми только на training/validation, не на final holdout. Если `n_raw=0`, прямой observed winRate `null`, сглаженная модельная оценка допускается только с явным названием/параметрами/coverage и не должна маскироваться под наблюдаемую статистику.

## Сигналы для модели

- Strength of schedule: рейтинг оппонента **на момент карты**, не текущий рейтинг 2026 для 2023 года. Elo/Glicko — собственный хронологический вычислитель; сравнивать с baseline winRate.
- Role-aware player signal: `player × role` до T, source confidence и недавняя смена позиций.
- Lineup cohesion: exact five, pairwise cross-organization, recent churn/role stability; stand-in не получает произвольный коэффициент.
- Patch-aware hero data: отделить от долгосрочной формы, хранить patch/hero impact, `n_eff` и cold-start.

## Тесты

- Никнеймы совпадают, ID разные: не сливать игроков.
- Аккаунт имеет неподтверждённую связь с игроком: историю не приписывать до `verified`.
- Два API прислали разные `hero_id`: конфликт сохраняется, статистика не заполняется некорректным фактом.
- Нулевые карты => `null` observed rate; малая выборка даёт shrinkage, но raw count сохраняется.
- Импорт второй раз с идентичным fingerprint — не создаёт повторных карт, прогнозов, pair-counts.
- Неизвестное `known_at` не считается исторически достоверным объявлением состава.
