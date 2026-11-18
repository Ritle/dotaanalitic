# S3-04/conditional-plan — зафиксированный эксперимент после пиков

13 ноября2026. [Машиночитаемый протокол](evidence/s3-04-conditional-protocol.json) зарегистрирован до обучения, выбора коэффициентов и расчёта метрик. Он предназначен только для исследования: `deployable:false`, активация и проценты в интерфейсе запрещены. Исходный V1 и его отдельный будущий протокол не меняются.

## Задача и ограничение исследования

Проверить, добавляет ли знание финальных десяти героев пользу к силе игроков, уже отражённой в Elo. Составы и герои восстановлены по завершённым картам и явно обозначены `conditional`. До старта не доказаны исторические heroes known-at; роли и canonical patch остаются неизвестными.

Весь доступный корпус рассматривается как ранее изучавшийся при разработке. Поздний блок называется **development_test**, а не новым слепым release holdout. Это временно отделённая ретроспективная диагностика. У всех2232карт `map_number` неизвестен: эксперимент оценивает отдельные карты любого номера и не обещает качество именно первых карт. Live between-map функция не добавляется.

## Разделение по времени

Все интервалы `[from,until)` в UTC. Серия целиком принадлежит одному блоку; при пересечении границы по началу или завершению любой известной карты серия исключается целиком. Один канонический match ID встречается ровно один раз. Разные local series UUID с одним проверенным OpenDota provider reference объединяются (другие namespaces в этой версии не допускаются); конфликт reference вызывает отказ, неизвестная серия исключается. Известная непригодная карта исключает всех известных соседей серии. Неизвестные/неполученные карты не объявляются автоматически отсутствующими: полноту серии предстоит проверить в dataset builder.

| Блок | Период UTC | Карты в предварительном списке | Серии | Исходный знаменатель |
|---|---|---:|---:|---:|
| Warmup inventory | 01.01.2024–01.01.2025 | 5 | 5 | 6 |
| Обучение | 01.01.2025–01.05.2026 | 1183 | 567 | 1252 |
| Выбор параметров | 01.05.2026–01.07.2026 | 392 | 213 | 398 |
| Калибровка | 01.07.2026–01.09.2026 | 335 | 147 | 338 |
| Ретроспективное сравнение | 01.09.2026–05.11.2026 | 216 | 98 | 223 |

Всего2131 карта распределена,101 исключена; причины пересекаются и сохранены для каждого ID. От2167 кандидатов предыдущего аудита число отличается из-за временного диапазона, mode/lobby и исключения целых серий. В этом эксперименте зафиксированы Captains Mode2 и lobby1. Девять карт All Pick1 исключены **по режиму**, не из-за отсутствия timeline: наличие полного timeline по-прежнему не требуется для hero-only исследования.

Числа предварительные. Следующий срез проверяет OutcomeVerifier, canonical identities, достаточную историю и feature eligibility. Он вправе только дополнить фиксированный ledger причинами; скрыто удалять неудачные карты или менять окна нельзя. История Elo — отдельный проверенный пул более ранних pro-карт с нижней границей01.01.2024; пять строк warmup inventory не являются всем пулом истории. Для каждой цели история растёт хронологически до её cutoff.

## Три заранее выбранных варианта

- **M0:** неизменённый player Elo1500/K32/scale400, минимум5 завершённых более ранних pro-карт на игрока, без нового калибратора.
- **M1:** регуляризованная логистическая модель только на `ln(10) × eloDifference / 400`.
- **M2:** та же логистическая модель плюс signed hero presence: +1 для героя команды A,−1 для B,0 для отсутствующего героя. Вход содержит10 разных героев.

Team A — меньший числовой canonical team ID; стороны сопоставляются явно. M1/M2 без intercept, обучаемого центрирования и заполнения пропусков. При перестановке A/B все признаки меняют знак, положительная temperature-калибровка сохраняет комплементарность. Словарь героев строится **только по окончательным обучающим примерам**, ID сортируются численно; неизвестный модели герой даёт unavailable для M2, а карта остаётся в знаменателе.

M1/M2 получают одинаковые training examples, общий набор пригодных validation и calibration карт. L2, C∈{0.01,0.1,1},lbfgs,max_iter2000,tol1e−8, без class/sample weighting. C выбирается минимизацией validation log loss; при различии≤1e−12 выбирается меньший C. После выбора нет refit на train+validation. Отказ сходимости не позволяет молча менять настройки.

Для M1/M2 затем положительная temperature scaling на отдельном calibration блоке, T∈[0.25,4], минимизация log loss, bounded scalar optimization,tolerance1e−8,max1000iterations. Intercept отсутствует. Граница диапазона или отсутствие сходимости — insufficient; тестовый блок не выбирает калибратор. M0 остаётся исходным Elo. Конкретный fitting и Python→TS parity ещё не реализованы этим срезом.

## Защита от будущих данных

Одинаковый существующий V1 feature builder для всех трёх вариантов. `started_at < target_start` и `completed_at < target_start`; сама цель исключена. Признак Elo каждой training map строится walk-forward, а не из финальных рейтингов. Исходы более ранних validation/calibration/test карт могут обновлять только детерминированное состояние Elo после завершения; fitted coefficients, словарь, калибратор и пороги не обновляются. Это последовательная историческая симуляция с `event_time_assumed`, не доказанная историческая публичная доступность.

Ранее завершённые карты той же серии допускаются в историческом Elo по прежней policy; все карты этой серии остаются в одном fold. Результат текущей карты, GPM/KDA/duration, series score и будущие карты запрещены в признаках. Duration используется только в metadata для времени завершения и защиты границ. Исходы ещё не читались планировщиком и не входят в протокол.

В первой проверке отсутствуют role guesses, patch weights, player-hero rates, pairs/counters, pubs и draft order. Это ограниченный baseline для проверки пользы героев, **не реализация всех role/patch требований S3-04**. Более сложные признаки требуют новой заранее зарегистрированной версии после разбора первого результата.

## Условия интерпретации результата

Зафиксированы operational floors:200 train maps;50 в validation/calibration/development_test;25test series;минимум10 примеров каждого исхода в используемых блоках. Это защита от явно малой выборки, не расчёт статистической мощности и не гарантия качества.

Primary — paired log-loss delta M2_cal−M1_cal на строго одинаковых картах. Рядом M0, Brier, accuracy, reliability/ECE по10 фиксированным равным probability bins, N карт/серий, история/identity/hero coverage и разрезы по date/league/provider-patch. Provider patch label не становится verified canonical patch. Empty bin rate=null.

Исследовательский положительный сигнал требует одновременно:

1. Все минимальные размеры, provenance и parity checks; paired coverage≥80% исходного знаменателя позднего блока223карт. Дополнительные исключения сохраняются с причинами.
2. Верхняя граница95% percentile CI primary log-loss delta ниже0:2000 bootstrap samples целыми сериями, seed42. Это exploratory interval, без заявления новой глобальной слепой проверки.
3. Средний log loss M2_cal лучше M0; средний Brier не хуже обоих M0 и M1_cal; ECE M2_cal≤0.10.

Первый результат записывается один раз, включая negative/insufficient; исправления создают связанную новую ревизию. Raw/calibrated показатели показываются как диагностика, выбор лучшего по test запрещён. Даже положительный сигнал **не активирует модель**. Для release нужны отдельный независимый протокол после executable freeze, честная stage availability, решение role/patch scope, artifact/parity/security gates и явная активация.

## Воспроизведение и проверки

Только read-only/offline инструменты вне frozen V1 каталога `scripts`:

```powershell
# Создать новые имена: существующие evidence не перезаписываются.
node --env-file-if-exists=.env tools/audits/audit-post-draft-readiness.mjs .tools/new-draft-inventory.json
node --env-file-if-exists=.env tools/research/read-post-draft-metadata.mjs .tools/new-draft-metadata.json
node tools/research/post-draft-plan.mjs create .tools/new-draft-inventory.json .tools/new-draft-metadata.json .tools/new-draft-protocol.json
node tools/research/post-draft-plan.mjs verify .tools/new-draft-inventory.json .tools/new-draft-metadata.json .tools/new-draft-protocol.json
node --test tests/node/post-draft-plan.test.mjs tests/node/post-draft-readiness.test.mjs
```

Для проверки **зарегистрированного** протокола использовать исходные `.tools/s304-final.json` и `.tools/s304-plan-metadata-final.json`, а не свежий audit с другим computedAt. Protocol bind включает SHA точных input bytes, source/lineup/data revisions, policy и кода. Новый снимок БД или изменение кода требует новой версии, не замены старой. Файл содержит выбранные ID/dispositions, но не labels/features/коэффициенты и не является frozen training dataset.

11 целевых Node tests PASS: boundaries/completion, incomplete siblings/mode, provider aliases/conflicts/unknown series, duplicate/bigint/revision, outcome/order independence, invalid windows, CLI replay/overwrite/tamper. Unknown source series в первом тесте дал RED: `null===null` ошибочно допускало ключ; явная проверка ненулевого ID исправила его, финальный GREEN.

Frozen install/typecheck, полный test (962), build,54 migration checksums, docs links и diff check PASS. Финальная read-only проверка сохранила counts/queue/snapshot SHA/readiness:2232карты,3прогноза,3сценария,13заданий, model_eligible. Live API не вызывался повторно: используется20-map source evidence предыдущего среза. В системном Python sklearn отсутствует, но существующая `.venv` успешно проверена: Python3.11.9,scikit-learn1.8.0,numpy2.3.5,scipy1.17.0. Основные версии совпадают с `tools/ml/requirements-ci.txt`; установка не выполнялась. Перед fitting нужно зафиксировать полный environment/code manifest и проверить parity. Для подготовки dataset Python не требуется.

**Следующая задача: S3-04/frozen-dataset** — на зарегистрированном ledger проверить исходы и историю, построить walk-forward Elo/hero input snapshots и сохранить неизменяемую исследовательскую выборку с причинами пропусков, без обучения/активации. Рекомендуемая модель: GPT-6 Astra · High.
