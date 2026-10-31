# Prediction data research status — актуально 2026-10-31

**Текущий результат:** S0-08 выполнен 2026-10-31: 20 recent + по 5 карт TI leagues 2021/2022/2023/2024, всего 40 unique maps; 50 HTTP attempts, все 200. [Отчёт](S0_08_SOURCE_AUDIT.md), [manifest/evidence](evidence/s0-08-manifest.json). Исторический known-as-of не доказан; S0-09 реализовала его явные cohort gates, но не создала отсутствующее source evidence. Ниже сохранена история подготовки и прежних наблюдений; старый BLOCKED относится к контейнеру 2026-10-27.

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

## 2026-10-30 — S0-01, непосредственно выполненный live audit

- Существующий audit CLI получил 20/20 detailed maps, failed=0; generated at `2026-10-30T17:07:48.208Z`. [Public evidence JSON](evidence/s0-01-live-coverage.json) сохранён с публичными map IDs и без raw payload/profile data.
- ID consistency/start/outcome/league/provider patch/native slots/наличие десяти account IDs/финальные уникальные heroes — 20/20. Team IDs и ненулевой series ID — 15/20. Ровно десять пиков и structural consistency — 19/20; непустые raw events и order shape — 20/20. `draft_order_valid` не оценён на всех 20.
- `9066936100`: 12 picks, дополнительные hero IDs 2,60, обе организации/серия неизвестны; финальные heroes пригодны для отдельной проверки, карта не объявлялась тренировочно допустимой.
- Новый Zod client отдельно проверил три явные карты и team/team players/player за 7 attempts без retries; пять test projections обезличены и помечены synthetic. У `9063023867` текущий массив draft отсутствует (`null`), в отличие от прежнего пользовательского наблюдения одного события; причина изменения источника не утверждается.
- Предматчевый known-at roster, исторические patch rules и pro league/tier classification из этих ответов не доказаны. Никакого backtest, training или числового прогноза не выполнялось; S0-08/09 остаются открыты.
- API limits нельзя фиксировать только по старым 50k/month: новый spike получил remaining-minute/day, а текущие upstream defaults содержат дневной лимит. Источники/точные условия и воспроизводимые команды — [S0-01 report](S0_01_PROVIDER_SPIKE.md).

## 2026-10-31 — S0-08, recent + историческая стратификация

Recent 20/20: source accounts, final heroes, provider patch и completed outcome — 20/20; teams/series — 15/20; picks exact/structural consistency — 19/20. Historical 20/20 (5 на лигу, time ranks, provider patch IDs 48/49/51/53/56): эти поля — 20/20. Каноническая идентичность, верифицированный patch release и historical roster/draft known_at не оценены; strict draft_order_valid везде null. Отчёты schema_version=3 сохраняют selection, все per-map flags/source hashes, HTTP counters и ограничения. Game mode 2/22 не преобразуется в guessed draft rules. Ранее owner-reported 50 и S0-01 20 не прибавляются к новой выборке. [Полные доли, аномалии, команды и scope](S0_08_SOURCE_AUDIT.md).

## 2026-10-31 — S0-09 readiness policy

Реализованы strict/owner/conditional context assessment и отдельный policyKey выборки. Working-DB smoke на единственной импортированной карте: оба strict и conditional профиля incomplete, selected facts=0; typed roster/role/side/patch evidence отсутствует. Это n=1 локальный smoke, не измерение readiness всех 40 audit maps. Полные canonical rows не получают invented known_at; дальнейшая conditional projection — явная работа DatasetBuilder. [Контракт](S0_09_DATA_READINESS.md).
