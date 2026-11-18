# Теневой расчёт сохранённого ручного драфта

Задача `S3-04/post-draft-shadow-runtime`, 14 ноября 2026. Первый исполняемый срез [пути допуска](S3_04_POST_DRAFT_ADMISSION_PATH.md): SQL058/060 → проверка frozen history → Elo/90-day hero-practice → fixed H0/H1/H2 → отдельный локальный файл с SHA и полным offline replay.

Это исследовательский инструмент, **не опубликованный post-draft прогноз**. API, UI, SQL, active V1, журнал прогнозов и старые research-артефакты не меняются. Автоматического запуска при сохранении сценария пока нет. H2 остаётся negative по прежнему development gate; отдельная независимая проверка ещё не зарегистрирована.

## Входы и неизвестный ID

Инструмент читает immutable capture, отдельно зафиксированное до cutoff наблюдение истории и ссылки SQL060. Прежняя read-only транзакция с лимитами сохраняется. Проверяются SHA, владелец, ревизия, сценарий, часы, десять разных подтверждённых аккаунтов и героев, фактические слоты прошлых карт, verified pro outcomes и целые известные серии. Пропуски дают structured `unavailable`; нарушение целостности отклоняет весь файл.

Новый адаптер `draft-shadow-features-core.mjs` имеет политику `selected-ten-and-known-series-exclusion-v1`:

1. До чтения исхода исторической карты исключить любое совпадение **набора десяти выбранных аккаунтов**, независимо от сторон, героев, тегов организаций и порядка строк.
2. Исключить остальные карты её известной серии. Обычные ошибки истории также закрывают всю известную серию.
3. Использовать один принятый V1-инвентарь карт для Elo и hero-practice. Сохранить ledger исключений и покрытие; минимум ранней pro-истории не обходится.
4. Считать с `targetMatchId:null`; фиктивный игровой ID не создаётся. Поздняя SQL059-привязка используется только в отдельном аудите и группировке, не в признаках.

Это консервативное условное исключение: потенциальная целевая карта с **этими десятью игроками** не попадёт в признаки даже при неизвестном ID. Оно также удаляет полезные прошлые встречи тех же десяти игроков. Нельзя считать такой инвентарь эквивалентным старому development-набору или переносить на него прежний quality gate. Новая политика должна быть явно закреплена до независимой проверки.

Если на фактической карте играли другие участники, этот сценарий остаётся гипотетическим и не может стать primary-наблюдением. Набор выбранных игроков не доказывает реальное участие или время начала игры. Положительные результаты этого среза проверены на синтетических входах; эмпирический объём исключений на новых реальных драфтах пока не измерен.

## Числа и неизменяемость

`player-hero-shadow-feature.mts` — отдельная nullable-target версия старого численного рецепта: за 90 дней число наблюдённых pro-карт на выбранном герое, `log1p`, среднее пяти A минус среднее пяти B. Не win rate, не оценка контрпиков, синергии, роли или пабликов. При одинаковом принятом инвентаре тест проверяет точное совпадение входов с прежним адаптером. Unknown hero/history/patch сохраняют свои предупреждения.

Frozen численный inference не менялся. Реальные источники принимают только кандидат SHA `9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b`. Синтетический кандидат разрешён только на источнике `syntheticOnly:true`; отсутствующий калибратор, неверный feature order или изменённый real artifact отклоняются.

Каждая попытка содержит frozen inputs, их fingerprint, версии правил, SHA capture/observation/candidate, raw/calibrated H0/H1/H2 в `researchScores`, покрытие и причины отказа. Это приватный research output. Публичные поля остаются `forecastStatus:'unavailable'`, `teamAWinProbability:null`, `primaryEligible:false`, `deployable:false`, `collectionAllowed:false`; training examples = 0. Несколько captures одной карты не превращаются в несколько независимых карт.

Файл создаётся исключительно через `wx`: существующий путь не перезаписывается. Проверка требует внешний SHA, прежнюю среду/код и полное воспроизведение результата. Пересчёт SHA после подмены числа не обходит replay. Поздний экспорт может содержать новый binding audit, но не заменяет старый сохранённый файл; fingerprint входов и числа при неизменном capture/history остаются прежними.

`calculatedAt` — время локального расчёта. Оно **не удостоверяет** завершение записи файла или фиксацию до gameplay start. Нет подписи источника, автоматического prospective registration или допуска в primary cohort. Для него по-прежнему нужны проверяемая граница начала игры, durable pre-start persistence и совпадение фактической карты с выбранными игроками/героями.

Старые feature/export kernels оставлены неизменными: их байты закреплены прежними manifest. Поэтому новый адаптер и nullable kernel версионированы отдельно, а численная совместимость покрыта тестом. Объединять реализации без явной миграции frozen replay нельзя.

## Запуск

Из корня `dotaanalitic`, после обычной сборки проекта и существующего prospective runtime:

```powershell
node node_modules/typescript/bin/tsc tools/research/player-hero-shadow-feature.mts tools/research/player-hero-inference.mts --strict --noUncheckedIndexedAccess --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --types node --typeRoots packages/db/node_modules/@types --outDir .tools/s304-shadow-runtime
node --env-file-if-exists=.env tools/audits/draft-shadow.mjs capture .tools/my-shadow-result.json
node tools/audits/draft-shadow.mjs verify .tools/my-shadow-result.json <SHA-из-первой-команды>
```

Каждому запуску — новый путь. `verify` работает без БД и provider HTTP. Для чистого checkout прежний runtime собирается командой:

```powershell
node node_modules/typescript/bin/tsc tools/research/player-hero-prospective-features.mts tools/research/player-hero-inference.mts --strict --noUncheckedIndexedAccess --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --types node --typeRoots packages/db/node_modules/@types --outDir .tools/s304-prospective-features-runtime
```

Реальный кандидат — приватный `.tools/s304-hero-fit-r1/artifact.json`; тесты создают только явно синтетический кандидат и не требуют этого файла. Нет fallback на синтетику при отсутствии real artifact.

## Проверки и ограничение фактического покрытия

- 11 новых тестов: pending/late-binding invariance, parity входов, target-label exclusion и закрытие серии, нехватка истории, identity conflict, clocks, неизвестные герои, A/B, SHA/owner/link, candidate guard, exclusive file/replay/tamper.
- Полный последовательный прогон: **1040 пакетных тестов PASS**. Первый целевой прогон выявил две ошибки в новых фикстурах: ожидание при невалидных часах и неверное поле lineup. Исправлены ожидания/фикстура, схемы не ослаблялись.
- Typecheck и frozen offline install PASS. Первый sandbox install отказался из-за другого store/no TTY; повтор в обычном существующем pnpm store прошёл без сети и изменения lockfile.
- Frozen Python goldens: 262 случая, **1570 численных сравнений + 2 null**, max error `1.1102230246251565e-16`, PASS. Нового fitting не было.
- Реальный read-only экспорт `.tools/s304-shadow-local-r1.json`: **0 captures, 0 observations, 0 links, 0 рассчитанных драфтов**; SHA `eee8543ca8dd5bd22ecee1157c1f9cdb4f844d93a9c67ef830f4eee8185b099f`. Это проверка пустого пути, не подтверждение live-покрытия или точности.

Сборка PASS; прежние предупреждения Zod annotations и web chunk >500 kB сохранились. 56 прежних Node-тестов, replay нового shadow-файла, старого observation export и prepared independent manifest, 60 SQL checksums и docs links PASS. На 16:28:23 UTC рабочие V1 `model_eligible`, 2260 карт и все 7 прежних forecast hashes сохранены; API/Web200, private401. Новые PG/browser suites не запускались: API/SQL/UI не менялись, collector переиспользован без изменений. [Итоговые evidence](evidence/s3-04-post-draft-shadow-runtime.json).

**Следующая задача: S3-04/post-draft-validation-readiness** — подготовить регистрацию независимой проверки: зафиксировать новую политику истории, исполняемый evaluator и полный реестр уже раскрытых карт/серий; проверить реальные draft snapshots, конкретные Tier1-выпуски/период и способ durable pre-start фиксации. При недостающих свидетельствах явно оставить регистрацию закрытой, не менять старые пороги по результату. **GPT-6 Astra · High.**
