# Общий исследовательский реестр

Оба ПК работают с одной PostgreSQL на VPS. Каждый запускает исследовательские команды из своей рабочей копии и читает свою локальную историю. Общая база хранит проверенные списки известных ID и файлы, доступные по SHA-256.

| Что хранится | Таблица | Как используется |
| --- | --- | --- |
| Снимки просмотренных карт, серий OpenDota и встреч PandaScore | `research_exposure_snapshots` | Сравнение кандидатов с историей обоих ПК |
| Точные байты исследовательских файлов | `research_artifacts` | Загрузка и скачивание пакетов по SHA-256 |

ID серий OpenDota и встреч PandaScore учитываются раздельно. Снимки фиксируют источники и версию кода. Совпадение карты или серии помогает исключить её из независимой выборки. Для допуска выборки отдельно подтверждаются полнота истории и состав серии.

## Подключение Windows-ПК

На VPS PostgreSQL 16 слушает локальный интерфейс. На каждом ПК используется свой SSH-ключ, а приложение подключается через локальный порт туннеля 55433. Администратор VPS добавляет публичный ключ клиента и выдаёт отдельный логин PostgreSQL.

На новом ПК создайте локальный ключ из папки проекта. Для уже подключённого ПК используется имеющийся файл.

```powershell
New-Item -ItemType Directory -Path .tools -Force | Out-Null
ssh-keygen -t ed25519 -f .tools/research-vps-client-ed25519 -C dota-registry-client
Get-Content -LiteralPath .tools/research-vps-client-ed25519.pub
```

Передайте администратору строку из `.pub`. Приватный файл остаётся на клиенте. В локальном `.env` задайте `RESEARCH_DATABASE_URL` с выданным логином и паролем. `DATABASE_URL` указывает на локальную БД с историей этого ПК.

```dotenv
RESEARCH_DATABASE_URL=postgresql://REGISTRY_USER:REGISTRY_PASSWORD@127.0.0.1:55433/dota_registry
```

В отдельном PowerShell из корня проекта подставьте адрес VPS и сверенный публичный ключ сервера в формате `ssh-ed25519 <ключ>`. Оставьте окно открытым во время работы с реестром.

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\tools\research\start-research-vps-tunnel.ps1 -ServerAddress 'VPS_HOST' -HostPublicKey 'ssh-ed25519 HOST_PUBLIC_KEY'
```

### Права и установка на VPS

Миграции 075 и 076 создают обе таблицы в выделенной базе. Их можно применить с административного ПК через туннель. Для SQL-команд у владельца базы и у клиентов используются разные роли. Клиентам нужны `CONNECT`, `USAGE` на схему `public` и права ниже.

| Операция | Права на таблицу |
| --- | --- |
| Читать и пополнять список исключений | `SELECT` и `INSERT (sha256, snapshot_text)` на `research_exposure_snapshots` |
| Скачать пакет | `SELECT` на `research_artifacts` |
| Опубликовать пакет | `INSERT (sha256, body)` вместе с правом чтения `research_artifacts` |

Доступ к исследовательской базе отделён от базы приложения. Команда регистрации DreamLeague хранит квитанцию в базе приложения после проверки выбранного протокола и снимка реестра. [Регистрация Draft Lab](S3_04_DL30_SWISS.md#команда-владельца-для-регистрации)

## Проверка и загрузка истории

После открытия туннеля выполните в другом терминале из той же папки проекта:

```powershell
node --env-file=.env tools/research/reconcile-dl30-pc-inventories.mjs check-series - - 8345450484
```

Для контрольной карты ожидается `known_overlap`. Поля после `check-series` принимают ID серии OpenDota, ID встречи PandaScore и список ID карт. Укажите `-` для неизвестного ID серии или встречи. `no_known_overlap` означает, что в прочитанном снимке среди переданных ID совпадений не найдено. `registry_empty` означает отсутствие ревизий.

Чтобы добавить наблюдения этого ПК, оставьте `DATABASE_URL` подключённой к его локальной истории и выполните:

```powershell
$output = ".tools/series-shared-$(Get-Date -Format yyyyMMdd-HHmmss).json"
node --env-file=.env tools/research/review-series-exposure.mjs $output --shared
```

Результат содержит SHA отчёта, число общих ревизий и суммарные количества ID. Проверьте публикацию с другого ПК через `check-series`. Повтор с теми же входами и версией кода даёт тот же снимок. Для независимой оценки DreamLeague отдельно сохраняйте автономные отчёты каждого ПК и сверку неопубликованных файлов. [Правила исключения](S3_04_EXPOSURE_LEDGER.md#общая-исследовательская-база-для-двух-пк)

## Обмен пакетом Draft Lab r1

Укажите SHA-256 пакета и путь к файлу. `put` выполняется на ПК с правом публикации, `get` — на ПК, который читает пакет. Для скачивания нужен свободный путь.

```powershell
$digest = '51183190a4710947b1135167fe52dc1c6eb0f30aca21d1c30a0fc97b53c6bd1f'
$file = '.tools/s304-dl30-swiss-package-r1.json'
node --env-file=.env tools/research/shared-research-artifact.mjs put $digest $file
node --env-file=.env tools/research/shared-research-artifact.mjs get $digest $file
```

Команды проверяют SHA перед записью и после чтения. Исходные ответы поставщиков, которые нужны для полной пересборки, хранятся отдельно. [Состав пакета](S3_04_DL30_SWISS.md#пакет-для-проверки-владельцем)

## Обмен отчётами по имени

Когда команда на любом ПК сохранила отчёт, его можно опубликовать в той же приватной базе. Для публикации требуется право записи файлов из таблицы выше. Имя отчёта берётся из имени файла, а передача сверяется по SHA-256.

```powershell
$report = '.tools/pc2-exposure-source-recheck.json'
$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $report).Hash.ToLowerInvariant()
node --env-file=.env tools/research/shared-research-artifact.mjs publish-report $digest $report
```

Другой ПК видит имя, формат и SHA в каталоге. Для скачивания по имени используется свободный локальный путь. Если имя использовано повторно с другим содержимым, по имени скачивается последний опубликованный вариант. Прежний вариант доступен по его SHA через `get`.

```powershell
node --env-file=.env tools/research/shared-research-artifact.mjs list-reports
node --env-file=.env tools/research/shared-research-artifact.mjs get-report series-pc2-offline-reconciliation-20261123.json .tools/pc2-offline-shared-copy.json
```

Файл и запись каталога появляются одной транзакцией. Публикация повторного файла с тем же именем и SHA возвращает `already_published`. Каталог входит в обычный бэкап файлов. Допуск ID в список исключений проверяется отдельно по содержимому отчёта.

## Резервная копия и восстановление

Первый ПК запускает задачу Windows `Dota Research Registry Backup` в **04:30 МСК**. Ей нужен сеанс пользователя. Планировщик подбирает пропущенный запуск при первой возможности. Скрипт открывает отдельный туннель на порту 55434 и копирует обе таблицы из одного снимка PostgreSQL. Архив и JSON с SHA-256 и перечнем ревизий и файлов сохраняются в `.tools/research-vps-backups`.

```powershell
Start-ScheduledTask -TaskName 'Dota Research Registry Backup'
# После завершения
Get-ScheduledTaskInfo -TaskName 'Dota Research Registry Backup'
Get-Content -LiteralPath '.tools/research-vps-backup.last.log' -Tail 3
```

Код `0` означает успешное завершение. Для восстановления создайте отдельную пустую PostgreSQL и примените миграции проекта по 076 включительно. Сверьте результат `Get-FileHash -Algorithm SHA256` со значением `sha256` в JSON рядом с архивом. Восстановите данные в выделенную тестовую базу и сравните её ревизии и SHA пакетов с тем же JSON.

```powershell
& .\.tools\pgsql\bin\pg_restore.exe -h 127.0.0.1 -p RESTORE_PORT -U RESTORE_USER -d EMPTY_RESTORE_DATABASE --data-only --no-owner --no-privileges --exit-on-error 'PATH_TO_BACKUP.dump'
```

Выполненная проверка восстановления подтвердила две ревизии и точные байты пакета r1. Старые архивы до миграции 076 могут содержать только список исключений. [Задача резервного копирования](../tools/research/backup-shared-registry.ps1)
