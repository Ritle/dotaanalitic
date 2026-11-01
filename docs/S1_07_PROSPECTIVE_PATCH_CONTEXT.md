# S1-07 — контракт подготовки patch context до будущей карты

**Статус:** реализован ограниченный preparation contract `prospective-patch-preparation-v1`, 2026-11-01. Это продолжение [решения об интервалах](S1_07_PATCH_INTERVAL_DECISION.md). Контракт не подключён к API, UI, DatasetBuilder или PredictionService и не заменяет исторический resolver. Обязательные prediction gates не изменены. Использование условной версии моделью требует отдельного согласования semantics и независимой оценки качества; данный срез такого разрешения не даёт.

## Назначение

Нужно сохранить два разных утверждения: «источник наблюдал активную версию до cutoff» и «владелец явно предполагает ту же версию для будущей карты». Ни одно из них не устанавливает фактический patch_id карты. У подготовленного результата `actualMapPatchLabel=null`, prediction unavailable, probability=null, `trainingReady=false`, `deployable=false` при любом исходе проверки.

Новый boundary: [Zod contracts](../packages/contracts/src/prospective-patch.ts) и [pure preparation](../packages/db/src/prospective-patch.ts). Функция `prepareProspectivePatchContext(input: unknown)` экспортирована из `@dota/db`, не выполняет SQL/HTTP, не читает environment и не принимает модель или исход карты. Решение scope-safe: источник версии известен сейчас, будущая применимость остаётся условием, исторические release/coverage/knownAt не переписываются.

## Вход и доверие

`request` содержит cutoffAt; target с kind=`single_map_scenario`, scenarioId/revision, nullable leagueId и scheduledMapAt; явное assumption=`none|same_as_observed`; freshness policyRevision/maxAgeSeconds. Плановое время, если задано, строго позже cutoff. Это предполагаемое время одной карты, не подтверждённый started_at и не автоматически перенесённая дата BO3. Unknown time допустим для наблюдения, но блокирует условие для будущей карты. Все IDs — decimal strings в диапазоне PostgreSQL BIGINT; время — UTC с миллисекундами.

`evidence` — до 2000 записей с immutable ID, patchLabel, scope=`game|league(leagueId)`, eventAt/knownAt/fetchedAt/recordedAt/reviewedAt, source/evidenceRef/payloadSha256 и reviewState. Допустимые виды:

| kind | Значение | Может дать observed version |
|---|---|---|
| `active_version` | Проверенное утверждение о действующей версии в eventAt в указанной области | Да, только accepted, своевременно и достаточно свежо |
| `publication` | Публикация заметок/новости о версии | Нет, даже если запись accepted |
| `announced_transition` | Проверенное объявление перехода с nullable effectiveAt | Нет; может блокировать условие будущей карты |

**Функция принимает уже рассмотренные утверждения из внутреннего доверенного boundary.** Zod и SHA не проверяют истинность источника, source string не является allowlist. Нет публичного endpoint, который разрешает владельцу или провайдеру прислать `accepted active_version`. Перед подключением реального reader нужен отдельный проверенный decoder/source acceptance policy: явное подтверждение активности, точной версии и scope; публикация/вычисляемый provider code автоматически не повышаются. В этом срезе такого источника и reader нет; все новые test proofs синтетические.

## Временные правила и принятие решения

Для этого prospective cohort требуется:

```text
eventAt <= knownAt <= fetchedAt <= recordedAt <= reviewedAt <= cutoffAt
```

eventAt — время наблюдения активной версии либо события публикации утверждения; у transition future effectiveAt — отдельное поле. knownAt — доступность именно этого утверждения; recordedAt/reviewedAt в будущей persistence должны назначаться сервером. Все времена поступают явно; функция не подставляет now и не создаёт раннее знание. Неправильный порядок clocks отвергается Zod.

Для воспроизведения локально принятого решения proof, впервые полученный/записанный/рассмотренный позже cutoff, исключается полностью. Поздний архивный fetch с ранним source knownAt тоже не проходит этот cohort. Это намеренно более узкая политика, чем исторический resolver; архивная реконструкция остаётся отдельным режимом. Корректно сформированная поздняя запись не меняет результат и fingerprint даже при совпадении её ID с ранней записью. Некорректный вход отвергается целиком до resolution.

Из доступных к cutoff записей учитывается game scope и только точное совпадение leagueId; неизвестная лига не выводится из источника. Одинаковые IDs с одинаковым содержимым дедуплицируются. Разное видимое содержимое одного immutable ID — ошибка `prospective_patch_evidence_id_conflict`; последнее значение не побеждает.

Для active_version принимаются accepted/conflict записи, возраст которых по eventAt не превышает explicit maxAgeSeconds на cutoff; равенство допустимо. У freshness нет значения по умолчанию; предел 1 год — техническая граница входа, не рекомендуемый срок или утверждение о качестве. TTL не доказывает непрерывность версии и не продлевает evidence до времени будущей карты. Никакой автоматической настройки TTL по выигрышам/проигрышам.

| Доступные active proofs | observed.status | observed.patchLabel |
|---|---|---|
| Нет рассмотренных active proofs | unknown | null |
| Рассмотренные proofs есть, но все устарели | stale | null |
| Свежие записи разных версий либо есть свежий explicit conflict | conflict | null |
| Свежие accepted записи согласны | observed | Наблюдённый label |

Сравниваются все свежие applicable proofs. Новая запись не отменяет противоречащую свежую запись другого источника; у league нет неявного приоритета над game. Это консервативная подготовка, без реализации supersession/review UI. `observed` означает наличие наблюдения до cutoff, не гарантированную текущую или будущую применимость. Исходные eventAt сохраняются в evidence.

## Условие сценария и изменения патча

При assumption=none результат condition=`not_requested`, label=null. При явном same_as_observed:

- Неизвестная/stale/conflict версия → `OBSERVED_PATCH_UNAVAILABLE`.
- Нет планового времени именно карты → `MAP_TIME_UNKNOWN`.
- Рассмотренное объявление перехода с неизвестным effectiveAt либо с effectiveAt от самого раннего из свежих наблюдений до scheduledMapAt включительно → `PATCH_TRANSITION_BEFORE_MAP`.
- Иначе condition=`conditional`, label равен observed; это сохранённая гипотеза, не verified future patch.

Прошедший переход строго раньше всех свежих active observations не ограничивает их будущий горизонт. На равной границе переход блокирует условие. Переход после scheduledMapAt не блокирует условие этой даты, но при переносе карты решение рассчитывается заново. Unverified/rejected объявления не становятся authoritative facts. Отсутствие объявлений **не доказывает**, что изменений не будет; поэтому успешное условие всё равно conditional. Повторный capture или новая actual-version запись после карты никогда не меняют старый объект автоматически.

## Снимок и совместимость

Возвращается schemaVersion/policyVersion, нормализованный request и только видимые applicable evidence, observed/condition, nullable actual patch и постоянно закрытые prediction/training flags. Evidence отсортированы по numeric BIGINT ID; fingerprint — SHA-256 JSON всего результата без самого fingerprint. Порядок входного массива и точные дубликаты не меняют hash. Изменение scenario revision/времени карты/freshness policy/evidence меняет snapshot. Входные объекты не мутируются и не используются как ссылки в результате.

Это самодостаточный **in-memory** снимок с fingerprint, не гарантия неизменяемого хранения: API/SQL persistence не добавлены, объект не заморожен через Object.freeze. Будущая persistence должна быть append-only и проверять hash; correction/actual version сохраняются отдельно от подготовленного контекста и prediction. Нельзя заявлять, что запись в БД уже реализована.

`resolvePatchAt`, PatchReleaseEvidenceSchema, SQL001–022, исторические weights и DatasetBuilder остаются без изменений. Проверка `coverageUntil <= fetchedAt` не снята. Старые queries/responses и migration history совместимы. Нет автоматической конвертации нового label в `matches.patch_id`, hero eligibility/impact или model feature.

## Проверки и остающиеся gates

[20 новых pure tests](../packages/db/tests/prospective-patch.test.ts): future conditional без actual patch/probability; совместимость historical half-open coverage; explicit opt-in; empty/publication/notice-only; unverified/rejected; все clocks; поздняя correction с тем же ID; freshness; конфликт и scope; переходы, границы и unknown time; перенос даты; ID dedupe/invalid BIGINT/precision; неизменность input/output; стабильный и policy-sensitive fingerprint. Fixtures помечены synthetic и в БД не записываются.

Перед реализацией targeted run завершился ошибкой отсутствующего модуля (tests не выполнились); это не свидетельство failing assertion или исправления production regression. После реализации первый запуск дал 18 новых +18 existing game-context tests PASS; затем добавлены ещё два boundary/fingerprint tests для итогового full run. Итоговые обязательные проверки зафиксированы в PROGRESS.

Итог: frozen install/typecheck/**481 unit**/build PASS, verifier22 ordered migrations/golden checks и docs links/diff check PASS. Compiled public export smoke на пустом synthetic input: observed=unknown, condition=not_requested, prediction=unavailable. Логи `.tools/s1-07-prospective-{install,typecheck,test,build,focused,red}.log`. DB integration/browser/Python/backtest не запускались: изменения ограничены pure contracts/preparation; БД и работающие сервисы не затрагивались.

Настоящие active-version proofs не получены. Ранее сохранённые 16 карт по-прежнему patch unknown; последний corpus preview36/0 strict eligible не пересчитывался. S1-07, source/corpus/lineup/hero gates, temporal backtest/calibration и публикация вероятностей остаются открытыми. Подготовка этого контракта не меняет их.

**Следующий шаг S1-07:** bounded review одного источника активной версии для будущего наблюдения: установить поле/утверждение активности, точную версию, применимый scope и clocks, подготовить конкретное правило decoder/review и пример source-bound input. Не повторять coarse-code60 или publication timestamp audit. Если источник предоставляет только публикацию, явно оставить kind=publication; не создавать collector/SQL на выдуманных гарантиях. Модель: GPT-6 Astra · High для source semantics; после принятия источника узкую интеграцию можно выполнять на Sol · High.

Продолжение2026-11-01: [Valve IGCVersion source review](S1_07_ACTIVE_VERSION_SOURCE.md) подтвердил числовое active_version6969 в client/server responses, но не связь с balance patch label. Сохранён source-bound numeric observation; prospectivePatchEvidence остаётся пустым. Source field active_version и reviewed evidence kind active_version имеют разный scope; их нельзя соединить по совпадению названия.
