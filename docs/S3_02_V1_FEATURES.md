# S3-02/V1-features — общий построитель Elo

Реализовано 2026-11-02. Это подготовка признаков, не активная модель и не проверка точности. S3-01/V1-evaluation остаётся открытой; E0/E1 и зарегистрированный V1 release plan не изменены.

## Границы реализации

- `packages/prediction` — server-side пакет без БД, сети и чтения текущего времени. `createV1FeatureBuilder(history)` проверяет и копирует историю, возвращая функцию для сценариев; `buildV1Features(history, scenario)` использует ту же реализацию. Offline и будущий runtime вызывают одинаковую функцию.
- `packages/contracts/src/v1-features.ts` — строгие Zod-контракты истории и сценария; bigint-safe ID и микросекунды передаются строками.
- `packages/db/src/v1-features.ts` — adapter от `verifyV1Data`: заново воспроизводит immutable development dataset и eligibility/whole-series checks. Пятёрки берутся по native slots, исход привязан к verified map receipt. `prepareV1FeatureHistory` сохраняет evidence clocks; `buildV1DevelopmentFeatures` строит строки без целевых labels.
- `scripts/prepare-v1-features.mjs` — offline export с внешним SHA датасета, manifest исполняемого кода, лимитом 64 MiB и exclusive output. БД/токены не нужны. После ошибки может остаться пустой/неполный файл; для повторения нужно новое имя.

Нормализованная история — **внутренняя граница доверенного adapter**. Одни `isPro: true` и receipt SHA в произвольном JSON не заменяют OutcomeVerifier. Production HTTP endpoint и runtime repository пока не подключены: это следующие задачи.

## Политика `player-mean-elo-completed-strict-v1`

Параметры соответствуют зарегистрированному [release gate](MODEL_VALIDATION.md): prior 1500, K=32, scale=400, минимум пять завершённых eligible pro-карт у каждого из десяти игроков. Порог не подбирался по текущему корпусу. История всех профессиональных уровней и организаций допустима; Tier 1 — область будущих целевых прогнозов и отдельной оценки, не множитель рейтинга.

Для cutoff T используются только карты со `startedAtUs < T` **и** `completedAtUs < T`. Целевая карта исключается по ID; если она присутствует в истории, её cutoff должен совпадать с началом. Равенство завершения и T не проходит. Для каждой карты истории delta фиксируется по средним рейтингам на её начало, когда доступны только строго более ранние завершения. Обновления применяются по завершению, затем числовому match ID. Параллельные карты не получают ещё неизвестные результаты друг друга.

Пять игроков получают одинаковую delta относительно среднего соперника. Организации, роли, патчи, герои, draft, Radiant advantage, пабы и сыгранность не входят в признаки. Личный рейтинг сохраняется при переходе; штраф за замену не вводится. A/B — выбранные стороны сценария; перестановка меняет знак `eloDifference` и переставляет средние.

Identity policy — текущая verified связь того же numeric account, доступная к snapshot. Ники не используются. Conflict/rejected evidence и отсутствие связи блокируют признаки; ошибочная история исключается вместе с известными сиблингами серии. Один canonical player с несколькими аккаунтами возвращает `CROSS_ACCOUNT_HISTORY_UNSUPPORTED`: cross-account merge требует отдельной evidence policy. Доказательства из будущего относительно snapshot не используются. Реальные event/known/fetched/recorded clocks не переписываются; позднее получение исторических исходов допускается с явным `EVENT_TIME_OUTCOME_AVAILABILITY_ASSUMED`.

Для ручного/ожидаемого сценария обязательны источник, время выбора и revision. Выбор должен предшествовать cutoff и быть не позже snapshot. Реконструированный исторический состав допускается отдельно и маркируется `actual_lineup_reconstructed`; это не доказательство исторически известной пятёрки или будущего участия.

## Результат и отсутствующая история

`status: ready` означает только готовность признаков. Результат содержит `teamAMeanElo`, `teamBMeanElo`, `eloDifference`, персональные ratings/maps/proof IDs, N использованных карт, минимальное N игрока, used match IDs, исключения, source fingerprint, snapshot/identity revision, scenario и fingerprint результата. N_eff равен N_raw: весов нет. Персональные счётчики отделены от общего размера истории; независимость наблюдений не утверждается.

При нулевой истории отображаемый rating — null; prior 1500 существует только внутри replay. При N<5 хотя бы у одного игрока или нарушении identity/lineup gate — `features: null`, `status: unavailable` и причины. Cold-start карты могут обновлять внутренние рейтинги. Всегда `predictionStatus: unavailable`, `teamAWinProbability: null`, `deployable: false`, даже при готовых признаках.

Числовые признаки не зависят от будущих labels. Полный audit fingerprint может измениться при новой версии исходного датасета, включая исправление будущей карты: он сохраняет source provenance. `known_at` не выводится из completed timestamp. Полнота удалённого корпуса не заявляется; используются supplied eligible maps начиная с warmup. Factory не сохраняет изменяемые ссылки на входные данные и выданные результаты.

## Команда и фактическая проверка

```powershell
pnpm features:v1 export .tools/v1-data-export.json 79ae50020134a30ad822d9780934518e64010fb85fc367885d3e12092c70eed5 .tools/my-v1-features.json
```

Принимается проверенный `v1-development-dataset-v1`, не research E1 capture и не release plan. Экспорт не содержит labels/метрик точности, сохраняет `syntheticOnly`; синтетика недопустима для production. Команда не обходит gates E1/release test.

На сохранённом development корпусе: 232 строки, 152 с готовыми признаками, 80 unavailable из-за недостаточной истории. Повторный экспорт byte-identical. Это покрытие на просмотренных данных, не backtest и не Tier 1 release validation. Живой audit одной исторической карты league17765: 3 HTTP200, completed pro outcome/10 source accounts 1/1; pre-match lineup known-at не установлен. Новых карт в рабочую БД не импортировано.

Тесты покрывают строгую границу/микросекунды, незавершённые/будущие карты, большие ID, одновременные завершения, ручной и реконструированный состав, transfer/side swaps, n=0/порог5, identity conflicts, whole-series exclusions, snapshot clocks, неизменяемость factory, replay evidence и byte-exact CLI. Старый E0/E1 Elo с иной границей времени не менялся.

Неактивный Elo kernel artifact и pure metric diagnostic уже реализованы в [S3-03](S3_03_V1_CANDIDATE.md). Следующий точный срез — **S3-03/V1-release-evidence:** source-bound release executor, first-result journal и итоговый freeze полного executable. Независимая оценка, activation/snapshots и обязательный S3-07 forecast journal ещё впереди.

Проверки PASS: frozen install, полный typecheck/build, 599 тестов общего прогона; после исправления mutable-output alias повторены все26 feature/adapter/CLI tests (19 prediction +6 adapter +1 CLI), текущий набор600 уникальных тестов.21 isolated PostgreSQL regression tests PASS. E2E/Python не запускались: UI/HTTP/fitting не менялись. [Evidence](evidence/s3-02-v1-features.json), SHA-256 `9862a582c62d2d48531dbc34df9205efc302d257c36892cc156542019664c9f0`. Последний development export SHA `bb33ee716beb88c277bcc6632203c29e841db0f13e03b822f1541bb54b40c658`; прежние файлы не перезаписывались.21 рабочая таблица и архивный E0 replay сохранены;23 SQL migration hashes прошли проверку, новых миграций нет.
