# S3-01 — корпус и независимая проверка временных выборок

**Статус: инженерный срез выполнен; empirical acceptance остаётся открытым.** Реального strict-as-of frozen датасета с четырьмя наполненными окнами пока нет. Source discovery, подробные ответы после игры и успешные синтетические проверки не закрывают S3-01, отдельный v8 S1-08 corpus gate или S1-07. Numeric features и модели не реализуются в этом срезе.

## Защита от aliases одной серии

S3-00 группировал карты по canonical `series.id`. Регрессионный PG-тест показал, что два UUID с одинаковым OpenDota series ID могли попасть в train/test отдельно. Теперь `strict-context-preparation-v2` и `explicit-windows-provider-series-v2` сначала находят **все** canonical aliases одного `provider:provider_series_id`, затем их карты, включая карты вне окна. Canonical строки не сливаются и не исправляются.

Несогласованные пары организаций исключают всю provider-группу; неизвестные организации имеют отдельную причину. Стороны пары не влияют на grouping. Учитывается даже противоречащий alias без карт. Candidate/alias/sibling inventories имеют независимые лимиты `maxMaps`; overflow даёт unavailable. Manifest сохраняет `seriesAliases`, native UUID, provider key и состояния конфликтов. Новое доказательство создаёт новый результат; старый frozen export сохраняет исходные bytes/SHA.

## Независимый frozen audit

```powershell
pnpm dataset:audit stored <dataset-uuid>
pnpm dataset:audit file reports/export.json <expected-sha256>
```

`DatasetAuditRepository` читает только frozen content и fingerprint одним SQL statement. Чистый `auditFrozenDatasetContent` проверяет exact canonical bytes, Zod-контракт, manifest/input/quality hashes, одну карту на dataset/stage, соответствие cutoff и snapshot, разделение input/label, source receipt linkage, recorded proof clocks, полноту inventory/exclusions, declared boundaries, четыре непустых окна и отсутствие пересечений provider-серий. Ненулевые микросекунды не округляются в миллисекунды. Неизвестные/повреждённые форматы не переинтерпретируются.

- `valid`: проверки **записанной структуры** прошли. Это не независимый backtest, не доказательство подлинности всех proofs и не право обучать/публиковать модель.
- `unavailable`: frozen dataset не найден, формат не поддержан, отсутствует окно или у legacy v1 не записана полная alias inventory. Доступная структурная диагностика сохраняется отдельно.
- `invalid`: нарушен hash, контракт, chronology, membership или manifest consistency.

Во всех случаях `trainingReady:false`, `deployable:false`, remote series completeness unknown. Достаточный sample size/качество, history/features и эмпирические model gates ещё не оценены. Legacy v1 не переписывается и может экспортироваться прежним CLI; новый audit честно сообщает ограничение. Exit0/3/1 соответствуют valid/unavailable/invalid; usage2. DB/SQL secrets не печатаются.

## Corpus diagnostic без импорта и обучения

```powershell
pnpm corpus:audit docs/evidence/s3-01-corpus-config.json reports/new-corpus-analysis.json
```

Config содержит request с явными UTC окнами и список `captures[{kind,path,sha256}]`; paths разрешаются относительно config. Поддерживаются минимальные live discovery v1 и прежние detailed audit v3. CLI проверяет SHA каждого capture и source/generated clocks против snapshot; неверная схема, synthetic mode или один SHA с разными kind отклоняются. Доступ к БД/сети не требуется. Output создаётся эксклюзивно, существующий файл не заменяется.

Агрегатор сохраняет повторные наблюдения, но считает одну карту по ID. Разные известные значения исхода, команд, series, start, league или provider patch не заменяются «последним ответом»: сохраняется conflict. Все затронутые observed series изолируются. Разбиение по shared temporal policy использует только согласованный discovery context, учитывая всех наблюдённых siblings. Наличие `flags.series=true` в старом detailed report не выдумывает отсутствующий series ID.

Покрытие detailed flags имеет собственный знаменатель уникальных **подробно проверенных** карт. Nullable/неоценённые поля не превращаются в0%. Provider patch не становится verified release patch; source account IDs не становятся canonical identities. `strictHistoricalEligibility:not_assessed`, trainingReady/deployable:false независимо от raw completeness. Статус `diagnostic_complete` означает обработанные captures, не полноту внешнего корпуса или готовность датасета. Лимиты:30 captures,32MiB на capture/64MiB суммарно,100000 наблюдений; никаких silent truncations.

## Измеренный checkpoint

[Новый live audit](S3_01_SOURCE_AUDIT.md): пять non-TI league namespaces,2016–2025, **56 HTTP200**,40 новых detailed maps и1240 уникальных discovery IDs. Названия турниров не доказывают, что endpoint содержит только main event. Полнота endpoint/серий остаётся unknown.

[Config](evidence/s3-01-corpus-config.json) и [результат](evidence/s3-01-corpus-analysis.json) связывают12 captures:

| Показатель | Значение |
|---|---:|
| Source observations | 1330 =1240 discovery+90 detailed |
| Уникальные map IDs | 1287 =1240 discovery+47 прежних detail-only |
| Уникальные подробно проверенные карты | 87 |
| Повторные observations | 43 =40 новых detail joins+3 прежних повторения |
| Conflicting map observations | 0 обнаружено |
| Известные source series groups | 536 |
| Discovery assignment train/calibration/validation/test | 322 /510 /194 /196 |

Последняя строка — **1222 discovery observations**, не1222 обучающих примера. Unknown series65 складываются из18 реально отсутствующих ID в discovery и47 detail-only reports, где сам ID не сохранялся. `DISCOVERY_OUTCOME_UNCONFIRMED=47` означает отсутствие winner scalar в этих reports, а не47 неверных исходов. `TEAM_SIDES_UNKNOWN=51`:4 discovery +47 detail-only. Подробные flags: teams79/87, series77/87, structural consistency86/87; это отобранный source diagnostic, не репрезентативный benchmark.

Source report file SHA и logical corpus fingerprint различаются по назначению. [Replay manifest](evidence/s3-01-corpus-manifest.json) фиксирует config/report bytes, source/runtime code hashes и результат точного повторного расчёта. Новые источники/изменённые окна требуют нового файла и fingerprint. Окна заданы явно для диагностики периодов; это не утверждённый training/holdout design.

## Что остаётся

В рабочей PostgreSQL по-прежнему одна каноническая карта, нет frozen dataset или активной модели. Эти HTTP captures не импортируются автоматически и не создают verified identity/series/patch/lineup proofs. Массовое повторение тех же постматчевых полей не устранит отсутствие раннего known-at.

**Следующий шаг остаётся S3-01:** собрать проверяемый evidence пакет для одного исторического multi-series cohort — canonical account links, series membership, dated lineup/side и patch release coverage; для post-draft также dated hero proof. Затем подготовить реальный frozen dataset через S3-00/v2 и выполнить независимый audit четырёх окон. При отсутствии такого evidence строгое обучение остаётся unavailable. Рекомендуемая модель — **GPT-6 Astra · Extra High** по проектному routing guide.
