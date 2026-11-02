# S3-03/V1-candidate — неактивный артефакт и расчёт метрик

Последующий checkpoint: [source-bound evaluation и журнал](S3_03_V1_RELEASE_EVALUATION.md), kernel r3. Ревизии r1/r2 ниже исторические; параметры Elo и quality policy не изменились. До регистрации полного executable и реальной независимой проверки публикация прогнозов остаётся закрытой.

Обновление 2026-11-02: [release source capture](S3_03_V1_RELEASE_EVIDENCE.md) реализован отдельным срезом. Новый [kernel r2](evidence/s3-03-v1-kernel-candidate-r2.json) фиксирует расширенный code manifest; исходный artifact ниже сохранён как историческая версия и требует прежнего кода для verify. Elo parameters/quality policy/план не изменены. Следующий шаг — release evaluator/first-result journal, затем полный executable freeze; фактической release-оценки ещё нет. Описанные ниже команды и QA относятся к checkpoint первой ревизии.

Checkpoint2026-11-02. Реализованы artifact registration/verification, shared Elo diagnostic scorer и чистое ядро оценки метрик. **Весь S3-03 остаётся открытым**: release capture/source binding, первый сохранённый результат и реальная независимая оценка ещё не выполнены. Прогнозы не активированы.

## Артефакт и доверенные границы

`contracts/v1-candidate.ts` задаёт строгие registration/code/metric contracts. `prediction/v1-candidate.ts` создаёт `v1-fixed-elo-candidate-v1`; `db/v1-candidate.ts` сначала полностью воспроизводит план по catalogue/development evidence. `candidate:v1 create|verify` проверяет внешние file SHA до parse, текущий compiled code manifest и внутренний fingerprint. Изменение параметров, preprocessing/calibrator, parity probes, code/data/plan binding или флага activation отвергается даже при пересчитанном внутреннем hash.

Артефакт хранит feature policy/version, feature order `[eloDifference]`, base10 Elo link со scale400, отсутствие fitting/calibrator/side bonus, plan/dataset/code/config SHA и время регистрации. `trainingRunId` и fitting seed — null: fixed policy не обучается на development датасете; dataset reference нужен для provenance. Bootstrap seed отдельно фиксирован в quality policy. `isActive:false`, `qualityGate:not_evaluated`, `deployable:false`, `teamAWinProbability:null` неизменны в этом формате. Для будущей активации нужен отдельный проверенный контракт.

Пять арифметических probes с разницей рейтингов −800/−400/0/400/800 проверяют inference с допуском1e−14. Это синтетические математические проверки, не обучающие карты и не прогнозы реальных матчей. `createV1CandidateDiagnosticScorer` повторно вызывает общий feature builder и выдаёт только внутреннюю `evaluationProbability` для будущего offline evaluator. Cold start остаётся null; warmup window и synthetic provenance должны совпадать с артефактом. Произвольный сохранённый feature JSON не считается доверенным. HTTP/API публикации вероятностей нет.

## Исполняемая политика метрик

`V1_RELEASE_QUALITY_POLICY` перенесена без изменения JSON из db в `prediction/v1-quality-policy.ts`; прежний db export сохранён. Объект и вложенные массивы/поля заморожены, чтобы вызывающий код не изменил thresholds/seed. Замороженный [release plan](evidence/s3-01-v1-release-plan.json) воспроизводится точно.

`evaluateV1MetricDiagnostic` принимает явный `purpose:unbound_metric_diagnostic`, отдельные строки map-level probabilities/labels и полный supplied ledger. Проверяет уникальность bigint-safe map IDs, согласование scored/excluded, известные series keys и отсутствие частично оценённой известной серии. Исключённые/неизвестные target IDs сохраняются в знаменателе; known-series coverage учитывает наблюдённые известные серии. Подмена ledger или probability вне [0,1]/NaN/Infinity возвращает unavailable без метрик.

Реализованы зарегистрированные Brier/log loss, natural log и clipping1e−15 только для log loss, baseline0.5 на тех же картах, reliability bins [0,.2),[.2,.4),[.4,.6),[.6,.8),[.8,1], ECE и mean probability gap. Пустые bins/rates и n=0 дают null. Для сравнения с baseline сначала считается разность **по каждой карте**, затем агрегируется: одинаковый baseline даёт точно0, а не ложное преимущество из-за округления сумм.

Uncertainty:10000 deterministic paired whole-series bootstrap draws, Mulberry32 uint32, seed20261102. Серии сортируются provider/numeric ID, resample берёт целые серии, итоговые scores взвешены количеством карт. Elo не refit/replay на переставленных данных. Upper95 — линейная интерполяция индекса(n−1)×.95. Тест с неодинаковыми размерами серий сверяет ручные контрольные значения. Устойчивость проверяет первые floor(S/2) серий против остатка по first start/key, не переносит отдельные карты между половинами.

Недостаток N/coverage/half sample даёт `metricGateDecision:insufficient_evidence`; при этом доступные descriptive metrics остаются диагностикой, bootstrap не запускается. После достаточного sample проверяются все зарегистрированные metric/calibration/uncertainty/stability thresholds, включая строго отрицательные baseline upper bounds.

**Даже `metricGateDecision:passed` не является release gate.** Всегда `sourceEvidence:not_bound`, `releaseGatePassed:false`, `deployable:false` и probability null в пользовательском поле. Ядро не подтверждает pro labels, target scope/orientation, candidate identity, completeness, время доступности источников или первую оценку. Эти обязательные проверки принадлежат следующему release executor. Произвольные probabilities/labels разрешены здесь только как вход математической диагностики, а не ground truth для обучения.

## Созданный kernel artifact

[Артефакт](evidence/s3-03-v1-kernel-candidate.json) зарегистрирован2026-11-02T13:54:45.976Z; SHA-256 `f328236bad6d9702e00d3e7db7c4a527708a86d5adf2de8765828758c1332221`. Plan SHA `a4636dac08d439301c32f6f6d61303b10c5fe6f5f4486e5c1d71f67f84a0cbef`; development SHA `79ae50020134a30ad822d9780934518e64010fb85fc367885d3e12092c70eed5`. SyntheticOnly=false относится к источнику development, не превращает арифметические probes в реальные наблюдения. Проверка повторила тот же artifact fingerprint и code manifest; DB model registry не изменялся.

```powershell
pnpm candidate:v1 verify docs/evidence/s3-03-v1-kernel-candidate.json f328236bad6d9702e00d3e7db7c4a527708a86d5adf2de8765828758c1332221 docs/evidence/s3-01-v1-release-plan.json a4636dac08d439301c32f6f6d61303b10c5fe6f5f4486e5c1d71f67f84a0cbef .tools/v1-release-leagues-20261102.json .tools/v1-data-export.json
```

Create: `pnpm candidate:v1 create plan.json PLAN_SHA256 catalogue.json development.json new-candidate.json`. Это запись нового kernel artifact, не обучение, не activation и не новый independent test. Реальное время должно быть до первого test start. Output exclusive + fsync; при технической ошибке может остаться пустой/неполный файл, повтор требует нового имени. Проверка старого артефакта не ограничена будущим окончанием test window, но требует той же версии кода. Пути для manifest заданы CLI, не берутся из недоверенного артефакта.

**`executableFreeze.complete:false`:** зафиксирован kernel, а full release evidence executor ещё не существует. Нельзя объявлять весь executable frozen до его реализации и итоговой регистрации полного набора кода до20 ноября. Локальная дата не является внешней timestamp attestation. SHA обнаруживает изменения относительно доверенного reference; это не подпись и не защита от владельца, переписывающего код/часы/референсы.

Реальные E1/release metrics не рассчитывались; команда `evaluate` отсутствует и отвергается. E1 сохраняет своё отдельное окно/политику; release оценка не раньше2 декабря03:00 МСК по уже зарегистрированному плану. Synthetic tests не подтверждают accuracy/coverage реальных будущих матчей. Последний live source audit — [S3-02 evidence](evidence/s3-02-v1-features.json),1 historical pro map/3 HTTP200; новых provider calls и canonical imports в этом срезе нет.

Следующий точный срез **S3-03/V1-release-evidence:** source-bound release capture/executor с immutable candidate/ledger/detail/snapshot bindings, whole-series eligibility и независимой историей признаков, current clock gate, журналом первой оценки/explicit revisions. Только после этого — полный executable freeze и фактическая оценка в разрешённое время. Существующий E1 journal нельзя молча назвать release journal.

Проверки PASS: frozen install/typecheck/build,621 unit/CLI tests (21 новых),21 isolated PG regressions,23 migration hashes, syntax/docs links/git diff. E0 exact replay, все232 feature rows и21 рабочая таблица сохранены. [Evidence проверки](evidence/s3-03-v1-kernel-verification.json), SHA `67cd47dd921b0b250fbed8763f25ea5199b14cdc39553034fa573320de7fc6b2`. E2E/Python не запускались: UI/HTTP/fitting не менялись.
