# S1-06 — объём выборки, сглаживание и Kish N_eff

Добавлены sample metadata в pro-map/player-hero/roster отчёты и отдельная экспериментальная **сглаженная наблюдаемая частота** в player×hero×role. Сырые wins/N/WR и per-field denominators сохранены. Это описательные оценки прошлой локальной истории, не прогноз следующей карты; `model:null`, prediction eligibility не меняется.

## Размер выборки и веса

- `sampleEvidence.policyVersion=sample-evidence-v1`: nRaw nullable, band unknown/empty/under_10/10_to_29/30_or_more, coldStart=true только при известном N=0, smallSample=true при N<30. N=null не превращается в0.
- Границы10/30 — **продуктовые категории** из спецификации, не доверительный уровень и не гарантия устойчивости. Нет процентов confidence, условного «качество70%» или доказанной точности от одного N.
- Текущие HTTP отчёты не взвешены: nEff=null, weightPolicyVersion=null. `@dota/analytics.weightedSample` принимает явные `{matchId,won,weight}` + policy version, возвращает raw rate отдельно от weightedRate и Kish nEff `(sum(w))²/sum(w²)`. Используется нормировка на max weight для численной устойчивости; uniform weights дают N, нулевые веса не добавляют эффективных наблюдений, all-zero/empty → null.
- Duplicate canonical IDs, отрицательные/NaN/Infinity веса отвергаются. Один map ID — одна запись в конкретной weighted выборке. Kish отражает неоднородность **реальных заданных весов**, не зависимость карт одной серии/состава. Time/patch/hero-impact weights здесь не назначаются: их отдельная policy/validation — S1-07/S3.
- Missing metrics сохраняют собственные nMaps. Unknown canonical roster/history остаётся null; unknown hero/role/patch и coverage по-прежнему раскрываются отдельно. Sample band применяется к наблюдаемому N, а не к N+prior mass.

## Ранний сопоставимый reference-пул

Player hero report читает второй local inventory в той же repeatable-read транзакции. Все reference карты имеют `started_at < selected fromAt` и completion<=fromAt, проверенное SQL с микросекундами. Текущие наблюдения имеют fromAt<=start<cutoff. Эти периоды не пересекаются; исходы текущего окна не подбирают параметры prior.

Pool содержит только completed non-conflict `is_pro IS TRUE` карты. Hero ID положительный, уникален среди native slots карты; confirmed role совпадает с заново проверенной source-account identity, basis=confirmed/confidence null или1. Patch — reviewed registry timestamp/coverage, без source patch hint. Series linkage требует accepted ref-linked proof, совпадающий с FK. Current retrospective identity/role/release evidence допустима только как текущая описательная реконструкция, не historical known-as-of feature eligibility.

`referencePool.globalBuckets` — hero×role raw reference statistics по **всем патчам**; `buckets` — те же наблюдения отдельно по patch (включая unknown). Side/opponent/league/explicit role filters совпадают с пользовательской выборкой. Не путать суммарные hero observations с независимыми картами: одна карта может дать10 разных hero rows, но в одном hero bucket считается один раз. Есть candidates/eligible-map/role/patch/series counters и per-map source/sync/fetched/revision/proof manifest.

У coverage.candidates/eligibleMaps единица — карта; confirmedRoles/knownPatches/verifiedSeries имеют знаменатель **heroObservations**, а не количество уникальных патчей/серий или карт.

## Определение prior и оценки

`earlier-reference-beta-v1` использует **ровно тот же hero, confirmed role и один verified patch**. Unknown или mixed patch/role/hero не получают fallback из другого контекста. Для существующих target observations серии должны быть подтверждены. Reference карты с unknown series или с series ID любой известной карты текущей player sample исключаются из prior, даже если времена оказались по разные стороны границы.

Из оставшихся ранних reference карт берутся `alpha=referenceWins`, `beta=referenceLosses`, `priorMean=alpha/(alpha+beta)`, `priorMass=referenceN`. Это явно определённый **эмпирический count prior**, а не оптимизированный перенос глобального среднего на конкретного игрока. Произвольного k, стартовых псевдо-побед и нейтрального50/50 по умолчанию нет. Параметры оцениваются только на отдельном более раннем reference/estimation отрезке, без подбора по текущему observation окну или final holdout. Такой выбор массы — предположение экспериментальной описательной политики; predictive use требует отдельной temporal validation, exchangeability/drift/series checks и frozen training provenance.

Требуются оба реально наблюдённых исхода, чтобы prior имел alpha>0 и beta>0. Empty/one-outcome reference → unavailable, без Beta(0,n) или неявного Beta(1,1). Формула оценки: `(selectedWins+alpha)/(selectedN+alpha+beta)`. Её выводят отдельно от raw WR с prior mean/mass/context/beforeAt/map IDs/series IDs и `validation:unvalidated_descriptive`. При N=0 raw rate=null; допустим явно помеченный prior-only estimate, если контекст задан heroId/rolePos и проверенным patch и существует подходящий prior. Это не наблюдаемые победы целевого игрока.

В каждом player×hero×role bucket собственные prior/estimate; общий summary получает оценку только для единственного конкретного контекста. При отсутствии данных/контекста значение null с reason. Крупный reference pool (>5000 global candidates) **отключает только smoothing**, сохраняя полноценную сырую player statistics; обрезанный prior не строится. При unavailable pool его непосчитанные coverage counts=null, а не0; известный пустой pool имеет counts0. Existing target-window >5000/current-patch-unknown gates остаются прежними.

## API и интерфейс

Новых HTTP маршрутов/параметров нет. `/players/:id/heroes` дополнен referencePool, summary smoothing и per-group smoothing/sampleEvidence. `/teams|players/:id/matches` summary и roster exact/pair/player/organization samples дополнены sampleEvidence. Auth/no-store/CSRF для прежних POST неизменны. UI явно различает raw/smoothed/prior-only, категории N, неприменимый unweighted N_eff, null/empty/overflow/context states и reference глобальные/патчевые показатели.

Никакого persistent training/model artifact или approved predictive prior не создаётся; reference estimation — текущая воспроизводимая описательная статистика с input/source revision manifest. Синтетика только в disposable tests/demo fixtures, без записи в рабочую БД. Никаких новых dependencies/lockfile/migrations, SQL001–013 сохранены.

Проверки: pure sample/math и reference temporal/context/series tests, `pnpm test:sample` (реальный PG/API), регрессия существующих report endpoints, Chromium sample flow. Следующая задача — **S1-07: проверенная мета патча**.
