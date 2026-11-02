# S3-03/V1 — закрепление исполняемого оценщика

Срез 2026-11-02. `release:freeze create|verify|bundle` регистрирует полный manifest до начала test window и сохраняет отдельную исполняемую копию. Полный freeze связывает plan, kernel, quality policy, код и среду запуска. Это готовность оценщика к будущей проверке, не подтверждение качества модели или активация прогнозов.

## Что фиксируется

Артефакт `v1-release-executable-freeze-v1` содержит SHA и fingerprints плана/кандидата, quality policy SHA, даты регистрации/test/evaluation, synthetic provenance и отсортированный code manifest. Регистрация разрешена от `kernelRegisteredAt` включительно до `testFromAt` исключительно. CLI использует реальные часы; обратной датировки параметром нет. Каждая зависимость kernel должна присутствовать в полном manifest с тем же SHA.

Manifest включает compiled JS analytics/contracts/prediction/db/ingestion, все исполняемые scripts/helpers, SQL migrations, package manifests, pnpm lock/workspace и базовый tsconfig. Runtime закрепляет версию Node, платформу, архитектуру и SHA самого Node binary. `verify` повторно строит manifest из собственного списка каталогов; пути из непроверенного артефакта не исполняются. Несовпадение кода, среды или источников запрещает использование регистрации.

Это локальная проверка целостности и воспроизводимости. SHA и локальный timestamp не являются внешней подписью или независимым доказательством времени. Сторонние зависимости закреплены lockfile и устанавливаются `--frozen-lockfile`; их установленное дерево не архивируется целиком. Смена Node binary или кода требует отдельного решения о новой версии, а не обхода проверки старого manifest.

## Capture, отчёт и журнал

Config получает необязательное поле `freeze: { path, sha256 }`. Capture сохраняет полный manifest и `executableFreezeComplete:true`. CLI сверяет embedded manifest с точным артефактом, прочитанным по config SHA; другой manifest с корректным собственным хешем тоже отклоняется. Pure replay проверяет plan/candidate/code/registration bindings, CLI дополнительно проверяет фактический runtime.

Отчёт `v1-release-evaluation-v2` содержит freeze fingerprint/SHA. `releaseGatePassed:true` возможен только при завершённой, прошедшей quality policy, **несинтетической** source-bound оценке. При недостатке данных, неполном discovery или провале thresholds — false. `deployable:false`, пользовательская вероятность null и `MODEL_NOT_ACTIVE` сохраняются: активация — отдельный S3-05. Порогов, Elo-параметров и test window этот срез не меняет.

Legacy captures без freeze и отчёты v1 остаются читаемыми и всегда имеют releaseGate false. Журнал проверяет согласованность capture/report/freeze/scorer, запрещает downgrade и подмену. Первый committed result и все explicit revisions остаются неизменяемыми. SQL 001–024 не меняются; новая миграция не нужна. E1 journal и будущий пользовательский forecast journal — отдельные механизмы.

## Команды и отдельная копия

В рабочем checkout после сборки:

```powershell
pnpm release:freeze create config.json CONFIG_SHA new-freeze.json
pnpm release:freeze verify config.json CONFIG_SHA freeze.json FREEZE_SHA
pnpm release:freeze bundle config.json CONFIG_SHA freeze.json FREEZE_SHA new-runtime-directory
```

Output создаётся эксклюзивно. Bundle копирует только закреплённый код и plan/kernel/catalogue/development/freeze, затем создаёт `frozen/config.json` и возвращает его SHA. `.env`, credentials, node_modules и прочие рабочие файлы не копируются. Каталог с development data локальный, не предназначен для публикации. Частичный bundle после ошибки использовать нельзя; новый запуск требует нового пути.

В отдельном каталоге установить зависимости тем же pnpm по lockfile и запускать **напрямую Node**, без `shared:build` и pnpm aliases, которые требуют исходные TS-файлы:

```powershell
pnpm install --offline --frozen-lockfile
node scripts/freeze-v1-release.mjs verify frozen/config.json CONFIG_SHA frozen/executable.json FREEZE_SHA
node scripts/release-execute.mjs check frozen/config.json CONFIG_SHA
```

Offline install требует заполненного pnpm store; иначе обычный frozen install из registry. Workspace links должны вести внутрь bundle. Будущие discovery/detail refs в config остаются placeholders: `check` сообщает `sourceEvidenceChecked:false`. Для реальной оценки подготовить новый config с настоящими refs и новым SHA, сохранив pinned plan/kernel/freeze. DB credentials передаются локально через окружение; секреты не входят в manifest или публичные evidence.

Разработка основного приложения может продолжаться независимо от bundle. Старый оценщик запускается из отдельной копии с прежними зависимостями и Node. Сборка изменённого checkout не должна подменять его файлы.

## Граница готовности

Зарегистрированы [kernel r4](evidence/s3-03-v1-kernel-candidate-r4.json), SHA `d53f215a1617378d7a55321fa6665631d1d2fecfd6b251ecfa6822319161cfad`, и [полный manifest](evidence/s3-03-v1-executable-freeze.json), SHA `4b130ebdd0fe99cc41f27888dbe81ac5b222ff60ab0c6a3a19523de7b0d0163a`. Full manifest зарегистрирован2026-11-02T17:45:01.799Z, содержит232 файла. Предыдущие kernel r1–r3 сохранены. Сам kernel по-прежнему описывает только ядро; полный freeze удостоверяет отдельный артефакт.

Локальная рабочая конфигурация — `.tools/v1-frozen-release-files.json`; отдельная исполняемая копия — `.tools/v1-frozen-runtime`. В ней выполнены offline frozen install, прямые `verify` и `check`; workspace links проверены внутри bundle. SHA её `frozen/config.json`: `873cb15a5ad82524e6c98ad7a8ebbd4506045611f1a3f155d3ad5e0b344c7c41`. Копия ещё не содержит будущих source captures. pnpm пропустил lifecycle scripts argon2/esbuild/vue-demi; они не нужны для проверенного прямого Node-оценщика, bundle не является сборкой UI/API.

Реальные capture/evaluate/revise по прежнему плану доступны не раньше **2 декабря 2026, 03:00 МСК**. Регистрация полного кода должна быть завершена до **20 ноября 2026, 03:00 МСК**. Синтетические тесты проверяют алгоритмы и отказы, но не точность будущего турнира.

Следующий точный срез: **S3-05/V1-gate + S3-06/V1-snapshots**, начать с атомарной регистрации/активации/rollback по committed v2 report и проверки runtime coverage. До реальной независимой оценки активных моделей нет; S3-01/V1-evaluation и весь S3-03 остаются unchecked. Обязательный пользовательский S3-07/V1-journal выполняется отдельно до выпуска.

QA PASS: frozen install/typecheck/build,645 unit/CLI и37 isolated PostgreSQL tests,24 migration checksums, docs links/diff. [Evidence](evidence/s3-03-v1-executable-verification.json), SHA `a9aea953094d98b7431d27ff775c8d2923a8953c0a7977cb378396a732bd058a`.12 защищённых артефактов, E0 result,232 development feature rows и21 рабочая таблица неизменны; journals/models0. Проверены early capture/evaluate/revise, запрет перезаписи, runtime/code/artifact substitutions, legacy compatibility, synthetic/downgrade guards, сохранение и byte recovery. После исправления хеша в новой тестовой фикстуре затронутые наборы повторно прошли. E2E/Python не запускались, UI/HTTP/fitting не менялись.
