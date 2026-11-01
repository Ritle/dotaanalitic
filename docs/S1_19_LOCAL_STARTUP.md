# Локальный запуск и первый вход — S1-19

Для текущего Windows checkout: `C:\Users\funnk\Desktop\dota2analytics\dota2-pro-analytics-codex\dotaanalitic`.

## Первый вход

По явному запросу владельца локальный аккаунт уже создан через existing owner CLI. URL, логин и пароль находятся только в `.tools/private-owner/access.json` (ignored Git, NTFS-доступ только текущему Windows-пользователю). Откройте файл локально и войдите на http://localhost:5173. Повторно запускать создание владельца в этой БД не требуется. Реальный Chromium вход/private API200/страница расписания/выход/private401 проверены.

Существующая `.env` уже настроена, PostgreSQL запущен, миграции001–020 применены. Не копируйте поверх неё `.env.example` и не переинициализируйте `.tools/pgdata`.

Для новой пустой БД без владельца создание через **локальный PowerShell**:

```powershell
Set-Location -LiteralPath 'C:\Users\funnk\Desktop\dota2analytics\dota2-pro-analytics-codex\dotaanalitic'
node --env-file-if-exists=.env apps/api/dist/modules/auth/owner-cli.js create
```

CLI попросит логин и дважды пароль длиной12–128 символов. Ввод пароля скрыт. Пароль не нужно передавать аргументом, записывать в `.env` или сообщать в чат. Это собранный существующий owner CLI; `pnpm owner:create` выполняет то же после сборки shared packages. Второй аккаунт запрещён.

Откройте **http://localhost:5173** и войдите с выбранными данными. Используйте именно localhost:5173, как в WEB_ORIGIN; API слушает127.0.0.1:3000. До входа private API возвращает401 — это ожидаемо. Проверка первого входа выполнена после CLI provisioning, отдельно от health endpoint.

После входа: «Предстоящие матчи» → загрузить расписание → выбрать встречу → вручную выбрать canonical организации/игроков/роли → подтвердить состав → сравнить или сохранить сценарий. Обновление pro-истории требует запущенного worker. Состав заявки не заполняет canonical IDs автоматически. Прогнозы пока недоступны: model gates остаются открытыми.

## Повторный запуск

Из корня проекта в PowerShell, если pnpm не доступен глобально:

```powershell
$env:COREPACK_HOME=Join-Path (Get-Location) '.tools\corepack'
$env:Path=(Join-Path (Get-Location) '.tools\bin')+';'+$env:Path
pnpm preflight:strict --require-db
pnpm dev
```

`pnpm dev` запускает API и web в watch-режиме. В другом терминале из того же каталога с теми же двумя строками подготовки pnpm выполните `pnpm worker:dev`. Остановить foreground запуск можно Ctrl+C в соответствующих терминалах. Перед повторным запуском освободите старые экземпляры на3000/5173; Vite использует strictPort.

Для проверки API: `pnpm smoke` или `http://127.0.0.1:3000/health`. Health не заменяет вход владельца, проверку worker или качество данных. Native PostgreSQL16 используется без Docker; отсутствие Docker Compose не блокирует локальный dev. Для этого checkout WEB_ORIGIN=http://localhost:5173 и API_PORT=3000 согласованы с Vite proxy. При изменении API_PORT задайте также API_PROXY_TARGET для web.

## Проверенный статус

Реальные результаты preflight/migration replay/сборки/HTTP/browser/worker и PID background запуска фиксируются в [PROGRESS](PROGRESS.md) и [PROJECT_STATE](PROJECT_STATE.md). Логи и manifest локальных фоновых процессов находятся только в ignored `.tools`; пароль в логи не выводится. Отдельный файл доступа создан по прямому запросу пользователя и не коммитится. Запуск worker с пустой очередью не инициирует импорт сам по себе. S1-19 завершена: owners1 и настоящий первый вход проверены.

Публичных listeners/deploy, synthetic pro-данных, запуска обучения или активации модели не добавлено. Модель для дальнейших UI-доработок — **GPT-6.1 Sol · Medium**.
