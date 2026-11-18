# S3-04 — экспорт сохранённых исследовательских расчётов

Срез `post-draft-validation-readiness/committed-shadow-export`, 14 ноября 2026.

## Результат

Новый read-only CLI выгружает цепочку SQL058–061: сохранённый драфт, наблюдение истории, попытки привязки к фактической карте, результат расчёта и подтверждение завершённой записи. Проверка воспроизводит числа по сохранённому кандидату и входам, затем сравнивает с записанным результатом. Прогнозы, историю и модель в рабочей БД она не изменяет.

Владелец продолжает сохранять полный драфт обычным действием в Draft Lab. Исследовательская запись создаётся автоматически предыдущим срезом. Экспорт нужен разработчику для независимого теста и диагностики; новых пользовательских форм нет.

## Команды

После обычной сборки монорепозитория и подготовки прежнего prospective replay runtime:

```powershell
node node_modules/typescript/bin/tsc tools/research/player-hero-prospective-features.mts tools/research/player-hero-inference.mts --strict --noUncheckedIndexedAccess --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --types node --typeRoots packages/db/node_modules/@types --outDir .tools/s304-prospective-features-runtime
node --env-file-if-exists=.env tools/audits/draft-committed-shadow.mjs capture .tools/my-committed-shadow.json
node tools/audits/draft-committed-shadow.mjs verify .tools/my-committed-shadow.json <SHA_ИЗ_CAPTURE>
```

`capture` возвращает SHA и счётчики, а не исследовательские вероятности или исходные приватные данные. Сохраните SHA отдельно. `verify` работает offline, без БД, API провайдеров или чтения текущего candidate-файла. Используется точный кандидат из SQL061. Текущая реализация и environment должны совпасть; другая версия кода требует восстановления прежнего окружения, а не переписывания digest сохранённой записи. Смешанные implementation revisions в одной выгрузке пока отклоняются; для них будущему коллектору понадобится версионированный replay, без потери старых попыток.

Файлы разрешены только внутри `.tools`, включая проверку реального пути родительской папки. Перезапись запрещена. Артефакт содержит приватные исходные снимки; он не предназначен для публикации. SHA/replay обеспечивают проверку целостности и воспроизводимости относительно доверенного исходного SHA, но не являются внешней аутентификацией БД или доказательством времени начала игры.

## Проверяемые инварианты

- Все таблицы читаются в одной `REPEATABLE READ / READ ONLY` транзакции. Ничего не подгружается из провайдеров, отсутствующие записи не создаются.
- Проверяются SHA, владельцы, scenario/revision, соответствие observation/capture, порядок UTC-времён с микросекундами, уникальность ссылок и воспроизводимость SQL059-привязок.
- Каждый SQL061 result проверяется с теми же входами, candidate text, implementation digest и временем расчёта. Отличие любого результата, включая причины unavailable и списки исключений, отклоняет экспорт/replay.
- Receipt должен ссылаться на существующий result SHA, иметь другой top-level transaction ID и время между записью результата и экспортом. Receipt не превращает запись в допустимый pre-gameplay пример.
- `missing`, `awaiting_receipt`, `computed_shadow_only` и `unavailable` сохраняются отдельно. Расчёт без receipt не попадает в число подтверждённых расчётов. Записанные unavailable не заменяются новым вычислением после появления данных.
- Поздняя native-привязка не пересобирает frozen features и не меняет числа. Все попытки привязки остаются в source и отчёте.
- Одна actual map считается один раз. Диагностический представитель выбирается среди подтверждённых численных расчётов с verified native binding: минимальное время receipt, затем run ID. Все остальные попытки сохранены. Это не выбор primary forecast: `primaryEligible:false`, `trainingExamples:0`.

Source validation переиспользует прежний SQL058–060 audit. Его диагностические признаки, зависящие от native binding, не используются в новом результате: числа берутся только из SQL061 и сверяются с прежними frozen входами. Реальные исходы целевой карты не превращаются в признаки.

Ограничения одного экспорта:100 captures,100 observations/links/runs/receipts,1000 binding attempts,120MiB суммарных исходных текстов; JSON source/output до256MiB. При превышении — явный отказ, без усечения и выборки удобных строк. Это bounded local export, не полный collector будущего независимого окна.

## Проверки и допуск

Новые файлы: `tools/audits/draft-committed-shadow{,-core}.mjs`, API unit/PG integration tests. Production API/UI, миграции, математические kernels, кандидаты и прежние frozen exports не изменяются. Доказательства выполненных проверок — в [evidence](evidence/s3-04-committed-shadow-export.json).

Реальный read-only экспорт r2 на17:41:47UTC:0 captures/runs/receipts/observations/links/bindings,0 численных попыток. V1 model_eligible,2260карт,7 прежних prediction hashes,61 migrations и все строки цепочки сохранены; API/Web200/private401. Источник с положительными численными результатами пока есть только в синтетических тестах. Первоначальный r1 оставлен как checkpoint; r2 закрепляет проверку существования history link уже к началу вычисления, а не только к записи результата. Ранее записанные рабочие данные не менялись.

Целевые проверки после сборки (PG-тест создаёт отдельную временную БД):

```powershell
pnpm --filter @dota/api exec vitest run tests/draft-committed-shadow.test.ts --maxWorkers=1
node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run apps/api/tests/draft-committed-shadow.integration.test.ts --maxWorkers=1
```

Охвачены positive replay, empty/missing/unavailable/awaiting состояния, поздняя привязка, повторные попытки одной карты, владельцы и микросекундные границы, подмена результатов с пересчитанными SHA, запрет перезаписи и offline verify с нерабочим DATABASE_URL. UI/browser и Python suites отдельно не перезапускались: интерфейс и математика не менялись.

Экспорт не регистрирует окно и не активирует H2. По-прежнему необходимы проверяемая граница начала игрового процесса, полный exposure/denominator, выбранные scope/window и независимый quality gate. Разные сохранённые сценарии одной карты не увеличивают обучающую выборку.

**Следующая задача: S3-04/post-draft-validation-readiness/gameplay-boundary-evidence.** Проверить по реальным свидетельствам источников, как отличить конец драфта и начало игрового процесса; определить, какие сохранённые попытки можно считать сделанными вовремя. Не подменять это расписанием или временем записи в БД. **GPT-6 Astra · High.**
