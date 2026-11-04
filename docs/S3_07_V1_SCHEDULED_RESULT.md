# S3-07/V1-scheduled-result-binding — результат встречи из расписания

**Продолжение2026-11-03:** [owner API/UI запуска расчёта реализованы](S3_07_V1_SCHEDULED_OWNER_FLOW.md). Ручное result binding пока CLI; следующий срез — S3-07/V1-scheduled-binding-owner-flow.

Реализован owner CLI путь от неизменяемого scheduled forecast к проверенному результату первой профессиональной карты. Сопоставление PandaScore/OpenDota — **явное ручное решение владельца с источником и объяснением**, а не автоматический вывод по названиям или времени. Профессиональный исход, серия, map1, native стороны, фактический старт и составы проверяются независимо по локальным данным. Это завершение данного среза, не всего S3-07 или проверки качества модели.

## Запуск

Сначала нужны [scheduled runtime snapshot](S3_07_V1_SCHEDULED_RUNTIME.md), импортированная проверенная pro-карта, подтверждённая серия OpenDota и принятые evidence для `context.map_number=1`. Наличие самой ранней карты в локальной БД не доказывает map1. При неизвестной или конфликтующей информации сопоставление не сохраняется. CLI не получает победителя от владельца и не импортирует данные из указанного URL.

Пример структуры `binding-request.json` с placeholders:

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "predictionRequestId": "22222222-2222-4222-8222-222222222222",
  "targetSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "matchId": "12345",
  "providerSeriesId": "321",
  "sourceUrl": "https://example.test/reviewed-meeting-and-map",
  "rationale": "Описание проверенного владельцем соответствия конкретной встречи и первой карты"
}
```

`targetSha256` берётся из исходного `realTarget` прогноза, не из SHA файла запроса. `matchId` — canonical OpenDota map ID; `providerSeriesId` — подтверждённая серия OpenDota. Владелец должен проверить, что источник действительно подтверждает именно эту встречу, особенно при повторных встречах тех же команд. URL/пояснение сохраняются как owner-reviewed evidence; сервис не утверждает независимую автоматическую проверку межпровайдерного соответствия.

```powershell
pnpm build
pnpm db:migrate
$bindingSha = (Get-FileHash -LiteralPath binding-request.json -Algorithm SHA256).Hash.ToLowerInvariant()
pnpm forecast:v1 bind binding-request.json $bindingSha
pnpm forecast:v1 binding 11111111-1111-4111-8111-111111111111
```

Команда `bind` сохраняет отдельную связь. Для добавления verified outcome revision используется прежняя `forecast:v1 refresh` с новым UUID, `predictionRequestId`, `matchId` и `expectedRevision` (0 для первого refresh). SHA передаётся от файла refresh-запроса. `forecast:v1 history PREDICTION_REQUEST_ID` возвращает историю. После refresh владелец создаёт новый отчёт на `/forecast-journal`; старые отчёты остаются неизменными.

## Гарантии

- SQL032 добавляет append-only `v1_schedule_result_bindings`, owner/request idempotency, target-revision FK, exact JSON/SHA, server `reviewedAt` и отдельный `recorded_at`. Эти времена не выдаются за время доступности до игры.
- Новая связь относится к исходной target revision/SHA прогноза. Последующая редакция назначения требует собственного review; старый прогноз не переписывается. Повтор того же request UUID/hash возвращает тот же результат даже после correction источника.
- На одну редакцию назначения одна неизменяемая связь. Для одного PandaScore meeting нельзя указать другую карту/серию; ту же карту нельзя назначить другой встрече. Для исправления ошибочного ручного сопоставления отдельный auditable correction flow пока не реализован; обход через удаление строки или новый UUID запрещён.
- Общие проверки исхода перенесены в отдельную SQL-функцию без изменения тела правил. Для scheduled проверки создаётся временное представление разрешённого OpenDota selector; оно **не записывается** в прогноз. Старый OpenDota verifier сохранён.
- Результат — только verified pro-map, с источником, исходом, контекстом серии/map1 и соответствием A/B ↔ Radiant/Dire. Прогноз должен быть выдан строго до фактического начала; плановое время не заменяет фактическое. Поздний forecast остаётся в audit и исключается из prospective metrics.
- После сохранения результата новые попытки по этой встрече получают unavailable/TARGET_SERIES_ALREADY_STARTED во всех редакциях назначения, даже при устаревшем future/not_started расписании. Общий advisory lock сериализует выдачу и сохранение связи. Дополнительная SQL033 запрещает done независимо от TypeScript; прежняя SQL032 после применения не переписывалась. Exact retry возвращает первоначальный snapshot.
- Совпавшие, несовпавшие и неизвестные actual5v5 различаются. Несовпадение не удаляет настоящий pre-start прогноз из общей статистики, matched-lineup cohort остаётся отдельным.
- Provider correction создаёт новую outcome revision. Повторная сверка журнала использует актуальные локальные факты, а сохранённая связь, старые исходы и отчёты остаются читаемыми. Отсутствующая связь новой target revision даёт `SCHEDULE_BINDING_REQUIRED`, не падение всего журнала.
- Журнал сохраняет SHA/источник/time ручного сопоставления вместе с проверкой результата. Один actual map даёт одно primary наблюдение по прежней политике; пересчёты не увеличивают training N.

## Границы и следующий шаг

В этой задаче нет новых HTTP mutation routes, UI ввода сопоставления, автоматического поиска карты, обращений к провайдерам, обучения или активации модели. Положительные проверки используют явно синтетические данные только в изолированных тестах. Рабочие прогнозы и сопоставления не создаются без реальной задачи владельца.

**Следующий точный срез — S3-07/V1-scheduled-owner-flow:** защищённый owner API/UI для запуска расчёта из сохранённой встречи с выбранным сценарием5v5 и просмотра результата; затем UI ручного связывания результата и lifecycle назначений расписания. S3-07/V1 release остаётся открытым. Рекомендуемая модель: **GPT-6.1 Sol · High**, с сохранением существующих проверок времени и результата.

## Проверено2026-11-03

**QA завершена:** offline frozen install, полный typecheck/build, финальные web typecheck/build PASS. **702 unit/CLI,97 isolated PostgreSQL,24 browser E2E** PASS; новых1/7/1 соответственно. Первоначальные6 новых PG cases прошли, расширенный7-test файл вошёл в итоговые97. Новый regression сначала воспроизвёл выдачу после известного completed-map binding при устаревшем расписании. Runtime owner lock/check и независимая SQL033 guard исправили её;7-case regression и итоговые97 PG/702 unit повторно PASS,2 scheduled browser tests повторены после финальной сборки. Desktop/360px просмотрены, прежняя горизонтальная прокрутка таблицы сохранена.33 migration checksums/docs links/diff проверены. Evidence: `docs/evidence/s3-07-v1-scheduled-result.json`. Один прежний release CLI test превысил90s после длительной паузы исполнения (reported826618ms); неизменённый2-test файл прошёл отдельно с прежним лимитом, затем API40/worker1 PASS.702 — уникальные тесты, не сумма повторов. Положительные вероятности/исходы — только synthetic protocol doubles в disposable DB и явно синтетический browser display fixture, не реальные quality results.

**Сохранность:** SQL032 и033 applied/retry skip33. SQL001–031,24 protected artifacts,21 working-table fingerprints, E0 exact replay,232 feature rows и archived/current runtime compatibility сохранены. Resolved SQL verifier имеет прежнее тело правил; primary/metrics kernels неизменны. Старый report revision1/SHA bd42a60064c42daa4281bcb0e8972eba79d72737a4fccffe480d8a8725767398 читается с N0/legacy cancelled null. Рабочие models1/artifacts1/active0/activations0/E1/release0/scenarios0/predictions0/snapshots0/outcomes0/refresh0/reports1/lifecycle0/scheduleTargets0/scheduleResultBindings0. Dota provider calls/imports/training/реальные оценки/активации0. Первый read получил ECONNREFUSED: запущен прежний локальный PostgreSQL, штатное recovery завершилось, данные сверены без переинициализации.
