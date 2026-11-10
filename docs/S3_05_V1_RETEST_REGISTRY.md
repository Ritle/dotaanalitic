# S3-05 — регистрация проверенного retest

**Обновление 10 ноября:** [интеграция активации/readiness/runtime завершена](S3_05_V1_RETEST_RUNTIME.md). Новый срез расширяет проверенный compatibility manifest ровно двумя hash-pinned orchestration modules и добавляет SQL051. Рабочая модель по-прежнему неактивна. Ниже сохранён первоначальный отчёт регистрации SQL050.

Новый путь регистрации принимает [прошедшую проверку модель V1](S3_03_V1_RETEST_EVALUATION.md) и сохраняет её **неактивной**. Формат проверки — `conditional_retrospective_unexposed_series`: оценка при выбранных пятёрках, проверенная на восстановленных составах. Он не превращается в prospective evidence и не заменяет прежнюю неуспешную попытку.

## Приём и хранение

`RetestModelRegistry` принимает пять исходных документов: capsule, executable freeze, first-scoring marker, report и registry binding. Проверяются точные UTF-8 bytes/SHA-256, размеры, версия схемы, реальные источники, фиксированная политика и runtime. Проверяющий модуль загружается из фиксированного пути репозитория; исполняемый код из входного каталога не импортируется. Локальный проверяющий код воспроизводит capsule и весь отчёт, включая оценку качества; одного поля `passed` недостаточно.

Проверяется совпадение текущего кода с 390 entries исходного freeze. Допустимы только два точных добавления export в `contracts/dist/index.js` и `db/dist/index.js`; исходные префиксы должны совпадать побайтно. Формула Elo, feature builder, scorer и quality policy неизменны. Расширять этот допуск для иных изменений без отдельной проверки нельзя.

Миграция `050_v1_retest_registry.sql` создаёт `v1_retest_model_artifacts`. Таблица содержит исходные тексты, SHA, воспроизведённые метаданные и время приёма. SQL проверяет digest и ключевые связи, запрещает UPDATE/DELETE/TRUNCATE доказательств. В одной транзакции создаётся запись `prediction_model_versions` и её evidence; сбой откатывает обе. Повтор тех же документов возвращает тот же ID; другой результат для того же протокола отклоняется. Старые миграции и журналы не переписываются.

Для fixed Elo нет fitting run: `train_games=0`, `trained_at` указывает время фиксации политики, `test_games` — фактическое число оценённых карт. Начальные параметры — 1500/K32/scale400. История для расчёта рейтингов не объявляется обучающей выборкой новой fitted-модели.

## Команды

Из корня приложения после `pnpm shared:build`; перед рабочей миграцией нужна резервная копия БД. `check` не использует БД или внешние API. `register`, `list`, `verify` читают локальную `.env`:

```powershell
node --env-file-if-exists=.env scripts/migrate.mjs
$bundle = '.tools/v1-retest-freeze-20261110/bundle'
$freezeSha = '61a718f762d24c9fa98dca1b928797adab411a097d4b6eef04782de5ca7992ab'
$inputSha = '654087e06004bb646344252e84e37a98f74dc2f3c40514a983f276aeed5ef212'
$reportSha = '8227233077617c91335cc2b53c634cbaebe69bd180a0665d4c336809af3ee790'
node scripts/register-v1-retest.mjs check $bundle $freezeSha $inputSha $reportSha
node --env-file-if-exists=.env scripts/register-v1-retest.mjs register $bundle $freezeSha $inputSha $reportSha
node --env-file-if-exists=.env scripts/register-v1-retest.mjs list
```

После получения `modelId`: `node --env-file-if-exists=.env scripts/register-v1-retest.mjs verify MODEL_ID`. `verify` читает evidence из БД и повторяет проверку, не полагаясь на наличие исходного каталога. Большие исходные документы не возвращаются в выводе CLI; ошибки не раскрывают содержимое или DB URL.

## Граница текущего среза

Регистрация возвращает `registered_inactive`, повтор — `already_registered`, проверка — `verified_inactive`; `isActive=false`, вероятность `null`. SQL блокирует изменение этой записи и обход через прежние activation events. Старый реестр и прогнозный runtime остаются совместимыми со своими форматами; автоматического подключения retest к ним нет.

Следующая задача — **S3-05/S3-06/V1-retest/activation-readiness**: versioned activation/rollback с аудитом и конкурентными проверками, распознавание retest в readiness и runtime, сохранение conditional basis в неизменяемом снимке прогноза. Только после проверок — отдельная активация и smoke первой карты. Проверка ролей, героев, post-draft и прогноз серии не входят в этот fixed Elo срез. Модель для следующей задачи: **GPT-6 Astra · Extra High**.

## Выполнено на рабочей БД 10 ноября

Модель: `35aa1dd3-e00c-4dcf-95fa-fbd3b74dba3b`; check → registered_inactive → already_registered с тем же ID → verified_inactive. [Evidence](evidence/s3-05-v1-retest-registry.json). Сохранены quality PASS,664 карты/332 серии и исходный report SHA. Readiness: unavailable / NO_ACTIVE_MODEL. Вероятности не выдавались.

Frozen offline install, typecheck и build — PASS;895 unit/CLI,237 Node и49 уникальных PostgreSQL/API проверок — PASS. Из них6 новых PG; в прежних43 первоначально41 PASS и2 hook timeout, отдельный повтор двух PASS без изменения тестов/тайм-аутов. В частном проверочном скрипте первоначальный заведомо неподдерживаемый Node отвергался ещё схемой; для проверки точного runtime binding использована допустимая иная версия Node, получен ожидаемый freeze_replay отказ. Настоящий отчёт с изменённой метрикой, пересчитанными SHA/fingerprint и сохранённым passed отвергнут полным replay. Synthetic PG doubles проверяют только persistence, настоящий admission проверен отдельно на реальном bundle.

До миграции создан custom backup, pg_restore --list PASS; восстановление этой копии не выполнялось. Все прежние строки83 public-таблиц сохранены; добавлены ledger050, одна модель и новая таблица с одной evidence-записью (84 таблицы). Повтор регистрации и verify не изменили таблицы.2232 карты,14 полных строк очереди, прежний FAIL и первый retest report/marker/binding сохранены.9701 из9703 защищённых файлов побайтно прежние; два текущих barrel index имеют только разрешённые export-суффиксы. Frozen copies целиком неизменны. Проверены50 миграций, старые SHA сохранены.

Внешних API-запросов0; API/Web/general worker не запускались. Зависимости/.env/lockfile не менялись. Полный PostgreSQL suite, браузер, Python, Docker/Linux в этом срезе не запускались; предупреждение Vite о размере bundle остаётся.
