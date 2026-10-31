# S2-03 — союзные пары и направленные контрматчапы

Отчёт относится к сохранённой редакции драфта одной карты. Он описывает все наблюдавшиеся профессиональные карты с выбранными героями, а не силу назначенных игроков или организаций. S1-07 остаётся открытой: механика весов не подтверждает их эмпирическое качество, `model=null`, `teamAWinProbability=null` при любом результате.

## API и выборка

`POST /api/v1/scenarios/:id/hero-matchups` — read-only, owner-scoped, Origin/CSRF/no-store. Strict body: `{expectedRevision,fromAt?,patchScope?:'all'|'current'|'specific',patchId?,leagueId?,weights?}`. `patchId` обязателен только при specific; ID лиги/патча — bigint-строки существующего каталога. Несовпадение текущей редакции409; чужой/отсутствующий сценарий404; некорректный ввод400. Минимум два назначенных героя, полный драфт необязателен.

Repeatable-read transaction читает scenario input/hash, inventory и registry. Effective cutoff — min(сохранённый cutoff, server snapshotAt), при ограничении будущего времени есть warning. Default fromAt —90 дней до effective cutoff. PostgreSQL сохраняет строгое `fromAt <= started_at < cutoffAt` и проверяет завершение `started_at + duration <= cutoffAt` с собственной микросекундной точностью. Только `is_pro IS TRUE`, без ingest conflict, с boolean outcome и положительной длительностью. Показатели raw — текущая ретроспекция; late fetched сведения не объявляются известными до карты.

Inventory ограничен5000 карт с хотя бы одним выбранным героем **до** фильтров pro/patch/league. Overflow возвращает `unavailable/WINDOW_TOO_LARGE`, без усечённого WR; надо сузить период. `INSUFFICIENT_DRAFT` и `TARGET_PATCH_UNKNOWN` тоже дают явный unavailable. При допустимом окне без подходящих пар status=`insufficient_data`, N=0, raw WR=null. У каждой пары свой N, общий eligibleMaps не является её знаменателем.

Патч определяется только проверенными release/coverage timestamps из registry, не `matches.patch_id` или ближайшей меткой. `all` оставляет неизвестный патч, specific исключает его, current требует известный патч на effective cutoff. Historical league filter независим от лиги гипотетического сценария. `unknownPatchMaps` считается среди завершённых pro-кандидатов перед patch/league фильтром; partial/series/late counters — после него. Candidates включает также исключённые non-pro/unknown/conflict/unfinished карты.

## Правила одной пары

Native слоты0..4 — Radiant,128..132 — Dire; порядок массива и UI A/B стороны не определяют. Валидная строка имеет положительный int32 hero ID и единственный native slot; дубли героя или слота делают соответствующие строки неоднозначными. Отсутствующие аккаунты/канонические личности, роли и другие слоты не исключают достоверную пару. Полный исторический драфт/его timeline для наблюдаемого WR не требуется.

Ally: два разных выбранных героя находились на одной native стороне; unordered пара учитывает карту один раз. Enemy: герой строки A и герой столбца B находились на разных сторонах; победа следует native стороне героя A. Обратное направление инвертирует исход на том же наборе карт. Одинаковая пара в другой организации остаётся наблюдением тех же героев; организационная статистика ей не присваивается. Баны не считаются наблюдениями пар.

## Сглаживание

`pair-reference-beta-v1` использует ранние карты **той же пары** с `started_at < fromAt` и завершением не позже fromAt, тот же проверенный патч и выбранный league filter. N prior — фактический размер опорной выборки; alpha=ранние победы, beta=ранние поражения, оценка `(wins+alpha)/(N+alpha+beta)`. Нет фиксированной массы, выдуманного50/50 или смешивания с weighted N_eff.

Оба исхода должны присутствовать в prior. Серии target-пары и reference-карт требуют проверенных accepted non-conflicting context proofs, одного FK недостаточно. Все известные серии целевого окна и optional scenario series исключены из reference целиком. Неподтверждённая target-серия, неизвестный/смешанный патч, односторонний prior дают unavailable с причиной. При N=0 prior-only допустим только с явно определённым effective patch и подходящей ранней выборкой; raw WR остаётся null. Отдельный reference limit5000 при overflow выключает только сглаживание. Оценка `unvalidated_descriptive`, не вероятность сценария и не calibration claim.

## Экспериментальные веса

По умолчанию `weighted.status='disabled'`. Владелец явно задаёт version, positive halfLifeDays, nonnegative transitionPenalties minor/moderate/major и heroFactors minor/moderate/major/rework в[0,1]; unchanged=1. `validation='unvalidated_candidate'`. UI не подставляет рекомендуемые числа; draft-only контракт не требует неиспользуемых strength coefficients.

Существующий S1-07 resolver применяет time decay, проверенные переходы патчей и impacts только двух героев данной пары. Target league берётся из сохранённого сценария. Source event/known должны соответствовать historical cutoff; fetched должен быть не позже snapshotAt отчёта. Поздняя загрузка может сохранить доказанный ранний knownAt, но не заменить его. Future-fetched registry rows исключаются также из проверки current patch. Missing eligibility/release/transition/impact даёт unknown weight; ни нулевой штраф, ни найденный subset не подставляются вместо неизвестного.

Weighted rate и Kish N_eff доступны только когда каждый raw observation имеет известный вес и есть хотя бы один положительный. Известный нулевой вес допустим и отдельно отражается в nKnown/nPositive. Если хотя бы один вес неизвестен, обе оценки null. Отдельно выводятся target patch, patch cold start, missing counts, per-map weights/reasons/proof IDs и policy/cache key. Это вычислительный кандидат, `deployable:false` на уровне resolver; S1-07 real metadata/backtest gate не закрыт.

## Provenance, интерфейс и совместимость

Report содержит effective filters, scenario revision/input hash, dataUpdatedAt/snapshotAt, source/fetched/synced/data revision для карт, native heroes, patch/series proofs, raw N/patch distribution/sample warnings, ранний manifest и excluded series. SHA-256 fingerprint включает query, input, оба inventory/coverage, candidate data revisions и доступный registry. Cache key весов учитывает snapshot-eligible registry, поэтому будущий fetched proof не сохраняет прежний ключ при смене доступности. Persistent derived cache не создаётся.

На странице сохранённого сценария — отдельная форма, две таблицы союзных пар и направленная матрица до5×5, loading/error/empty states, UTC-фильтры, source details и предупреждения. Числовые поля поддерживают числовые значения native Vue v-model; пустые коэффициенты не превращаются в0. Изменение фильтров скрывает старый результат; unsaved scenario edits скрывают весь компонент, новая revision создаёт новый запрос. Vue Query владеет server cache. На узком экране таблицы прокручиваются внутри страницы, имена имеют минимальную читаемую ширину.

SQL001–016, зависимости и lockfile не меняются. Endpoint не пишет scenarios, snapshots, analyses, training или predictions. Версии полного отчёта и объединение player/roster/hero показателей — следующая S2-04. Production fixtures, source evidence и модели не создаются. Все тестовые карты и коэффициенты явно synthetic.

## Воспроизводимые проверки

`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`; PostgreSQL: `pnpm test:hero-matchups`, регрессии patch-history/scenarios/auth и SQL baseline. `pnpm test:e2e` запускает Chromium с isolated temporary DB; в Windows локальный браузер хранится в `.tools/playwright`. Pure tests проверяют unordered/directed счёт, zero/partial/duplicate/pro/cutoff, ранние серии, mixed/unknown patch, пер-парные impacts, Kish N, all-or-nothing weights и future fetched. API — защита, revisions, immutable history, микросекунды и оба5000 limits; E2E — фильтры, числа, пустое окно, dirty/saved revision и mobile layout. Фактические результаты — [PROGRESS](PROGRESS.md).
