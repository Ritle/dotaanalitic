# S3-01 E1 — план расширения корпуса и будущей проверки

**Срез выполнен 2026-11-02:** реализован offline планировщик и до начала нового периода зафиксирован [машиночитаемый план](evidence/s3-01-e1-plan.json). Это продолжение выбранного владельцем [исследовательского E0](S3_01_E0_RESEARCH.md). Изменение дат/отбора после просмотра результатов требует новой версии и не считается независимым подтверждением старого плана.

**Последующие checkpoints:** все196 warmup-карт получены и импортированы,196 исходов подтверждены; рабочий корпус232 pro maps. Затем подтверждены32 numeric account identities и94 canonical серии, reimport заполнил все2320 player links; outcomes/players/heroes/teams/series232/232. [Импорт](S3_01_E1_IMPORT.md), [identity/series review и replay](S3_01_E1_LINKS.md). Таблица ниже фиксирует состояние при регистрации плана, до этих операций.

## Что зафиксировано при регистрации

| Параметр | Значение |
|---|---|
| Регистрация | 2026-11-01T21:21:12.075Z — **2 ноября 00:21:12 МСК** |
| Начало исторического окна | 2020-01-01T00:00:00Z |
| Новый holdout, старт включён, конец исключён | **2 ноября 03:00 — 9 ноября 03:00 МСК**, 2026 год |
| Финальный snapshot / оценка не ранее | **10 ноября 03:00 МСК**, 2026 год |
| Elo | player-mean-elo-v1, initialRating1500, K32, scale400; без подбора и калибровки |
| Предыдущий просмотренный корпус | 36 карт E0; его16 проверочных карт теперь могут быть только историей для E1 |
| Новые warmup-кандидаты | 196 discovery maps /94 provider-серии DreamLeague25, league17765 |
| Новые verified/импортированные карты в этом срезе | **0** |
| Holdout N / метрики сейчас | **NULL / NULL**, период ещё не начался |

Исторические кандидаты выбраны из последней по времени лиги уже сохранённого пятилигного discovery inventory. Взяты все её196 наблюдённых карт, а не восемь карт прежнего detailed audit. Среди discovery нет пересечения с36 E0 IDs/provider-series. Это расширит историю другим турниром и годом, но само по себе не обеспечит полноту карьеры нынешних игроков или репрезентативность всех тиров/регионов.

196 — список для получения и проверки полных исходных ответов. Положительная pro-классификация каталога и строки discovery ещё не заменяют canonical `is_pro`, OutcomeVerifier, десять verified identities и actual lineups. После detail/source/series/overlap проверок пригодных карт может оказаться меньше. Полнота API-лиги и удалённых серий неизвестна.

## Правила без просмотра новых исходов

Планировщик получает старый frozen E0 export и discovery с обязательными SHA. Он использует только match ID, старт, лигу, provider series ID и две организации. Winners/scores/duration/performance не участвуют в выборе. Другие поля отбрасываются схемой, исходный файл сохраняется с прежним SHA. Native outcomes не переписываются.

Регистрация должна предшествовать holdout; старый export должен быть получен раньше регистрации, а все его карты — раньше новой границы. Для warmup исключаются все известные siblings серии с неизвестным ID, противоречивой парой организаций, выходом за выбранные лиги/историческое окно или пересечением с прежним корпусом. Дубли, повреждённые fingerprints, несовпадение league/tier/endpoint, поздний source fetch и превышение лимита прекращают создание плана. Произвольного усечения до удобного N нет.

Для будущего holdout заранее задан отбор **всех наблюдённых и проверенных pro-карт** с началом в фиксированном окне. Основной source — OpenDota, discovery `/proMatches` и списки лиг, details `/matches/{id}`; использовать существующий backend client с PostgreSQL quota/retry. Полнота наблюдения остаётся unknown и должна быть отражена в финальном отчёте. Нельзя выбирать карты по фавориту, фактическому победителю или получившейся ошибке модели. При переполнении maxExportMaps5000 — остановка без усечения.

Существующие E0 whole-series и overlap guards сохраняются. Все локально известные siblings проверяются, в том числе за пределами окна; boundary-crossing, unknown/conflicting и перекрывающиеся серии исключаются целиком. Это консервативное правило может существенно уменьшить N при расширении корпуса; нельзя ослабить его после просмотра метрик, чтобы улучшить результат.

E1 остаётся event-time reconstruction с фактическими восстановленными составами, текущими проверенными numeric identities и без patch features. Результат предыдущей карты обновляет рейтинг только после её завершения, включая более ранние карты holdout. Это prequential оценка; она не доказывает, что реальный сервис заранее знал составы и публиковал такие прогнозы.

Новые метрики считаются один раз после окончания окна, на данных, доступных к фиксированному snapshot 10 ноября03:00 МСК. Период не продлевается из-за маленького N или плохого score. Коррекции источника оформляются новой версией с сохранением первой оценки. Brier/log loss и constant-prior baseline должны использовать те же карты; N, series count, cold-start coverage и все исключения сохраняются. При отсутствии пригодной выборки — NULL/reasons. Минимальный production sample size, calibration и promotion gates этим планом не установлены.

## Реализация и повторение

Contracts/research-plan, pure db/research-plan и CLI `research:plan` создают и проверяют **план**. Checkpoint2026-11-02 добавляет executable scoring guard и capture полного локального inventory через `research:execute` (ниже). Сбор будущих карт через `/proMatches`/списки лиг, журнал полноты discovery и автоматический scheduler/retraining ещё отсутствуют. Регистрация локальная и не является внешним timestamp attestation.

```powershell
pnpm research:plan create docs/evidence/s3-01-e1-plan-request.json .tools/s3-01-e0-export.json docs/evidence/s3-01-league-discovery.json .tools/new-e1-plan.json
```

`create` берёт текущее время регистрации, поэтому новый запуск создаёт другой артефакт и после начала периода отклоняется. Повторяемость проверяется через `verify` с сохранённым временем и теми же source bytes:

```powershell
pnpm research:plan verify docs/evidence/s3-01-e1-plan.json b8306aa23b4779dcd4ee0d26a34ee031767f458634df9e9da4ab37567abaaa62 .tools/s3-01-e0-export.json docs/evidence/s3-01-league-discovery.json
```

Реальный `verify` воспроизвёл весь план/fingerprint. Source SHA проверяется до parsing; UTF-8/JSON и schema проверяются, output создаётся exclusive `wx`, ошибки не раскрывают payload. CLI работает без БД/сети. Источники и план pinned в [request](evidence/s3-01-e1-plan-request.json); полный E0 export остаётся ignored локальным файлом. Код и replay evidence — в [manifest](evidence/s3-01-e1-plan-manifest.json).

## Проверки и следующий шаг

Восемь pure тестов проверяют детерминизм/невлияние исходов, late registration, повторное использование старых карт/серий, whole-series boundary, source provenance, duplicate/overflow, пустую выборку. CLI regression проверяет create/verify без рабочей DATABASE_URL, отказ перезаписи, source SHA и подмену плана с пересчитанным внешним SHA. Синтетика явно syntheticOnly:true.

Raw source capture/проверенный импорт196 warmup-кандидатов и [current identity/series completion](S3_01_E1_LINKS.md) выполнены. Исторические source clocks сохранены настоящими; late fetchedAt не становится ранним knownAt. Фактический расчёт holdout раньше10.11 03:00 МСК запрещён. Импорт не активирует модели.

## Executable guard и локальный capture — 2026-11-02

`research:execute` проверяет внешний SHA плана, SHA предыдущего export/discovery, затем полностью восстанавливает план из этих источников. Изменение вычисленных полей плана с новым внешним SHA не проходит replay; для E1 нужно сохранять именно зарегистрированный SHA из команды ниже. `check` работает offline, без чтения новой выборки и без метрик:

```powershell
$e1PlanSha = 'b8306aa23b4779dcd4ee0d26a34ee031767f458634df9e9da4ab37567abaaa62'
pnpm research:execute check docs/evidence/s3-01-e1-plan.json $e1PlanSha .tools/s3-01-e0-export.json docs/evidence/s3-01-league-discovery.json
```

После открытия временного gate доступны две операции. Пути назначения должны быть новыми; SHA capture берётся из вывода первой команды:

```powershell
pnpm research:execute evidence docs/evidence/s3-01-e1-plan.json $e1PlanSha .tools/s3-01-e0-export.json docs/evidence/s3-01-league-discovery.json .tools/e1-evidence.json <EVIDENCE_FILE_SHA256>
pnpm research:execute capture docs/evidence/s3-01-e1-plan.json $e1PlanSha .tools/s3-01-e0-export.json docs/evidence/s3-01-league-discovery.json .tools/e1-evidence.json <EVIDENCE_FILE_SHA256> .tools/e1-capture.json
pnpm research:execute evaluate docs/evidence/s3-01-e1-plan.json $e1PlanSha .tools/s3-01-e0-export.json docs/evidence/s3-01-league-discovery.json .tools/e1-capture.json <CAPTURE_SHA256> .tools/e1-report.json
```

CLI использует системное UTC-время, без clock override. До evaluationNotBefore отказывает **до подключения к PostgreSQL, чтения capture и scoring**. Capture использует существующий SELECT-only `ResearchEloRepository` в repeatable-read transaction: весь локальный inventory, без переданного пользователем списка holdout IDs. Request выводится только из плана; даты, лимиты, snapshot и Elo policy нельзя изменить аргументами. Чужой или повреждённый capture, будущий capturedAt, дубли и смена synthetic flag отклоняются. SHA — контроль целостности локальных файлов, не внешняя аттестация подлинности данных.

Все36 ранее просмотренных и196 discovery warmup IDs должны присутствовать с зарегистрированными start times. Если в историческом окне появились дополнительные незарегистрированные карты, capture останавливается с `EXECUTION_UNREGISTERED_WARMUP`: нельзя молча расширять историю либо убирать известного sibling ради score. Не удалять такие карты из рабочей БД ради проверки; следующий collector должен подготовить явно контролируемый research inventory. Повреждённые/неполные строки остаются кандидатами и получают причины исключения от старого evaluator. Локальные siblings вне окна сохраняются для whole-series/overlap guards. Ни E0 evaluator, ни frozen E1 plan не изменены.

Вложенный legacy envelope `research-elo-execution-v1` сохраняет исходный snapshot, plan fingerprint, реальное capturedAt и manifest исполняемого кода. Оболочка `research-evidence-execution-v1` связывает его с проверенным discovery union и всеми detail batches; см. раздел binding ниже. Вложенный отчёт `research-evidence-report-v1` фиксирует код scorer, причины исключений и coverage; окончательный экспорт `journalled-research-report-v1` добавляет identity записи PostgreSQL-журнала. Прежний bare capture больше не принимается командой `evaluate`, но старые pure E0/E1 replay функции и архивы сохранены. Файлы создаются exclusive `wx`; другой путь не создаёт новую evaluation. Source/code correction требует явной revision с сохранением первой. Generic E0 CLI не принимает новые envelopes напрямую; локальный guard не защищает от владельца, намеренно изменяющего код, системные часы или БД.

Метрики остаются исследовательскими: при отсутствии eligible warmup/holdout — null с причиной, окно не продлевается; всегда `releaseGate: not_assessed`, `trainingReady:false`, `deployable:false`, публичная вероятность null. Повторный replay одинакового capture детерминирован. Старые E0/E1 допущения, включая event-time availability и консервативное исключение overlapping series, сохранены. Подготовка CLI не подтверждает полноту удалённых матчей и не превращает E1 в Tier 1 release test.

Следующий на тот момент срез — Tier 1 manifest/thresholds — зарегистрирован отдельно в [MODEL_VALIDATION](MODEL_VALIDATION.md). Discovery checkpoint ниже реализует сбор метаданных. Метрики E1 не рассчитаны; задача V1-evaluation целиком не закрыта.

## Metadata discovery и immutable candidate ledger — 2026-11-02

Реализованы `evaluation-discovery` contracts, ingestion collector/ledger и `pnpm evaluation:discover collect|verify|merge`. План проверяется по pinned external SHA и полностью воспроизводится с предыдущими источниками, как в `research:execute` / `release:plan`. Для E1 scope — все наблюдённые карты фиксированного окна; для V1 — только зарегистрированные main-event league IDs/windows. Collector не рассчитывает вероятности, не импортирует canonical maps и не вызывает model activation.

Новые named-client методы `getProMatchDiscovery(cursor?)` и `getLeagueMatchDiscovery(id)` используют прежние backend timeout/retry/durable PG quota. Схема проецирует только match/start/league/series/two-team IDs; winners/scores/duration/players не участвуют в selection/ledger. Исходные ответы, которые могут содержать outcomes, сохраняются **локально** отдельными receipts с SHA; «outcome-blind» означает правило отбора, не отсутствие outcomes в байтах провайдера. Не публиковать raw receipts как часть общего отчёта.

Формат config (для E1; пути относительно рабочей директории репозитория):

```json
{
  "kind": "e1",
  "planPath": "docs/evidence/s3-01-e1-plan.json",
  "planSha256": "b8306aa23b4779dcd4ee0d26a34ee031767f458634df9e9da4ab37567abaaa62",
  "evidenceAPath": ".tools/s3-01-e0-export.json",
  "evidenceBPath": "docs/evidence/s3-01-league-discovery.json",
  "limits": { "maxProPages": 2, "maxLeagues": 10 }
}
```

V1 config: kind=`v1`, planPath=`docs/evidence/s3-01-v1-release-plan.json`, planSha256=`a4636dac08d439301c32f6f6d61303b10c5fe6f5f4486e5c1d71f67f84a0cbef`, evidenceAPath=`.tools/v1-release-leagues-20261102.json`, evidenceBPath=`.tools/v1-data-export.json`; limits имеют ту же форму. Примеры сохранены локально как `.tools/evaluation-discovery-{e1,v1}.json`.

```powershell
pnpm evaluation:discover collect .tools/evaluation-discovery-e1.json .tools/new-e1-discovery-run
pnpm evaluation:discover verify .tools/evaluation-discovery-e1.json .tools/new-e1-discovery-run <MANIFEST_SHA256>
pnpm evaluation:discover merge .tools/evaluation-discovery-e1.json .tools/e1-runs.json .tools/new-e1-union.json
```

Для merge `e1-runs.json` — array объектов `{ "directory": ".tools/run", "manifestSha256": "..." }`. Каждый входной run проверяется с тем же config, планом, SHA и replay receipts. Повторное объединение тех же refs byte-identical; новые пути output обязательны. До10 supplied runs,20 receipts/run,200 receipts/union, response8MiB, output32MiB; inventory5000 maps не усекать — при превышении сохранить IDs и partial/INVENTORY_LIMIT либо явно остановить output по size limit. Не добавлять raw payload в stdout/errors.

E1 начинает с `/proMatches`, затем продолжает `less_than_match_id` с точным минимальным decimal ID. Проверяется продвижение cursor; ID strings сохраняют BIGINT precision. Далее читаются списки всех обнаруженных потенциально целевых лиг. При превышении league budget нельзя молча взять первые удобные лиги: сохраняются pro pages и `LEAGUE_LIMIT`, league requests не выполняются. V1 читает только main-event IDs плана. До начала всех windows — `not_started`, HTTP0/DB0. Лимиты — budget одного discovery запуска, не изменение frozen evaluation sample policy; неполный запуск никогда не доказывает охват holdout. Справочник pagination — [официальный OpenDota OpenAPI](https://api.opendota.com/api).

Новый каталог создаётся exclusive; каждый successful/failed receipt записывается `wx` **до следующего запроса**. Затем manifest содержит request SHA, receipt file SHA, code manifest и projected ledger. Ошибка диска прекращает работу; сохранённые receipts остаются, отсутствие manifest означает незавершённый run, его нельзя считать verified complete. `verify` работает offline с недоступной DATABASE_URL, проверяет исходные file/payload SHA, sequence/clocks, полный replay projected ledger и обязательный порядок запросов. Пропущенная ожидаемая страница/лига или лишний unmanifested receipt дают отказ. Сохранённые code hashes описывают версию capture, не доказательство неизменности локального исполняемого кода навсегда. Проверка SHA — контроль целостности, не внешний timestamp attestation.

Ledger сохраняет **каждый** возвращённый numeric match ID: `pending_detail_verification`, `scope_uncertain`, `metadata_conflict`, `outside_scope`, `related_series_member`. Повторы одного ID не увеличивают unique N, но все observations/receipts и конфликтующие metadata варианты остаются. Unknown start/league/series/team и противоречивый league ID целевого endpoint не исчезают из potential target inventory. Известные siblings целевых серий вне окна сохраняются. Conflict не разрешается «последним ответом». Pro status/OutcomeVerifier/10 identities ещё не проверялись: target candidate не равен eligible map или training example. После evaluation snapshot run отмечается partial/AFTER_EVALUATION_SNAPSHOT и требует отдельного correction/revision handling.

Union объединяет **все переданные** runs, сохраняет старые observations/failures/conflicts и provenance; не меняет старые файлы. История ограничена явно переданным списком: глобального transaction registry всех запусков и запрета владельцу не передать какой-то run пока нет. Partial из старого запуска остаётся видимым даже после успешной повторной загрузки; detail reconciliation должен различать историю ошибок и текущее разрешение кандидатов. Новые limits/config не объединяются молча с другими config SHA. Merge не является оценкой quality gate или разрешением неограниченно отбирать удобные runs.

**Реальная проверка2026-11-02:** V1 not_started, HTTP0. Первый E1 run — source prerequisite failure до HTTP: существующий локальный PG cluster был остановлен. Запущен прежний `.tools/pgdata` по инструкции S0-00, без init/reset; SELECT1 затем PASS. Новый E1 run через named client:3 HTTP200 (2 pro pages +1 league response),676 строк/622 unique maps,1 possible target/pending detail. Budget2 pages дал partial/PRO_PAGE_LIMIT; remote completeness unknown. Первый failure сохранён отдельным receipt/run. Union двух E1 runs622 unique,3 responses/1 historical failure; повторный union byte-identical SHA`64cec39d6f2c6e866415f4d193bea45644a95b2b1039d811822d8991864da415`. [Публичный manifest/replay без raw outcomes](evidence/s3-01-evaluation-discovery.json). Ни одна карта этим collector не импортирована/проверена как target; metrics=null, deployable=false.

**Следующий на тот момент срез** — bounded detail capture/import и current reconciliation — реализован ниже. Обязательная связь ledger с `research:execute` добавлена в разделе binding в конце документа. Shared V1 builder/candidate и production activation остаются следующими этапами; код можно готовить до конца test windows.

## Detail capture/import и сверка покрытия — 2026-11-02

Добавлены `evaluation-details` contracts/ingestion и CLI `pnpm evaluation:details capture|verify|import|reconcile|verify-reconciliation`. Общие bounded file/SHA/plan/discovery replay helpers вынесены в `scripts/lib/evaluation-discovery-files.mjs`; прежняя discovery CLI использует те же проверки. Перед detail операцией заново проверяются config, pinned plan и **весь supplied-run union** с его raw receipts/query trace. Самосогласованного редактирования summary/union fingerprint недостаточно.

Одна batch содержит до50 ID: все possible targets и известные related-series members из union сортируются по numeric match ID, batchIndex0..99. Порядок не зависит от победителя или полноты карты. Все отложенные ID сохраняются в assessment, а reconciliation по-прежнему содержит все observed targets в coverage denominator. Один capture не является сборкой нескольких detail batches: absent-in-this-batch помечается отдельно даже при существовании другого capture. Перед итоговой оценкой потребуется явное объединение batch evidence/coverage, не молчаливый пропуск таких IDs. При inventory>5000 — отказ без усечения.

Для batch0 живого E1 checkpoint:

```powershell
$e1UnionSha = '64cec39d6f2c6e866415f4d193bea45644a95b2b1039d811822d8991864da415'
pnpm evaluation:details capture .tools/evaluation-discovery-e1.json .tools/evaluation-discovery-e1-union.json $e1UnionSha 0 .tools/new-e1-details
pnpm evaluation:details verify .tools/evaluation-discovery-e1.json .tools/evaluation-discovery-e1-union.json $e1UnionSha .tools/new-e1-details <CAPTURE_MANIFEST_SHA>
pnpm evaluation:details import .tools/evaluation-discovery-e1.json .tools/evaluation-discovery-e1-union.json $e1UnionSha .tools/new-e1-details <CAPTURE_MANIFEST_SHA> .tools/new-e1-import-log
pnpm evaluation:details reconcile .tools/evaluation-discovery-e1.json .tools/evaluation-discovery-e1-union.json $e1UnionSha .tools/new-e1-details <CAPTURE_MANIFEST_SHA> .tools/new-reconciliation.json
pnpm evaluation:details verify-reconciliation .tools/evaluation-discovery-e1.json .tools/evaluation-discovery-e1-union.json $e1UnionSha .tools/new-reconciliation.json <REPORT_SHA> .tools/new-e1-details
```

`capture` получает `/heroes`, `/leagues`, затем все selected `/matches/{id}` через named client/durable quota. Каждый success/failure receipt сохраняется exclusive до следующего запроса; запросы не идут внутри транзакции импорта. Полный capture manifest включает file/code hashes, real fetched/started/completed clocks, fixed selection и source-only assessment. Пустая batch работает без сети/БД. Verify проверяет точный состав/порядок receipts, raw payload SHA, source endpoint/ID и clocks, затем повторяет assessment. Неизвестная reference/pro классификация, incomplete outcome, несовпадение discovery/detail, неполные/дублирующиеся numeric accounts, snapshot violation получают явные причины. Source eligibility ещё не доказывает canonical identity/series или готовность модели. Исходные ответы могут содержать персональные replay-поля и остаются локальными; stdout/public evidence не копируют raw payload/ключи.

`import` повторяет те же сохранённые bytes через существующий `IngestionService` без новых HTTP: source clocks/knownAt=null сохраняются, применяются прежние source/pro/duplicate/conflict правила. Для каждого selected ID сразу записывается отдельный import result. Класс importer может частично сохранить source receipt до последующей ошибки, поэтому любой exception в попытке импорта требует проверки журнала/БД; ошибка сохранения отчёта не означает rollback уже совершённых writes. Запуск в новый каталог, повторный импорт идемпотентен. Автоматического создания player identities/series aliases по nickname или только совпадению названия нет; дальнейшее reviewed provisioning отдельное.

`reconcile` делает новый SELECT-only `V1DataRepository` snapshot с текущим реальным временем и зарегистрированным warmupFromAt, затем сверяет **каждый** target/related ID с verified canonical outcome, сохранённым detail payload SHA, native actual slots, current same-account identities и series evidence. Используется V1-data profile без patch/roles veto, whole-local-series guards. Missing detail/import/identity/series/receipt mismatch и unresolved discovery остаются причинами, verified outcome учитывается отдельно от data-ready. Известные canonical siblings вне target windows и отсутствующие observed siblings исключают серию целиком. Если discovery series неизвестна, canonical link используется для группировки; противоречивые observed/canonical keys проверяются обе, чтобы неполная серия не стала готовой из-за отсутствующего ключа. Исходный discovery union не переписывается.

Report содержит данные snapshot/fingerprints, assessments, observed-target/known-series denominators, ready counts, nullable coverage и отдельно count verified outcomes. При N=0 coverage=null. Snapshot — **current data-readiness diagnostics**, не фиксированный E1 evaluation snapshot или release quality gate; E1 overlap/split/time guards остаются отдельными. В frozen reconciliation envelope хранятся dataset evidence и ledger/capture fingerprints; `verify-reconciliation` воспроизводит отчёт offline без подключения к БД. Late/future outcome не становится исторически доступным признаком; никакого scoring/training/activation здесь нет.

**Реальный checkpoint:** одна E1 карта9072857576/league19944. Detail capture3 HTTP200, source shape/pro/completed outcome/10 numeric accounts подтверждены. До импорта coverage0/1 по причине missing map. После standard import —233 карты/2330 slots, canonical outcome verified1/1, но data-ready **0/1**: canonical player links4/10, canonical series null. Остаются6 accounts/series1163385 для reviewed linking; patch/roles не причины отказа. Повтор тех же bytes дал duplicate=true/dataRevision1/providerRequests0; все21 отслеживаемые table fingerprints до/после повтора идентичны. Первый import добавил1 map/10 slots/2 source receipts/1 assessment/22 fact observations; dataset/model versions0. [Evidence capture/import/reconciliation](evidence/s3-01-evaluation-details.json). Исходы/lineup факты получены после начала; knownAt не backdate-ится.

Обязательный bounded live source audit `scripts/audit-prediction-sources.mjs --league 19944 --sample 1` выполнен до импорта:3 HTTP200, confirmed pro/completed/10 source accounts1/1. Его uniform-rank sample8905035315 — **другая историческая карта**, не доказательство identity coverage целевой карты и не representative benchmark. Target candidate дополнительно проверен из собственного captured detail. Старые E0/E1/V1-data/release-plan artifacts сохранены; оценка accuracy не запускалась.

[Финальная verification/code revision](evidence/s3-01-evaluation-details-verification.json) сохраняет отдельное подтверждение исправлений whole-series guards и воспроизведения прежнего реального report под финальным кодом. Первоначальные capture/report/source evidence не перезаписаны.

## Reviewed identity/series links — checkpoint2026-11-02

Шесть недостающих account IDs найдены по точному числовому ключу в ранее сохранённом `/proPlayers`:122817493,140251702,206097366,262476000,331711578,879017980. Проверены SHA capture/raw payload, единственность каждой строки и `Steam64 = account_id + 76561197960265728`. `prepareCurrentAccounts` и `IdentityProvisioner.preview` дали ready без конфликтов; apply создал6 отдельных игроков,6 account proofs и6 aliases. Никнеймы — только подписи, cross-account merges не выполнялись. Source fetched/knownAt остаётся2026-11-01T15:50:43.622Z; это current identity evidence, не доказательство заранее известного состава.

`SeriesProvisionRepository.preview` подтвердил series1163385, league19944, пару provider teams10291652/10149530, согласованный source series_type1→BO3 и verified map outcome. Применён существующий `reviewed-opendota-series-v3` без изменения policy; remote membership completeness unknown, status/scheduledAt не придуманы. По одному локальному матчу нельзя утверждать, что вся BO3 завершена или все её карты загружены.

Штатный повторный `evaluation:details import` исходного capture без HTTP обновил карту9072857576:10/10 canonical players, series reference, dataRevision1→2. Все map/player facts сохранены; прежние232 карты остались неизменными. Рабочий корпус233 maps/2330 slots/203 players и account proofs/123 series; identity revision406. Повтор identity/series apply вернул already_applied, повтор import — duplicate=true/receipt1597/revision2. Все21 table fingerprints после первого и повторного проходов равны. Series replay возвращает сохранённый initial result с `created:1`, а не счётчик новых insert; отсутствие новых записей проверено по БД.

Новый immutable reconciliation `.tools/evaluation-links-reconciliation.json` (SHA `72d7c820608167ab39f04e9c76df15055b6229076002829cae62c0c5c49afcfb`) воспроизведён offline: verified outcome1/1, data-ready1/1, known-series coverage1/1, reasons пусты. Это **current readiness одного обнаруженного кандидата**, discovery остаётся partial, metrics/probability null и deployable false. Архивный report с0/1 и остальные frozen snapshots не переписывались. [Manifest с SHA входов/планов/снимков/replay](evidence/s3-01-evaluation-links.json).

Команды использовали существующие CLI (каждый output — новый путь):

```powershell
node --env-file-if-exists=.env scripts/provision-current-accounts.mjs preview .tools/s1-21-current-capture.json .tools/evaluation-links-selection.json .tools/evaluation-links-identity-plan.json
node --env-file-if-exists=.env scripts/provision-current-accounts.mjs apply .tools/s1-21-current-capture.json .tools/evaluation-links-selection.json .tools/evaluation-links-identity-plan.json 72f6dae86b6e4b09b36757f80d9ff0d0d847fb4b2e32ff0d2af0c3795a501ceb .tools/evaluation-links-identities-applied.json
node --env-file-if-exists=.env scripts/provision-series.mjs preview .tools/evaluation-links-series-request.json .tools/evaluation-links-series-plan.json
node --env-file-if-exists=.env scripts/provision-series.mjs apply .tools/evaluation-links-series-request.json c10fc3078bc49642964aa8353ae96a5256c98ff342fa6d9750694a66cb3c1c2e .tools/evaluation-links-series-applied.json
node scripts/evaluation-details.mjs verify-reconciliation .tools/evaluation-discovery-e1.json .tools/evaluation-discovery-e1-union.json 64cec39d6f2c6e866415f4d193bea45644a95b2b1039d811822d8991864da415 .tools/evaluation-links-reconciliation.json 72d7c820608167ab39f04e9c76df15055b6229076002829cae62c0c5c49afcfb .tools/evaluation-details-e1-20261102
```

Следующий на момент linking срез — candidate/detail evidence binding — реализован ниже. Current reconciliation остаётся диагностикой и не подменяет fixed E1 scoring.

## Обязательная связь источников с E1 capture/evaluate — 2026-11-02

`research:execute evidence` проверяет файлы offline до открытия временного gate и возвращает только количество кандидатов/партий, partial status и null metrics. `capture` требует дополнительно файл evidence и его внешний SHA. Формат:

```json
{
  "configPath": ".tools/evaluation-discovery-e1.json",
  "configSha256": "<SHA256_CONFIG>",
  "unionPath": ".tools/evaluation-discovery-e1-union.json",
  "unionSha256": "<SHA256_UNION>",
  "batches": [
    { "directory": ".tools/evaluation-details-e1-20261102", "manifestSha256": "<SHA256_MANIFEST>" }
  ]
}
```

Config должен ссылаться на тот же pinned E1 plan. Полностью воспроизводятся discovery request trace/receipts/union и каждый detail manifest/receipt/source assessment. Требуются все фиксированные50-ID batches от0 до последнего, ровно один capture на индекс, без дублей и пропусков; для пустого inventory список batches пуст. Failed detail receipt допустим как явно неготовый кандидат. Discovery и detail capture должны завершиться не позже зафиксированного snapshot; более позднее дозаполнение не попадает в эту ревизию E1. При новом union старые batches с другим discovery fingerprint не принимаются: нужен согласованный набор evidence. Не удалять старые файлы попыток.

Полнота здесь означает **все партии явно supplied union**, а не все удалённые карты или все когда-либо выполненные запросы. Система пока не имеет глобального реестра запусков. Partial discovery, stopping reasons и `remoteCompleteness: unknown` сохраняются в binding и отчёте. Проверка не вводит незарегистрированный порог100% remote coverage и не переименовывает partial в complete.

Перед scoring сопоставляются observed и canonical IDs/start/series/payload SHA. Локальная holdout-карта без discovery также остаётся в знаменателе, но не оценивается. Карта без импорта, с failed detail, конфликтом метаданных или несовпавшим canonical receipt исключается с явной причиной. Каждая неоднозначная observation-series связь и canonical key участвует в распространении исключений по связанным группам; remote outside-window siblings не теряются. Весь локальный inventory, включая warmup и outside siblings, остаётся в исходном snapshot.

Новый `evaluateResearchEloWithExclusions` передаёт дополнительные source-exclusion reasons в существующие series guards **до Elo replay**, не заменяя verified outcome на выдуманный unavailable label и не удаляя строки из frozen snapshot. Default `evaluateResearchElo` сохраняет прежний результат; формула1500/K32/400, event-time availability, whole-series splits и conservative overlap exclusions E0/E1 не менялись. Report содержит итоговые причины старого evaluator и evidence binding, scored/observed maps и known-series coverage; N=0 даёт null. Если evaluation unavailable, scored coverage0 и metrics null. Вероятности отдельных карт не публикуются.

`evaluate` требует внешний SHA capture, заново проверяет referenced source files и затем обращается к обязательному PostgreSQL-журналу. Новый расчёт выполняется под блокировкой плана, результат публикуется после commit; точный повтор возвращает сохранённую запись. Сохранить raw source files обязательно для независимого replay; одного capture недостаточно. Уже записанные report/capture можно восстановить из БД без внешних source files и без scoring. Source/plan/capture SHA защищает целостность локальных bytes, не является криптографическим подтверждением провайдера. Ревизия на том же holdout не считается новым независимым тестом.

Реальный checkpoint: `.tools/research-evidence-e1-files.json` SHA `d5214273c678ae8b97eebb06439950384440ecd2199499bf50e5dec0dee6c6d0` проверяет1 target/1 batch, discovery partial. Ранний capture отклонён `EXECUTION_TOO_EARLY`, выходной файл отсутствует, HTTP/DB scoring0. Архивная E0 evaluation воспроизведена точно; это не новый E1 score. [Evidence](evidence/s3-01-research-evidence-binding.json).

## Журнал первого сохранённого результата и ревизий — 2026-11-02

Миграция023 добавляет `research_evaluation_journal`;001–022 не меняются. Scope — fingerprint зарегистрированного плана, а pinned file SHA дополнительно проверяется на неизменность. Таблица хранит точные UTF-8 bytes capture/report, их SHA, fingerprint плана, SHA scorer manifest, номер/родителя/причину ревизии и время БД. Report обёрнут в `journalled-research-report-v1` с `journal` и прежним `report`; это служебный журнал исследования, отдельный от будущего V1 forecast journal.

`evaluate` теперь требует доступную PostgreSQL и применённую023. Под advisory transaction lock плана выполняются проверка последней ревизии, scoring и append. Метрики/файл не публикуются до commit. Первый сохранённый результат получает revision1 — включая осмысленный `status: unavailable` с недостаточным N. Техническое исключение/ошибка insert откатывает транзакцию и не оставляет результата; это не журнал всех упавших процессов и не утверждение, что вычисление никогда не начиналось. После commit файл может не записаться: БД остаётся источником восстановления. При неопределённом результате commit CLI предлагает проверить журнал и повторить те же входы.

Одинаковые capture bytes + scorer manifest SHA в том же плане возвращают исходную запись `already_recorded` без повторного scorer. Это работает и после появления более новых ревизий: старый input восстанавливает свою запись. Изменение raw capture bytes или кода требует `revise`, даже если логические значения совпадают. Нельзя создать fork от устаревшего родителя; сравниваются номер **и SHA последнего экспортируемого отчёта**. Повтор revision должен сохранить parent и reason. SQL unique/FK/checks и triggers запрещают изменение/удаление/TRUNCATE и разрыв цепочки. Одновременные одинаковые первые запросы дают один расчёт/запись; из двух разных детей одного parent принимается один.

Файл запроса ревизии имеет внешний SHA и следующий формат:

```json
{
  "parentRevision": 1,
  "parentReportSha256": "<SHA256_JOURNALLED_REPORT>",
  "reason": "Описание исправленных данных или кода"
}
```

```powershell
pnpm db:migrate
pnpm research:execute evaluate docs/evidence/s3-01-e1-plan.json $e1PlanSha .tools/s3-01-e0-export.json docs/evidence/s3-01-league-discovery.json .tools/e1-capture.json <CAPTURE_SHA256> .tools/e1-report.json
pnpm research:execute revise docs/evidence/s3-01-e1-plan.json $e1PlanSha .tools/s3-01-e0-export.json docs/evidence/s3-01-league-discovery.json .tools/e1-corrected-capture.json <CAPTURE_SHA256> .tools/e1-revision-request.json <REVISION_SHA256> .tools/e1-revision-report.json
pnpm research:journal list 7311d2494b0272ae987577873747778b3c665432ad3031859e864be66addde4f
pnpm research:journal export 7311d2494b0272ae987577873747778b3c665432ad3031859e864be66addde4f 1 .tools/e1-restored-report.json
pnpm research:journal export-capture 7311d2494b0272ae987577873747778b3c665432ad3031859e864be66addde4f 1 .tools/e1-restored-capture.json
```

Восстановление проверяет SHA и привязку сохранённых bytes; все output paths новые. `list` возвращает metadata максимум1000 revisions, не обрезает длинную историю молча. `check/evidence` по-прежнему offline. Guard CLI и дополнительная проверка часов PostgreSQL запрещают ранний scoring; никакой revision не меняет окна fixed snapshot и не превращается в независимую проверку или production candidate.

Реально применена023, журнал E1 пуст, прежние21 table fingerprints и E0 evaluation сохранены. Ранние `evaluate/revise` отклонены до DB connection/source capture read, выходных файлов нет. [Evidence](evidence/s3-01-research-journal.json). Успешное scoring/revision/export проверено только в isolated synthetic PostgreSQL tests, не на реальном будущем holdout.

**S3-02/V1-features уже выполнен:** [общий deterministic player-mean Elo builder](S3_02_V1_FEATURES.md), ранее завершённые verified pro maps, cutoff строго `<`, expected/manual5v5, без patch/role/hero зависимостей. Следующий независимый срез — S3-03/V1-candidate: inactive artifact и release evaluator. Это разрешённая V1-планом подготовка feature code до окончания test windows; S3-01/V1-evaluation остаётся открытой до реальных оценок. E1 scoring не раньше10.11 03:00 МСК, release gate и прогнозы не активированы.

S1-07 и strict P0 S3-01 остаются открытыми. Следующая модель для source/import/identity интеграции — GPT-6.1 Sol · High; temporal evaluation требует GPT-6 Astra · Extra High.
