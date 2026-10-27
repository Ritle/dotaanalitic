# Codex prompt — внедрение инженерных решений v5 без сноса существующего проекта

Прочитай `AGENTS.md`, `TECHNICAL_SPEC.md` и новые документы:

- `docs/TECHNICAL_ARCHITECTURE_AND_STACK.md`
- `docs/DEPENDENCY_MATRIX.md`
- `docs/ENGINEERING_PATTERNS.md`
- `docs/DATA_PIPELINE_DESIGN.md`
- `docs/ML_ENGINEERING_DECISIONS.md`
- `docs/DEPLOYMENT_AND_TESTING.md`
- `docs/TECH_DECISION_REGISTER.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `docs/PROGRESS.md`

**Цель:** привести текущую реализацию к инженерным решениям v5 постепенно, не ломая готовые функции и не вводя лишний функционал.

1. Проведи короткий аудит фактического состояния: какие пакеты установлены, какие задачи S0–S5 завершены по тестам, где расхождения с v5. Не верь чеклистам без кода и тестов. Выдай таблицу `решение / есть / нет / требуемая задача`.
2. Выбери **ближайшую незавершённую задачу по зависимостям** (`S0-00`, если работа не начата). Не реализуй все решения одним PR.
3. Сохраняй SQL-миграции `001..005` без изменений; новые структуры — новой forward-only migration. Не используй второй генератор миграций параллельно.
4. Придерживайся modular monolith: Vue/Vite/Fastify/Postgres, TypeScript analytics, planned `pg-boss` PostgreSQL worker, Kysely typed repositories. Новые пакеты ставь только на этапах, когда они реально нужны, после проверки compatibility/peer deps.
5. Для ML соблюдай point-in-time и различай подтверждённый до старта ростер от ретроспективно реконструированной пятёрки. Training labels — verified result профессиональной **карты**, не прогноз пользователя. Для baseline используй Python sklearn offline / TypeScript JSON inference только после доказанной golden-vector parity.
6. Каждая задача: конкретные файлы, unit+integration tests, CI/run commands, честные статусы `passed/failed/blocked`. Если модели ещё не валидированы, реальные p(win) в UI/API остаются `unavailable`.
7. Обновляй `docs/PROGRESS.md` с результатом и точным следующим Task ID. Не отмечай `[x]`, если приёмочный gate не пройден.

Сначала напиши план на 5–10 пунктов для **одной** следующей задачи. Затем реализуй её в репозитории и проверь доступные тесты. Не перегенерируй каркас проекта и не изменяй пользовательское ТЗ без явной причины.
