# S4-02/V1 — полный browser suite владельца

Checkpoint 2026-11-03. Запускается весь существующий Playwright suite текущего localhost V1, не выборочный smoke. Контрольный список содержит57 tests в26 files; один Chromium worker, без автоматических retries и изменения существующих timeout. Штатный `pnpm test:e2e` сначала собирает API и shared dependencies.

## Изоляция и область проверки

Vite использует5179 и API3151, отдельные временные PostgreSQL БД с синтетическими source-shaped данными и случайными test owner passwords. Рабочие3000/5173, owner credentials, рабочий worker и queued Aurora refresh не используются. Provider clients тестовых обновлений подменены явно; synthetic display fixtures не считаются реальными прогнозами или качеством модели.

Suite покрывает login/session/CSRF/logout, клавиатуру и360px layout, каталог/аналитику/сравнение/драфт, pairs/counters, историю и partial refresh, журнал, модель readiness и недоступные расчёты, выбор турнира/встречи, ручные5v5, source/target/runtime/result/lifecycle flows. Потеря ответа повторяет тот же request UUID/body, старые ответы не меняют новый выбор, исправления исходов не переписывают frozen reports. Отдельный compiled CLI/API journey проверяет сохранение состояния после перезапуска API и выхода.

Мобильные снимки `model-readiness-mobile.png` и `journal-mobile.png` просмотрены: статус отсутствующей модели виден, null metrics приN=0 не заменяются числом; новых визуальных дефектов на этих снимках не обнаружено. Полный visual review каждого состояния этим не заявляется.

## Команды и результат

```powershell
pnpm test:e2e
```

Использованы существующие локальные pnpm10.19.0 и Chromium cache `.tools/playwright`; для Windows установлены `COREPACK_HOME=.tools/corepack`, `COREPACK_ENABLE_NETWORK=0`, `PLAYWRIGHT_BROWSERS_PATH=.tools/playwright`, локальный pnpm shim добавлен в PATH. Сбор списка перед запуском: `node --env-file-if-exists=.env apps/web/node_modules/@playwright/test/cli.js test --config apps/web/playwright.config.ts --list`.

Полный pnpm test:e2e —57/57 PASS в26 files,6.5m, exit0. Список каждого выполненного case совпал с исходным list57; automatic retries0, skipped0, source/test/config/timeouts unchanged. Playwright last-run:passed/failedTests:[], сохранён отдельный case manifest. Показанные внутренние истории refresh — synthetic jobs временных БД, не рабочая Aurora. Нефатальные NO_COLOR/FORCE_COLOR warnings не изменили успешный exit code.

Frozen offline install/typecheck/build,730 unit/CLI и64 serial Node PASS без повторов и изменения limits. Существующее предупреждение Vite о размере web chunk сохранено; API/web/ML source не менялся. Отдельный PG suite в этом срезе не повторялся: browser suite использовал реальные временные PostgreSQL БД и HTTP handlers; historical50 PG PASS сохранены предыдущим checkpoint. Python/Docker/VPS/remote CI не запускались.

Сохранены64 PNG в игнорируемой `.tools/s4-e2e-screenshots`, два мобильных снимка просмотрены. Все78 before/after working relation fingerprints(public65+pgboss13), queued Aurora/team321 с attempt/processed/accepted/retry0 и started_on null,39 protected artifacts/34 SQL ledger SHA/старый report/весь existing runtime/frozen bundle unchanged, compatibleRuntime:true. Working active/scenarios/predictions/snapshots/release/E1/activations0, artifacts1/reports1. Provider/training/real evaluation/activation0. Evidence: `docs/evidence/s4-02-v1-full-owner-e2e.json`.

Совместно с historical regression и прежним native queue restore закрыт **S4-02 в текущей localhost V1 области**. Реальная независимая оценка модели, active-model restore и production deployment gates остаются отдельными открытыми условиями.

## Условия выпуска

Полный проход localhost suite не заменяет independent Tier1 release test, gate активной модели, restore с действующей реальной моделью или Docker/VPS/HTTPS проверку. Синтетические samples служат проверке поведения, не оценке accuracy. Native backup/restore с pg-boss уже проверен отдельным [checkpoint](S4_01_V1_QUEUE_COVERAGE.md); новый restore drill в этом срезе не запускается.

**Следующий точный срез — S4-03/V1-deployment-preflight:** локально сверить production конфигурацию, доступные инструменты и воспроизводимость подготовки к развёртыванию; без фактического deploy/публикации и активации модели. Рекомендуемая модель: **GPT-6.1 Sol · High**.
