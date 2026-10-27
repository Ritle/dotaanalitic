# Шаблоны последующих задач для Codex

## Следующий тикет

```text
Прочитай AGENTS.md и документы, связанные с задачей <TASK-ID>.
Реализуй только <TASK-ID> из docs/IMPLEMENTATION_PLAN.md.
Сначала перечисли изменяемые модули и тестовые случаи.
Следуй строгим правилам pro-only, as-of cutoff, нулевых выборок и качества прогнозов.
Выполни доступные проверки и обнови docs/PROGRESS.md.
Не отмечай завершённым без выполненных acceptance tests.
Представь diff summary, тесты, риски и следующий тикет.
```

## S0-01: API spike

```text
Реализуй S0-01. Нужна проверка реального OpenDota на 3–5 матчах,
один с отсутствующим draft. Сохраняй только минимально необходимые обезличенные
fixtures, без ключей. Проверь player_slot, picks_bans.team, nullable account_id,
start_time, team IDs, pro marker, patch. Зафиксируй лимиты, shape и пробелы
данных в docs/DATA_SOURCES.md; используй Zod схему. Не строй импорт всего pro
архива и не рисуй фальшивые рейтинги.
```

## S3-02: as-of feature builder

```text
Реализуй S3-02 на базе согласованного набора pro-карт.
Требование: feature map в момент T не меняется, если добавить карты начиная с T.
Любые game outcome, duration, kills, post-start economy целевой карты исключены.
Сделай property и leakage tests, dataset fingerprint, baseline Elo.
Не показывай вероятности в UI до quality gate.
```
