# Подключение Git к проекту (Windows / VS Code)

Репозиторий: https://github.com/Ritle/dotaanalitic
Ветка разработки: `main`.

## Рекомендуемый вариант — клонировать существующий репозиторий

Откройте PowerShell в VS Code или терминале:

```powershell
cd C:\Users\funnk\Desktop\dota2analytics
git clone https://github.com/Ritle/dotaanalitic.git
cd dotaanalitic
code .
git remote -v
git status
```

Этот вариант предпочтителен: история коммитов и remote уже настроены. Если исходная папка с распакованным старым архивом больше не нужна, предварительно перенесите свои несохранённые изменения вручную (не удаляйте без проверки).

## Если нужно привязать уже существующую папку с файлами

**Сначала создайте резервную копию папки.** Если `git status` уже работает, Git инициализирован; повторный `git init` не нужен.

```powershell
cd C:\Users\funnk\Desktop\dota2analytics\dota2-pro-analytics-codex
git init -b main
git remote add origin https://github.com/Ritle/dotaanalitic.git
git fetch origin main
git reset --mixed origin/main
git status
```

`git reset --mixed` привязывает историю к удалённой ветке, но **оставляет содержимое рабочей папки** — различия от GitHub покажет `git status`. Не выполняйте `git reset --hard`, чтобы не потерять локальные изменения.

Если `origin` уже существует:

```powershell
git remote -v
git remote set-url origin https://github.com/Ritle/dotaanalitic.git
```

После сверки изменений, если у вас есть собственные необходимые правки:

```powershell
git add -A
git commit -m "chore: sync local development changes"
git push -u origin main
```

Если изменений нет, коммит не нужен. Не добавляйте `.env`, ключи доступа, `node_modules` и локальные отчёты API; они исключены `.gitignore`.

## Первый запуск для Codex

```powershell
corepack enable
pnpm install
# pnpm-lock.yaml должен быть создан реальной командой install и добавлен отдельным коммитом
Copy-Item .env.example .env
pnpm verify:migrations
pnpm verify:docs
pnpm db:up
pnpm db:migrate
pnpm dev
```

Затем откройте `AGENTS.md` и `CODEX_V7_START_PROMPT.md`. Codex должен проверить конфигурацию и зафиксировать в `docs/PROGRESS.md` реальный статус выполненных проверок.

Если используется GitHub через SSH, вместо HTTPS можно указать `git@github.com:Ritle/dotaanalitic.git`, предварительно настроив SSH-ключ.
