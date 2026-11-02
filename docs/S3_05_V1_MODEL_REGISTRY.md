# S3-05/V1 — реестр и атомарное переключение версии

Срез2026-11-02 реализует регистрацию фиксированного Elo, promote/rollback/deactivate и проверку актуального model gate. Это первая часть S3-05/06. Runtime-выбор турнира, история/составы, immutable prediction snapshots и выдача вероятностей остаются следующим срезом S3-06; пользовательский forecast journal — отдельным S3-07.

## Регистрация

`model:v1 check|register` читает отдельный [закреплённый bundle](S3_03_V1_EXECUTABLE_FREEZE.md). Нужны внешние SHA его `frozen/config.json` и freeze-артефакта. Проверяются исходные plan/catalogue/development bytes, kernel, полный manifest из232 файлов и версия/platform/arch/SHA Node. Код из переданного каталога не импортируется и не исполняется. Пути файлов должны оставаться внутри bundle; смена основного checkout не требует переписывать старый оценщик.

Регистрация создаёт **неактивную** запись `prediction_model_versions` и хранит точные plan/candidate/freeze bytes в `v1_model_artifacts`. Хеши проверяются при записи и чтении, metadata и artifacts immutable. Повтор той же регистрации возвращает прежний model ID; конфликт bytes отклоняется. Synthetic provenance запрещена. Старые E0/E1 не превращаются в release-модель.

У фиксированного Elo нет fitting: `training_run_id:null`, train/test counters0 до отдельных оценок, `hyperparameters.fit.method:fixed_policy_no_fitting`. Legacy поле `trained_at` хранит время регистрации kernel, а не выдуманный запуск обучения. `artifact_uri:v1-registry:<UUID>` — внутренний идентификатор; исполняемый путь или URL из БД не загружается. Полный release dataset/capture остаётся в независимом immutable журнале, не создаётся фиктивный training dataset ради FK.

Legacy train/test timestamps описывают зарегистрированные окна, а не уже обработанный корпус. `test_end_at` — конец выбранных событий; поздний snapshot/evaluateNotBefore хранится в plan/freeze отдельно. Фактические N/метрики берутся из release report, immutable counters модели не переписываются при активации.

## Promote, rollback, deactivate

Owner CLI принимает строгий JSON:

```json
{
  "requestId": "<UUID новой операции>",
  "action": "promote",
  "modelId": "<UUID зарегистрированной модели>",
  "expectedCurrentId": null,
  "reason": "Причина явного включения проверенной версии",
  "release": {
    "planFingerprint": "<64 hex>",
    "revision": 1,
    "reportSha256": "<SHA точных bytes journal report>"
  }
}
```

`expectedCurrentId` — ожидаемая текущая активная pre-match версия, null только при её отсутствии. `rollback` требует ранее активированную модель и её актуальный пригодный release report. Для `deactivate`: modelId/release null, expectedCurrentId задан. Reason10–1000 символов. Один requestId относится к одному payload; повтор возвращает тот же event, а изменённые входы требуют нового requestId. Ответ отдельно показывает текущую activeModelId, поскольку после старой операции могло быть другое переключение.

Stage-lock сериализует переходы. Затем plan-lock синхронизируется с release-журналом. Только **последняя** committed revision, совпавшая по SHA, может поддержать promote/rollback: v2, completed, passed, non-synthetic, правильные plan/kernel/freeze/scorer bindings и допустимые реальные часы. Внутренний journal reader также проверяет сохранённые capture/report hashes. Legacy v1 или прежний pass после позднего failed revision не подходят.

Переключение `is_active` и insert в общий `model_activation_events` выполняются одной SQL-транзакцией. Ошибка аудита откатывает оба флага. CAS не позволяет конкурентной операции неожиданно заменить уже сменившегося champion. Неудачная новая модель не вытесняет действующую. SQL проверяет release FK/latest revision/provenance и запрещает обход V1 через прежний fitted-model gate. Deferred guard связывает активный флаг V1 с последним событием; прямой UPDATE без аудита отклоняется.

`readiness` — **только допуск модели**, ещё не разрешение выдать прогноз для произвольной карты. Он повторно проверяет bytes и последнюю revision. Поздний failed/corrupt report даёт unavailable, даже если исторический `is_active` не переписан. Target Tier1 scope, ten identities, strict completed history и feature/runtime parity проверяются в следующем S3-06. Все текущие CLI ответы сохраняют `teamAWinProbability:null`.

## Команды

```powershell
pnpm model:v1 check .tools/v1-frozen-runtime CONFIG_SHA FREEZE_SHA
pnpm model:v1 register .tools/v1-frozen-runtime CONFIG_SHA FREEZE_SHA
pnpm model:v1 list
pnpm model:v1 readiness
pnpm model:v1 events
pnpm model:v1 transition request.json REQUEST_SHA
```

`check` работает без БД. Остальные команды используют локальный DATABASE_URL. Register не запускает оценку/обучение/активацию. Transition не принимает свободный report-файл: читает уже committed PostgreSQL-журнал. При неоднозначном обрыве соединения повторить неизменённый JSON с тем же requestId; аудит можно посмотреть через events. Автоматическое продвижение не добавлено, HTTP-endpoint отсутствует.

## Миграция и тестовая граница

Forward-only025 добавляет v1_model_artifacts, V1 evidence/idempotency/sequence поля в общий activation audit и расширяет его guard, сохраняя прежний fitted-model branch. Исторические SQL001–024 не переписываются. `model_evaluation_runs` и его frozen training dataset FK не ослабляются. Новые UI/API зависимости не устанавливаются.

Unit tests проверяют artifact/report bindings, synthetic rejection, часы и формат перехода. PostgreSQL tests проверяют idempotency, CAS/races, rollback, DB failure, immutable metadata/audit и позднюю failed revision. **Положительные transition tests используют явно синтетический double контракта journal reader в disposable БД**: реальные карты не переименовываются и реальная точность не утверждается. Отдельные release-journal tests сохраняют полноценный source-bound synthetic replay; его synthetic gate остаётся false. Фактический положительный release gate можно проверить только после настоящей независимой оценки.

Следующий точный срез — **S3-06/V1-runtime-snapshots**: связать зарегистрированную версию с проверкой совместимости inference-кода, явным reviewed Tier1 target scope, текущими verified identities/завершённой историей и immutable scenario/input/features/model snapshot. Пока gate не пройден, сервис возвращает unavailable/null. S3-03/S3-01 остаются открытыми до реальной оценки с2 декабря2026,03:00 МСК; S3-07 journal обязателен до выпуска.

## Проверенный рабочий checkpoint

025 применена, повтор skipped. Зарегистрирован model ID `8837077f-7bd3-4412-85c8-13dcab6aa14d`, повтор вернул тот же ID. В БД1 inactive model/1 artifact, active0, activation events0, E1/release journal0. Проверочная попытка promote с отсутствующим report SHA отвергнута `REGISTRY_RELEASE_NOT_LATEST`; readiness `NO_ACTIVE_MODEL`. Файлы kernel r4 и полного freeze, отдельный bundle и15 прежних protected artifacts сохранены. E0/232 feature rows воспроизведены точно;20 прежних таблиц не изменились, model table получила1 новую запись.

QA PASS: frozen install/typecheck/build,650 unit/CLI и58 isolated PostgreSQL tests,25 migration checksums, docs links/diff. Последнее уточнение test_end_at проверено повторной DB-сборкой/typecheck и7 PG tests. Первоначальная миграция использовала недоступный pgcrypto digest; до применения исправлена на встроенный PostgreSQL sha256(convert_to(...)), расширение не устанавливалось. Live source audit одной карты9073402068 подтвердил observed pro outcome/10 numeric accounts/series; это не canonical identity proof или release quality. E2E/Python не запускались: UI/HTTP/fitting не менялись. [Evidence](evidence/s3-05-v1-registry.json), SHA `2ccd0a4662dad473944959316418bb39faf05f11f7586a939b880812434214dd`.
