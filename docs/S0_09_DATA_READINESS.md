# S0-09 — доступность контекста и исследовательские cohorts

## Реализованный срез

`DataReadinessRepository.assess` и чистая `assessContextReadiness` оценивают **доступность фактов текущей карты**: lineup, roles, teams, patch, heroes и optional first-pick/ruleset version. Обязателен явный профиль: stage, cohort, requiredFacts, assumedFacts, cutoffAt, snapshotAt. Политика **context-availability-v1** формирует policyKey; список готовых map IDs можно получить через selectReadyMapIds только для одного policyKey. Повторы одной карты не увеличивают N, несовместимые снимки и смешение policies отклоняются независимо от порядка.

Это внутреннее read-only чтение, без HTTP endpoint, автоматического импорта или подготовки feature vectors. `status:ready` означает наличие запрошенных context facts в выбранной cohort. **trainingEligibility/predictionEligibility всегда not_assessed.** Проверки pro-label/source, истории, hero eligibility, feature schema, weights, backtest/calibration и model activation остаются отдельными. Ни вероятности, ни показатели качества модели не создаются.

## Три явных режима

| Cohort | Какие источники допускаются | Как интерпретировать |
|---|---|---|
| strict_verified_asof | Accepted verified_asof proof с knownAt/eventAt не позже cutoff, допустимой стадией | Исторически подтверждённая доступность контекста; дальнейшие quality gates обязательны |
| owner_asserted_asof | Те же verified facts плюс accepted user_asserted_asof с provider=owner, evidenceRef, knownAt, **fetchedAt и серверным recordedAt <= cutoff** | Зафиксированное до cutoff утверждение владельца; отдельная оценка, не public historical evidence |
| conditional_lineup_reconstructed | Verified facts плюс accepted retrospective_fact **только** для явно перечисленных assumedFacts; lineup обязательно объявлен предположением | Ретроспективный эксперимент «если эти факты известны»; не prospective accuracy |

Для context proof сохраняются исходный availability class, три исходных времени, серверный recordedAt, source/ref, review и earliestStage. Для patch evidence availability вычисляется из исходных registry clocks относительно cutoff; времена не переписываются. Источник unknown не становится retrospective или verified по полноте заполнения. Отсутствующее значение/конфликт возвращает fact:null с причиной; отсутствие доказательств не означает нулевую вероятность или нулевую историю.

Миграция **013** добавляет отдельный `match_field_observations.recorded_at`. INSERT trigger всегда ставит серверное время независимо от переданного значения: clock_timestamp с консервативной верхней миллисекундной границей. Начало долгой транзакции не позволяет задним числом датировать ввод. Старые строки остаются NULL и не допускаются как owner assertions; историческая дата записи не выдумывается. Immutable UPDATE/DELETE guard защищает отметку. Датированные публичные архивы по-прежнему могут доказывать более ранний knownAt, даже если получены позднее. Append DTO не принимает recordedAt.

## Временные и структурные границы

- `cutoffAt <= actual startedAt`, `cutoffAt <= snapshotAt`. Repository отказывает snapshot в будущем. Facts с fetchedAt после snapshot исключаются. Поздно полученный датированный архив может доказывать public knownAt в прошлом; поздно введённое owner assertion такого свойства не имеет.
- Strict и owner режимы соблюдают earliestStage и event/known cutoff. Pre-match никогда не возвращает hero/first-pick/draft-version values, даже в conditional cohort; запрос таких required/assumed facts отклоняется. Post-draft retrospective heroes требуют отдельного явного heroes assumption.
- Conditional cohort требует завершённой карты не позже snapshot. Истинность completion проверяется SQL до округления timestamp в JS; тест покрывает будущую микросекунду на границе. Реальные outcome/duration не проецируются в assessment facts.
- Необходимо 10 разных canonical player IDs в native слотах, существующих в players. Роли требуют той же десятки, confirmed basis, confidence null/1 и пяти различных позиций на сторону. Estimated/low-confidence/mismatched roles остаются unavailable. Это проверка готового canonical context proof, не замена identity resolver для source accounts.
- Heroes требуют 10 distinct native slots/heroes, teams — обе различные известные ссылки. First pick не выводится из Radiant, A/B не связываются по индексу массива. Full draft timeline validator остаётся P1; наличие версии не подтверждает последовательность.

Для patch используется существующий reviewed release registry, включая coverage horizon и conflict gates. Strict knowledgeAt=cutoff; late-known registry metadata может дать только retrospective patch в conditional cohort при **явном patch assumption**. Исходный knownAt не переписывается. Provider patch code и mutable patches catalog сами по себе не используются; owner assertions не подменяют release proof. Общая pure resolvePatchAt выделена из S0-06 без изменения поведения strict GameContextRepository.

## Источники и интеграция

Контекст читается из immutable typed context observations. **Готовые match_players, current-team flags, legacy raw players и picks_bans автоматически не преобразуются в pre-known или conditional context.** Retrospective proof должен поступить явно через существующий внутренний evidence boundary с соответствующим классом и review. Это предотвращает скрытое улучшение coverage задним числом. S3-00 при подготовке conditional corpus должен создать/зафиксировать такую проверенную проекцию и записать выбранные assumptions; этого collector в S0-09 нет.

Чтение map bounds/evidence, canonical ID existence и patch registry идёт в repeatable-read. Assessment содержит cohort/evidenceBasis, policyKey/versions, registryRevision, map dataRevision, required/missing facts, applied assumptions и proof metadata. Readiness не кэшируется; будущий cache не должен опираться только на match ID — проверяется также профиль, источник/ревизия и актуальная canonical ID membership. Существующий MatchContextRepository.readAsOf сохраняет прежнюю strict policy; добавлен отдельный внутренний readObservations inventory.

Strict, owner и conditional результаты нельзя объединять в один training/evaluation cohort или переименовывать в prospective. DatasetBuilder должен записать policyKey/cohort/assumptions в frozen manifest и дополнительно пройти S0-07 label gates и S3 feature gates. Реальная prospective оценка также требует доказанного pre-start created_at прогноза; readiness сама этого не устанавливает. Старые frozen snapshots не менялись.

## Проверки и следующий этап

Pure tests проверяют temporal/stage/cohort, owner backdating, late/future evidence, конфликт, роли/полноту, patch knowledge и смешение снимков. `pnpm test:readiness` выполняет реальные PostgreSQL tests в изолированной synthetic DB, включая отсутствие canonical-roster fallback, неизменность strict reader, серверную отметку/запрет backdating, clocks/revisions и completion microsecond boundary. CI содержит новый suite; новых библиотек нет. Reader требует 013; SQL 001–012 неизменны, следующий SQL — 014+.

S0-08 field coverage не переинтерпретируется как historical readiness: [40 live maps](S0_08_SOURCE_AUDIT.md) по-прежнему не имеют доказанной предматчевой известности состава/драфта. Фактические результаты проверок и working-DB smoke — [PROGRESS](PROGRESS.md), [PROJECT_STATE](PROJECT_STATE.md).

Следующая задача — **S1-01 [P0] Справочники и обзоры**: teams/players/heroes search, freshness, организация/состав/личность раздельно. Рекомендуемая модель: **GPT-6.1 Sol · High** по проектной матрице; переключение вручную. [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
