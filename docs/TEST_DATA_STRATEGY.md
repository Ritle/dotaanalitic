# Test data & golden datasets

## Классификация

- `tests/fixtures/opendota/` — полностью **синтетические** OpenDota-подобные ответы. `_fixture_notice` обязателен. Использовать только для контрактов формы, неизвестных значений, incomplete/complete map, повтора импорта. Не смешивать с реальной базой обучающих исходов.
- `tests/fixtures/roster-scenarios.json` — перестановки, пары и совместные карты вне зависимости от команды, строго до cutoff.
- `tests/fixtures/ml/synthetic_history.jsonl` — искусственная выборка c хронологическими train/calibration/validation/test, без пересечения серий и будущих features.
- `tests/golden/` — ожидания для метрик, пересечений составов, замороженной v6 миграционной базы, Python↔TS logistic parity.

## Правила добавления реальных fixtures (после Provider Spike)

1. Сначала проверить условия источника и допустимость хранения/публикации; при сомнениях использовать синтетику.
2. Удалить идентификаторы аккаунтов и личные сведения; оставить только минимальные поля, нужные тесту.
3. Для каждой записи документировать `source`, `retrieved_at`, `known_at`, `map_started_at`, `data_completeness`, договорённость об использовании. Нельзя выдавать анонимизированную запись за удостоверенный исход.
4. Нельзя считать `current roster` исторической истиной для карты; состав из реплея известен **после** карты, если нет предматчевого evidence.
5. Вся модельная выгрузка формируется только из verified pro maps; frozen manifest + sha + cutoff. Пользовательские picks/predictions ≠ labels.

## Регрессии, обязательные в реализации S0..S3

- Матч без 10 слотов → incomplete, не full roster.
- Смена всей пятёрки → нет «наследованной» сыгранности организации.
- Трансфер → сохраняется межорганизационная история игрока и pairwise coplay.
- Замена 1 человека → 4/5 игроков, 6/10 прежних пар, но **не -40% win probability**.
- Post-patch dataset shrinkage → uncertainty/cold start, не подмена актуального винрейта старым.
- BO3 map2 → нельзя использовать map3 при расчёте map2.
- Repeated imports → один Dota map ID в фактах и один пример per dataset-stage.
- Unverified outcome / retrospective lineup / future features → reject in training.
- Frozen DB dataset и terminal prediction → immutable.
- ML кандидат с ухудшением качества → current champion unchanged, no autopromotion.

## v9 — синтетические аномалии и patch-mode gate

Fixture `tests/fixtures/opendota-audit-anomalies-synthetic.json` содержит 6 **искусственных** вариантов: чистые десять пиков, +2 pick events, +1 pick event, 0 picks / 1 ban, team+series absent, несоответствие пика стороне. Обязательные тесты в `tests/node/draft-quality.test.mjs`; `draft_order_valid` должен оставаться `null` без rule registry. Это регрессии **по форме аномалий**, а не скопированные реальные OpenDota payloads. См. [DRAFT_DATA_INTEGRITY.md](DRAFT_DATA_INTEGRITY.md).
