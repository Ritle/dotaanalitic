# ML QA — непрерывное обучение и выпуск прогнозов

**S3-06/V1 runtime2026-11-02:** [CLI и immutable snapshots](S3_06_V1_RUNTIME_SNAPSHOTS.md) реализованы для условной одной карты. Реестр проверяется под lock до commit; отдельно проверяются code compatibility, явный Tier1 scope, current numeric identities и completed history. No active model → unavailable/null. Kernel/quality policy/full frozen evaluator не изменены. Положительные storage/concurrency tests — contract doubles в disposable DB, не эмпирическое качество; рабочая модель остаётся inactive. Следующий срез — owner API/UI, затем обязательный S3-07 forecast journal. Реальная release-оценка по прежнему протоколу не раньше2026-12-02T00:00Z.

**S3-05/V1 registry2026-11-02:** [регистрация и управление версией](S3_05_V1_MODEL_REGISTRY.md) реализованы отдельно от расчёта качества. Promote/rollback принимает только последнюю committed v2 revision с совпавшими plan/kernel/freeze/scorer SHA, passed/non-synthetic и допустимыми часами; поздний failed revision делает model readiness unavailable. Проверки положительного transaction protocol используют явно синтетические contract doubles в disposable БД, не считаются настоящим release pass. Реальная независимая оценка и runtime-выдача вероятностей остаются впереди.

**Актуальный checkpoint2026-11-02 — executable freeze:** [полный manifest V1 и отдельная исполняемая копия](S3_03_V1_EXECUTABLE_FREEZE.md) зарегистрированы и проверены до test window. Report v2 связывает plan/kernel/freeze/source/scorer; releaseGate true требует completed + quality passed + non-synthetic. Активация отдельно, deployable false. Legacy v1 не получает новый допуск автоматически. Реальных оценок0; окно по-прежнему2026-12-02T00:00Z, Elo и пороги неизменны. Следующий срез S3-05/06 — gate/registry/snapshots; прежние checkpoints ниже исторические.

**Новый checkpoint2026-11-02:** [source-bound V1 evaluator + immutable release journal](S3_03_V1_RELEASE_EVALUATION.md) реализованы. Численный qualityDecision отделён от releaseGatePassed: полный executable пока не frozen, activation запрещена. Учитывается полный series-alias denominator; первый результат, включая insufficient/unavailable, сохраняется до публикации и не заменяется без explicit revision. Реальных оценок0. Далее S3-03/V1-executable-freeze; старые checkpoints ниже исторические.

**Последний checkpoint2026-11-02:** [S3-03/V1 release source capture](S3_03_V1_RELEASE_EVIDENCE.md) реализован: raw-source replay, immutable inventory/metadata, сохранение denominator и отдельная per-map history. Kernel r2 неактивен, full executable freeze false. Следующий срез — source-bound release metrics и first-result/revision journal; настоящая release-оценка не выполнена. Более ранние checkpoints ниже описывают состояние до этого среза.

**Редакция V1, 2026-11-02:** [TECHNICAL_SPEC §0](../TECHNICAL_SPEC.md) допускает отдельно проверяемый conditional player-Elo без patch/role/side/draft features. Старые research E0/E1 не активируются. Ниже требования к общей системе; profile-specific исключения явно перечислены в правилах 2–5.

## Жёсткие инварианты P0

1. Target = победа **на карте**; подтверждённая про-карта и актуальная ориентация Team A/Team B. User guess/model prediction не являются меткой.
2. История строго до cutoff; исходы обновляют рейтинг только после завершения и согласно объявленной availability policy. Для conditional V1 состав целевой карты разрешено реконструировать с явной маркировкой; это не prospective accuracy. Strict/owner/prospective evidence не смешивать и не backdate-ить.
3. Для фиксированного Elo — chronological warmup + untouched test; отдельные более ранние validation/calibration нужны при tuning/fitting. Для logistic остаётся соответствующий train/calibration/validation/test pipeline. Все карты известной серии в одном split. Live between-map прогнозы вне V1.
4. Gate требует только данные используемого профиля. Unknown patch не блокирует patch-free V1; временная устойчивость и coverage проверяются. У patch-dependent модели сохраняется cold-start policy. Никаких запасных 50/50.
5. V1 выпускается как одна pre-match модель. Brier/LogLoss, calibration/reliability, baseline, N карт/серий, coverage, uncertainty и evaluation basis обязательны. Фит калибратора не обязателен при прошедшей проверке без него. Post-draft проверяется отдельно при добавлении, на сопоставимом holdout. Пороги регистрируются до release test; универсального N=300 нет.
6. Датасеты frozen с SHA, feature-schema/code revision, list of match IDs; дополнительные реальные результаты приводят к **новой версии**.
7. Candidate model `deployable:false` пока отдельный promotion-gate не проверен. Автоактивация моделей отключена по умолчанию.

## S3-01/V1: зарегистрированная проверка Tier 1 — 2026-11-02

Реализованы `contracts/v1-release-plan`, pure `db/v1-release-plan` и offline CLI `release:plan create|verify`. [Request](evidence/s3-01-v1-release-request.json) и [план](evidence/s3-01-v1-release-plan.json) зарегистрированы **2026-11-01T23:46:38.285Z** (2 ноября02:46 МСК), до тестового окна. SHA плана `a4636dac08d439301c32f6f6d61303b10c5fe6f5f4486e5c1d71f67f84a0cbef`. [Manifest/replay/source evidence](evidence/s3-01-v1-release-registration.json). Это регистрация требований; вычисление release metrics, сбор test corpus и активация модели ещё не выполнены.

Первый target — **BLAST Slam IX 2026, main event, OpenDota league20208**. Scope проверен по каталогу и [обновлению организатора от6 августа2026](https://blast.tv/dota/news/blast-slam-ix-the-battle-moves-online):20–29 ноября,16 команд, основной международный турнир. Это конкретное reviewed включение в Tier 1 область MVP, не универсальная классификация `professional`/`premium`. Региональные квалификации имеют другие IDs и не включены. Старые даты17–29 ноября из январского rulebook не использованы; DreamLeague30 пока отсутствует в полученном OpenDota каталоге как main-event ID и не добавлен по предположению.

| Условие | Зафиксированное значение |
|---|---|
| Test window, UTC, начало включено/конец исключён | 2026-11-20T00:00:00Z → 2026-11-30T00:00:00Z |
| Финальный snapshot / оценка не раньше | 2026-12-02T00:00:00Z — **2 декабря03:00 МСК** |
| Freeze executable candidate до | 2026-11-20T00:00:00Z; код нельзя подбирать по test outcomes |
| Warmup window | С2024-01-01; все eligible более ранние карты frozen inventory, включая verified pro других тиров |
| Модель | Player-mean Elo,1500/K32/scale400; без fitted calibrator, patch/roles/heroes/side bonus/pub features |
| Покрытие каждой оцениваемой пятёрки | 10 разных verified numeric identities; минимум5 ранее завершённых pro-карт на каждого |
| Минимальный test sample | 100 карт,40 известных серий |
| Coverage | Не ниже80% observed target map IDs и80% observed known series |
| Brier / log loss | ≤0.245 / ≤0.685; log натуральный, clipping1e-15 |
| Сравнение с baseline | На тех же картах p=0.5: Brier0.25/log loss ln(2); верхняя95%-граница разности candidate−baseline строго<0 для обоих scores |
| Калибровка | ECE≤0.08, верхняя95%-граница ECE≤0.15, abs(mean(p)−mean(y))≤0.05 |
| Reliability bins | [0,.2),[.2,.4),[.4,.6),[.6,.8),[.8,1]; N/mean(p)/observed WR по каждому; пустой bin rate=null |
| Uncertainty | 10000 paired whole-series percentile bootstrap draws, seed20261102/Mulberry32; верхний квантиль0.95, linear interpolation index(n−1)q |
| Временная устойчивость | Серии сортируются по первому старту/key; первые floor(S/2) против остальных; ≥25 карт/10 серий в каждой половине, Brier delta≤0.02 и log loss delta≤0.04 в каждой |

100/40,80%,5 historical maps и числовые допуски — заранее выбранные **инженерные критерии пилота**, не измеренная достаточная мощность, не гарантия точности и не новый универсальный стандарт. Sample floor позволяет осмысленно проверять один турнир, а uncertainty/coverage/calibration gates могут всё равно не пройти. Порог5 показывает минимальную личную историю; отсутствие данных не штраф к силе игрока. Более холодные verified карты могут обновлять историю, но не получают опубликованную вероятность при неполном target coverage. Число100 не оправдывает публикацию без остальных проверок.

Brier/log loss не заменяют калибровку: [документация scikit-learn](https://scikit-learn.org/stable/modules/calibration.html) объясняет, что они оценивают одновременно несколько свойств вероятностного прогноза. ECE здесь — взвешенная по N сумма абсолютных расхождений среднего p и WR в заранее заданных bins, с отдельными sample counts. Bootstrap resamples **серии целиком**, а candidate/baseline используют одни и те же resampled series; внутри draw score остаётся map-weighted. Не refit/replay Elo на переставленных bootstrap данных. Схема percentile/paired и роль seed описаны в [SciPy bootstrap](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html); адаптация к series blocks и выбранные thresholds — решение проекта, не рекомендация SciPy. Такой interval условен по наблюдённому событию/истории, не устраняет зависимости между сериями общих команд и не означает95% уверенности в исходе отдельной игры.

Ориентация для метрик — Team A с меньшим numeric canonical team ID, не автоматически Radiant. Rating history и labels разделены, в history допускаются только completed_at **строго раньше** target start. Это новый V1 feature profile; существующий E0/E1 replay с прежней boundary semantics не переименовывать в V1. Prequential earlier completed updates допустимы в offline conditional backtest; это не реализация live/between-map UI и не prospective accuracy. Series-level test exclusions не должны позволять будущим строкам задним числом менять уже доступную историю признаков.

Все наблюдённые target IDs получают сохранённое решение. Missing imports, неподтверждённые исходы/identities, unknown series и cold-start остаются в map coverage denominator, а не исчезают ради высокого coverage. Известные серии исключаются целиком при пересечении границ или missing/ineligible known siblings. Независимые перекрывающиеся серии разрешены при строгом cutoff; консервативный запрет overlap E1 не переносится в V1. Remote completeness остаётся unknown без отдельного доказательства; полное покрытие локального ledger не доказывает, что API вернул все карты мира. Лимит5000 inventory maps — отказ без усечения; изменение capacity требует явной новой версии плана до анализа test outcomes.

Все gates обязательны. Недостаток N/coverage → `insufficient_evidence`, missing/nonfinite metric → `unavailable`, metric failure → `failed`; вероятность null. Даже успешная оценка означает только допуск к отдельному activation review. Нет автоматической активации, подбора K/scale/calibrator по holdout, продления окна или снижения порогов после результата. Отмена/перенос турнира, исправления источников и новый эксперимент требуют отдельных версий с сохранением первоначального плана/первой оценки. Это пилот на одном event; он не доказывает универсальную точность на всех Tier 1 турнирах. Runtime allowlist следующих editions — отдельная reviewed scope revision, без автоматического включения по бренду.

### Источники и независимость

Один настоящий OpenDota `/leagues` HTTP200 через существующий client/PostgreSQL quota:10411 строк, fetchedAt2026-11-01T23:41:42.944Z; raw payload SHA`64f652f50c0212e75815388bdcc04d048ff2ec3c5f2b8df6ba3b333f4b4a63cf`. Capture `.tools/v1-release-leagues-20261102.json`, file SHA`2b82bfc6b2b9d1123cb6c34dba29e467dec7c2b6aed2d751ea89c09b4191f968`. Каталог не содержит test outcomes. Чтение не импортировало карты/модели; изменился только служебный quota state.

Ретроспективный untouched temporal holdout **в принципе разрешён**; ожидание будущей даты не является общим правилом V1. Но рассмотренный DreamLeague29 уже представлен40 distinct maps в прежних history captures. Bounded проверка209 известных файлов сохранена в `.tools/v1-release-prior-exposure.json`; это не глобальное доказательство отсутствия/наличия просмотра всех данных. Просмотренный development корпус232 карты и E0/E1 не названы новым independent test. Для данного протокола выбран будущий main event с известным ID, без загрузки его matches/results. E1 остаётся отдельным исследованием со своими ноябрьскими датами и своим SHA.

```powershell
pnpm release:plan verify docs/evidence/s3-01-v1-release-plan.json a4636dac08d439301c32f6f6d61303b10c5fe6f5f4486e5c1d71f67f84a0cbef .tools/v1-release-leagues-20261102.json .tools/v1-data-export.json
```

Для нового плана: `pnpm release:plan create request.json catalogue.json development.json new-plan.json`. Create использует реальное время, требует его строго до test start, валидирует точные catalogue ID/name/pro status, явное reviewed scope решение, raw payload SHA и development snapshot. Verify проверяет внешний SHA каждого input до parse, затем полный replay плана с сохранённым registeredAt; изменённые thresholds не пройдут replay. Output `wx`, нет DB/network/scoring внутри planner. Успешный verify воспроизводит тот же fingerprint, не доказывает прохождение ещё не реализованного quality evaluator. Локальная регистрация не является внешним timestamp attestation.

После регистрации исправлен только guard для нечислового ID: `safeParse` возвращает обычный validation failure вместо native BigInt SyntaxError. Failing regression воспроизведена до исправления,9 targeted tests повторно PASS. [Отдельная code-revision запись](evidence/s3-01-v1-release-validation-fix.json) сохраняет первоначальный registration manifest; план, его SHA и quality policy не изменены.

**Discovery/detail/links/binding checkpoints2026-11-02:** [collector/immutable ledger/union, detail capture и E1 evidence binding](S3_01_E1_PROTOCOL.md) реализованы; live E1 pilot622 IDs/1 target, partial по budget. Target импортирован, pro outcome verified1/1; после6 reviewed numeric-account links и регистрации series1163385 current data-ready1/1,10/10 canonical players. [Evidence привязок](evidence/s3-01-evaluation-links.json). E1 capture/evaluate требуют raw-source replay всех fixed batches pinned union; пропуски и конфликты сохраняются в coverage, whole-series exclusions применяются до прежнего Elo replay. [Evidence binding](evidence/s3-01-research-evidence-binding.json). Журнал первой сохранённой E1 evaluation и явных revisions реализован в migration023: атомарный append перед публикацией, exact retry, parent/reason lineage и восстановление bytes без scorer. [Evidence журнала](evidence/s3-01-research-journal.json). Это не выполненный scoring gate и не полное удалённое покрытие. **S3-02/V1-features выполнен:** [shared builder и development export](S3_02_V1_FEATURES.md), 152/232 feature-ready без оценки качества. [S3-03 kernel artifact и metric diagnostic](S3_03_V1_CANDIDATE.md) реализованы, но полного source-bound release executor и first-result journal ещё нет. Это следующий точный срез S3-03/V1-release-evidence; actual S3-01 evaluation остаётся открытой. Подготовка кода, history и UI не должна ждать окончания test window.

## Что действительно реализовано в v7

`tools/ml/pipeline.py` валидирует confirmed pro labels, ts cutoffs, split chronology, series separation, feature schema, уникальность карт. `train.py` обучает logistic + отдельную калибровку и сохраняет JSON candidate, `evaluate.py` и `scripts/check-ml-parity.mjs` проверяют исходящий артефакт. Golden файл `tests/golden/synthetic-logistic-candidate.json` создан на синтетике и **никогда** не используется для реальных прогнозов.

## Чего ещё нет (S3)

- Подключение V1 shared feature builder к production runtime repository и immutable prediction snapshots. Verified development adapter и общий Elo builder уже реализованы; расширенные role/patch features остаются будущим S3-02.
- Source-bound release evaluator, first-result journal и runtime activation gate; pure metric kernel уже реализован, зарегистрированные thresholds не проверены на реальном release test. Автоматическая promotion / champion-challenger остаётся вне этого среза.
- Переобучение на реальных исходах, stable inference endpoint и scoring history. Подготовленный loader — не опубликованная модель.

## Операция воспроизведения synthetic baseline

```bash
python -m pip install -r tools/ml/requirements-ci.txt
python -m pip install --no-deps -e tools/ml
PYTHONPATH=tools/ml python -m pytest tools/ml/tests -q
python tools/ml/train.py --dataset tests/fixtures/ml/synthetic_history.jsonl --output /tmp/demo-dota.json --allow-synthetic
python tools/ml/evaluate.py /tmp/demo-dota.json
node scripts/check-ml-parity.mjs /tmp/demo-dota.json
```
