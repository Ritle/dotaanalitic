# S1-04 — игрок × герой × подтверждённая позиция

**Расширение S1-06:** raw selection/metrics этого среза сохранены; sampleEvidence, earlier reference и отдельно помеченные smoothing/prior-only поля добавлены по [контракту S1-06](S1_06_SAMPLE_EVIDENCE.md). Указание ниже «не вводятся» описывает исходную границу S1-04, а не отсутствие более позднего расширения.

Реализован срез метрик FR-04/FR-08: `GET /api/v1/players/:id/heroes` и блок «Герой и позиция» на странице canonical игрока. Только локальная нормализованная БД, owner session, `Cache-Control:no-store`. Запрос не вызывает провайдера и не пишет данные. Это current `retrospective_descriptive`, `policyVersion:player-hero-display-v1`, `model:null`, `predictionEligibility:not_assessed`.

## Выборка

- Strict query: optional `fromAt/cutoffAt` (UTC с миллисекундами), `patchScope=current|all|specific` (default current), `patchId` только для specific и обязателен для него, `heroId`, `rolePos=1..5`, `side=radiant|dire`, `opponentId`, `leagueId`. IDs — decimal strings, включая hero ID в JSON. Unknown fields/malformed input/future or reversed interval — 400; игрок отсутствует в каталоге — 404.
- Cutoff по умолчанию — время запроса; from — 90 дней до cutoff. Явная from меняет период. Выбираются **все** допустимые карты этого окна, без last-N. Более 5000 target candidate maps → `unavailable/WINDOW_TOO_LARGE`; нужно сузить даты.
- Default current — проверенный патч **на дату среза**, по release/coverage evidence и времени карты, без fallback к source patch code. Если патч среза неизвестен, `unavailable/CURRENT_PATCH_UNKNOWN`, без статистики; пользователь явно выбирает all/specific. История другого патча не подмешивается.
- Общий pure `collectProMaps` и SQL `readProMapInventory` сохраняют границы S1-02: `is_pro IS TRUE`, без conflict, известный результат и duration>0, `from <= started_at < cutoff`, completion<=cutoff. SQL сравнивает исходные timestamps с микросекундами до JS Date rounding.
- Player history следует заново проверенным source-account links через любые организации. Cached `player_id`, ник и membership не устанавливают identity. Целевой игрок должен встретиться ровно один раз; identity conflict/duplicate target исключает карту. Native slot задаёт сторону. Неполный состав оппонента не уничтожает достоверную личную метрику.
- Только согласованные ref-linked confirmed role facts (confidence null/1), совпадающие с canonical identity/native slot. Inferred/estimated/conflicting роли и дубли позиции одной стороны → null. Без role filter такие карты остаются в отдельной строке «роль не подтверждена»; с role filter не включаются. Нет переноса общей истории на новую позицию.
- Hero ID берётся из того же native slot; null/0/нецелый/невалидный ID или повтор одного hero ID в разных слотах карты → unknown bucket. Название — локальный справочник, missing name остаётся null. Историческое участие героя не является доказательством patch/event hero eligibility.

## Формулы и знаменатели

- `summary` и каждая hero×role group: nRaw уникальных карт, wins, nullable observed WR, lastPlayedAt, dataUpdatedAt. Ноль карт → rate/metrics/dates null, counts0, groups[]. Это ноль **атрибутируемых наблюдений в локальной выборке**, а не доказательство отсутствия всей pro-истории игрока; unresolved candidates показываются отдельно.
- KDA = `(SUM(kills)+SUM(assists))/max(1,SUM(deaths))` только по картам с **полной** тройкой. Это агрегированное отношение, не среднее map KDA. При отсутствии полных троек value=null, nMaps=0.
- Mean K/D/A, GPM, XPM используют каждое своё доступное поле и возвращают `{value,nMaps}`. Настоящий 0 участвует в среднем; missing/невалидный численный факт остаётся null и не подменяется нулём. Границы соответствуют SQL/provider normalizer: K/D/A до32767, GPM/XPM до2147483647.
- `playerMapsInScope` — все attributed pro-карты **того же** периода/патча/роли/стороны/соперника/турнира до hero filter. `selectedHeroShare` = выбранные карты / этот denominator (null при denominator0). Если hero filter отсутствует, selected share=1 при N>0.
- Для каждой строки `heroMaps/heroPickRate` берут все роли **уже применённых фильтров** для данного героя / playerMapsInScope; при нескольких role rows одного героя эта частота повторяется, не суммируется. Counts самой строки остаются hero×role. Unknown hero maps остаются в denominator и видны в coverage.
- Веса, smoothing, prior, n_eff и любые strength/probability оценки здесь не вводятся. Small-sample smoothing — S1-06; chronological Elo — S1-05.

## Аудит и UI

Repeatable-read включает карты/identity/registry/hero names. Ответ фиксирует effective filters/from/cutoff/snapshot, source/policy/identity/registry revision; per-map source/sync/fetched/dataRevision, proof IDs, hero and nullable stats. Patch distribution и unknown values сохранены. Current late-fetched evidence не объявляется historical known-at; для ML нужен отдельный as-of feature builder.

Coverage candidates и mutually exclusive pro/conflict/completion/identity/context-filter exclusions относятся к исходному target window; heroFilterMismatch — attributed maps после остальных фильтров; knownHero/confirmedRole/knownPatch/fetched counters — только выбранные карты. У метрик собственные nMaps/selectedN. Не смешивать эти знаменатели.

Vue Query key содержит player ID и applied query; loading/unavailable/error/retry/empty/unknown состояния, отмена запросов и logout/401 cache clearing следуют существующему адаптеру. UI показывает applied filters отдельно от редактируемой формы, N каждой метрики, источник/обновление/last played и качество. Таблица прокручивается внутри контейнера на 360px.

Новых миграций/зависимостей нет; SQL001–013 и pnpm lockfile неизменны. `ProMapReport` прежнего endpoint не получает новых полей: внутренний target slot удаляется перед сериализацией. Synthetic fixture helper (`tests/helpers/player-hero.ts`) живёт только в тестах; optional role swap в pro-maps helper не меняет существующие fixtures по умолчанию.

Проверки: pure metric/role/patch cases входят в `pnpm test`, `pnpm test:player-hero` — disposable PG + HTTP; Chromium `player-hero.spec.ts` — реальная owner session/API/БД. Следующая задача: **S1-05 — хронологический Elo и сила соперников**.
