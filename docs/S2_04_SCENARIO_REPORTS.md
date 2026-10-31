# S2-04 — отчёт сценария и история версий

Отчёт объединяет существующие описательные readers: организации/H2H, ручные и ожидаемые пятёрки, историю игроков на роли/герое, meta выбранных героев, союзные пары и directed matchup matrix. Он сохраняет полный ввод сценария, результат, effective filters, источники и качество данных. S1-07 остаётся открытой; prediction status=`unavailable`, model и вероятность=null. Snapshot отчёта не является training example или доказательством исторической доступности ростера.

## API

- `POST /api/v1/scenarios/:id/analyses`: strict `{expectedRevision,fromAt?,patchScope?:'all'|'current'|'specific',patchId?,leagueId?,weights?}`. Сохранённый сценарий задаёт cutoff,5+5, роли, героев, контекст и optional expected five. Ответ201 — `{id,version,createdAt,resultHash,report}`. Это bounded synchronous calculation; прежний planned202 job/polling не требуется этому срезу.
- `GET /api/v1/analyses/:id`: неизменяемый полный снимок; SHA-256 проверяется при чтении. Чужой/отсутствующий ID и legacy unversioned job дают404.
- `GET /api/v1/scenarios/:id/analyses?offset=0`: до20 summary rows, descending version, `hasMore`, offset0..10000. Каждая строка содержит version, scenarioRevision, dates, status, policyVersion и resultHash.

Все маршруты требуют owner session/no-store; POST также Origin/CSRF. Неправильные IDs/период/patch selection —400, stale expectedRevision —409. Неизвестный current patch и >5000 target candidates дают200 с явным `unavailable` и не создают analysis row/version. У допустимой пустой выборки raw N=0/WR=null и сохраняется отчёт с соответствующими состояниями разделов. Client не передаёт готовые inputs/results, timestamps, version, source или model.

## Согласованность и сохранение

Одна PostgreSQL repeatable-read transaction читает saved input, глобальный target inventory, раннюю reference history, registry/account evidence и chronology Elo. Сценарий блокируется FOR UPDATE. Все описательные разделы используют один snapshotAt, effective cutoff=min(saved cutoff,server now) и period default90 дней; будущий cutoff явно ограничивается. SQL обеспечивает строгое начало карты до cutoff и завершение не позже cutoff с микросекундной точностью.

Additive017 расширяет существующие `analysis_runs`: scenario_revision FK к immutable input snapshot, report_version, result_hash; `scenarios.report_version_counter` выделяет версии атомарно. Counter не меняет scenario.revision/updated_at. Concurrent repeatable-read serialization failures40001 повторяются целой транзакцией до5 раз; исчерпание даёт409 без частично записанного результата. Сохранение сценария с новой revision также сериализуется этим row lock.

Report сразу вставляется terminal `done`. DB trigger запрещает UPDATE/DELETE versioned rows и upgrade legacy job в versioned row; insert сверяет input JSON/hash/scenario/revision/policy с frozen scenario snapshot. created_at задаётся сервером БД. Старые pending/running legacy jobs сохраняют прежний lifecycle, не backfill-ятся и не отображаются в новой истории. SQL001–016 неизменны. Ошибка расчёта/проверки откатывает report и counter вместе.

`resultHash` — SHA-256 canonical JSON полного сохранённого результата. `data_revision` — fingerprint source provenance: target map revisions, identity/registry revisions/fingerprint, fingerprints **ранней reference и полной strength history**. Исправление только reference-карты меняет source revision, даже когда raw target WR прежний. Новые сведения/фильтры/сценарий создают новую запись; GET старого отчёта ничего не пересчитывает. Эти hashes связывают сохранённое содержимое/inputs, не подтверждают истинность непроверенных provider facts.

## Семантика разделов и качество

- Организационный WR, выбранная пятёрка через любые организации, пятёрка в конкретной организации, H2H и native sides раздельны. Expected baseline передаётся существующему roster reader; без неё нет roster-change delta/штрафа.
- У каждого из10 игроков зафиксированы ручная роль, canonical ID и optional assigned hero. Existing player×hero reader применяет только **подтверждённую историческую совпадающую роль**; при явном scenario Radiant slot — соответствующий native side filter. При unknown side фильтра нет. Отсутствующий герой означает видимый режим «все герои», не выдуманный pick. KDA/GPM/XPM имеют независимые N; missing !=0.
- Meta ограничена назначенными героями, глобальными завершёнными pro-картами и effective period/patch/league. Raw WR использует валидное наблюдение героя даже в partial map. Pick share использует **только полные10 distinct native hero maps**: knownDraftPicks/completeDraftMaps. При нулевом знаменателе rate=null. Неизвестный герой в partial draft не превращается в наблюдение отсутствия; история банов не оценивается. Патчи определяются existing verified timestamp registry.
- Hero pairs используют S2-03 raw/prior/explicit candidate weights без изменения counting/availability rules. Это история героев независимо от игроков. Личные сглаженные частоты используют свою раннюю роль/герой/патч выборку; N prior отдельно. Weighted rate/N_eff остаются null при неизвестном весе; production coefficients не подставляются.
- Elo audit использует собственный last20/no-patch-league cohort и глобальную раннюю chronological history. UI раскрывает различие. Это экспериментальный аудит силы соперников, не новый скорректированный WR и не win probability.
- Roster source остаётся `owner_assertion`; recordedAt не доказывает pre-map announcement/participation. Сохранённая draft assessment показана именно на момент сохранения ввода. Unknown side/first pick/patch/league/metrics сохраняются nullable.

Target inventory имеет5000 global candidates до pro/patch/league filters; overflow требует сузить период, без target-only truncation. Ранняя reference history и strength history также независимо bounded5000. Их overflow отключает соответствующие adjusted sections, сохраняя raw target metrics. Coverage содержит кандидатов/завершённые pro, неизвестные патчи до patch-filter, серии, partial heroes, sourceFetchUnknown и lateFetched. У каждого reader остаются собственные знаменатели и подробные provenance.

## Интерфейс

`/scenarios/:id/report` открывается из сохранённого сценария. Форма создаёт новую версию с текущей expectedRevision. По умолчанию weights выключены; если выбранная версия содержит явную candidate policy, её можно повторно использовать. Самостоятельный numeric policy editor остаётся в S2-03 Draft Lab; API отчёта принимает такую же строгую explicit policy. Это диагностический эксперимент без утверждённых коэффициентов.

История переключает immutable report ID через `?analysis=...`. Старый отчёт показывает свою scenario revision/title/lineup/filters; при отличии текущей revision есть сообщение. Изменение формы нового расчёта не меняет сохранённый отчёт. При400/409 сохраняются выбранные фильтры; есть обновление текущей редакции. Vue Query cache immutable snapshots имеет staleTime=Infinity, history/current scenario обновляются отдельно; auth logout очищает cache.

На странице есть raw/adjusted sections, per-metric N, null/empty states, patch distribution, data dates, quality warnings и источник/возраст синхронизации на момент snapshot. Горизонтальные таблицы прокручиваются внутри360px страницы. До100 included pro-карт раскрываются отдельно с источником, start/sync/fetched; для OpenDota есть ссылка на публичную страницу карты. Полный manifest/result JSON сохранён и доступен в details; source unknown не превращается в ссылку на выдуманный provider. Synthetic tests помечены source=synthetic.

## Проверки и дальнейший этап

`pnpm test:reports` — PostgreSQL/API: auth/CSRF/owner boundary, optimistic revision, frozen input, source correction, concurrent version allocation, DB immutability/legacy compatibility, filters/limits, explicit weights, микросекунды, reference-only source revision. Pure analytics tests проверяют partial meta denominator, native wins, N0/null/unknown patch и duplicate guards. Chromium проверяет create/history/reload, source correction и scenario revision, visible raw/adjusted/coverage/meta, error preservation и desktop/360px. Реальные результаты — [PROGRESS](PROGRESS.md).

S2-05/P1 full draft order и S2-06/P2 draft style остаются открыты. Предлагаемый следующий P0 — S3-00 OutcomeVerifier/DatasetBuilder: подготовка frozen verified-map datasets. Перед ним обязательны PREDICTION_DATA_SPEC/live source audit и существующие availability gates; S1-07 не объявляется завершённой. Отчёты и ручные сценарии не становятся ground truth.
