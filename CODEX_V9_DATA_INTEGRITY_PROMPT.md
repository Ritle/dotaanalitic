# Codex — применить v9 Data Integrity к разработке

Перед началом работы прочитай `AGENTS.md`, `docs/DRAFT_DATA_INTEGRITY.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PROJECT_STATE.md` и `docs/PREDICTION_DATA_RESEARCH_STATUS.md`.

**Цель:** корректно внедрить S0-10, QA-04 в Data Collector без искажения исходных матчей OpenDota. Не пересоздавай проект и не меняй миграции 001–005.

1. Пройди S0-00 на настоящем PostgreSQL16. Примени 001–006 и проверь constraints/triggers, повторный прогон миграций, `node --test tests/node/*.test.mjs`. Восстанови lockfile настоящим pnpm, не вручную.
2. Проверь `game_mode`, `lobby_type` и структуру raw picks у обнаруженных карт (не делай вывод по Hero ID 31 до просмотра actual payloads). Все raw данные сохраняй без «исправления»; secrets не логируй.
3. Имплементируй adapter → raw snapshot/observation → canonical 10 played heroes → versioned independent quality assessment → optional validated timeline. Не удаляй карту целиком из других аналитик при одной аномалии.
4. Структурные флаги аудитора v9 ≠ patch-specific исторически корректная последовательность. `draft_order_valid=null` до отдельной проверки правил.
5. Для моделей учитывай stage/cutoff/evidence, не используй финальные герои или составы как якобы known-as-of без доказательства, а unknown team/series не угадывай.
6. По завершении укажи реально выполненные тесты и blockers; обнови `docs/PROGRESS.md` и `docs/PROJECT_STATE.md`. Задачи P0 закрывать только после прохода проверки на базе и provenance.

Синтетические фикстуры — исключительно для тестирования. Ни одна из них не является реальной профессиональной картой для обучения.
