# Prediction data research status — 2026-10-27

## Verified via public documentation and published data

- OpenDota documents `/proMatches`, `/matches/{match_id}`, professional team/player endpoints and a free limit of 60 req/min, 50k/month. Source: https://opendota.apidocumentation.com/
- OpenDota/STRATZ publish accessible match/draft/replay data contracts, but **the percentage of complete recent maps remains unmeasured here**. Source: https://stratz.com/
- Zenodo v3 https://zenodo.org/records/23166182: 90,530 maps and 1,007,768 **live in-game snapshots** (patches 7.32–7.40), version 2026-10-05. Not a ready pre-match dataset. Licenses and exact columns to be audited before reuse.

## BLOCKED empirical audit

The build container could not resolve `api.opendota.com` for a programmatic sample. The public endpoint was reachable through web lookup, but that is not a measured null/coverage audit. For that reason no percentages, patch counts, identity coverage or model performance are claimed.

## Execute in Codex on a networked machine

```bash
node scripts/audit-prediction-sources.mjs --fixture tests/fixtures/opendota-audit-synthetic.json --sample 2
node scripts/audit-prediction-sources.mjs --sample 20 --out reports/opendota-coverage.json
```

The sample defaults to recently discovered pro matches and is not a balanced historical sample. After this, sample multiple historic seasons/patches separately. Keep `reports/` uncommitted unless only aggregate public evidence is saved.

## Обновление: live-проверка владельца от 2026-10-27 (50 недавних карт)

**Ранее статус BLOCKED относился к контейнеру сборки, а не к машине пользователя.** Пользователь выполнил скрипт в Windows PowerShell и передал результаты. Это реальные наблюдения из его запуска, **не воспроизведённые** в нашем контейнере и без сохранённых исходных JSON-ответов.

- `details_received=50`, `details_failed=0`, `outcome/start_time/patch/players_10/identity_10/heroes_10_unique=50/50`.
- `teams_2=38/50`, `series=38/50`, причём 12 совпадающих проблемных карт; `picks_10=44/50`, `draft_actions=49/50`, `role_hint_10=50/50`.
- Диагностика: карта `9062822180` — 12 pick events, лишние hero IDs 31, 107; `9061459911` — 11 pick events, extra ID 31; `9063023867` — ноль pick events при 10 финальных героях и одном raw draft event.
- `game_mode` и `lobby_type` аномальных карт требуют отдельной проверки. Не утверждать, что причина связана с Hero 31, Captains Mode или конкретным багом API.
- Проценты НЕ являются patch-stratified оценкой; нет источника предматчевой известности составов. Не обучать производственную модель на одной этой выборке.

Следующая проверка: 

```bash
node scripts/audit-prediction-sources.mjs --fixture tests/fixtures/opendota-audit-anomalies-synthetic.json --sample 6
node scripts/audit-prediction-sources.mjs --sample 50 --out reports/opendota-coverage-v9.json
```

В v9 `schema_version=2`; новый отчёт содержит флаги качества, аномалии и отдельный `draft_order_valid=null` до проверки правил патча. Для исторической выборки необходимо отдельно реализовать курсорную стратификацию по патчу/лиге/времени.
