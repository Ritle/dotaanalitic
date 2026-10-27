# Codex: работа с задачами и передача контекста

## Перед задачей

1. Прочитать `AGENTS.md`, `docs/PROJECT_STATE.md`, нужный раздел `docs/IMPLEMENTATION_PLAN.md` и **только относящиеся** к изменению специализированные документы.
2. Проверить реальное состояние файлов, `git status`, тестов и данных. Не принимать галочки за доказательство выполненной реализации.
3. Назвать идентификатор задачи (например, S0-01), DoD, затронутые модули, риски для point-in-time и source provenance.
4. Однократно предложить выбор модели по `docs/CODEX_MODEL_ROUTING.md`, если сложность того требует. Не переключать модель молча.

## Во время задачи

- Один вертикальный срез; миграции additive/forward-only, границы провайдеров и feature builder не обходить.
- Для каждой ошибки в импорте, roster, patch, ML cutoff или доступности героя сначала написать failing test на синтетической фикстуре.
- Если PostgreSQL / npm / API недоступны, честно зафиксировать **blocked**; не имитировать успешный запуск.
- Не запускать production обучение из веб-запроса и не изменять предыдущие предсказания.

## После задачи

1. Точный перечень изменённых файлов и последствия для API/DB.
2. Команды **реально** запущенных тестов и их результаты (PASS/FAIL/BLOCKED).
3. Обновить `docs/PROGRESS.md` (append-only) и `docs/PROJECT_STATE.md` (краткий текущий снимок).
4. Отмечать `[x]` в плане только при выполненном DoD. Следующая задача указывается одной строкой.
5. Не коммитить секреты, сырые приватные данные, синтетические артефакты как действующие модели.

## Шаблон handoff (в PROGRESS)

```
### YYYY-MM-DD — Sx-yy
Goal / implemented / changed files:
Checks actually executed (PASS / FAIL / BLOCKED):
Architecture constraints reviewed:
Known blockers / migrations / compatibility:
Next task / precise entry point:
Suggested model / effort (optional):
```
