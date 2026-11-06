# S3-01/V1-retest/protocol — зарегистрирован второй исторический тест

6 ноября 2026,16:27:26.589UTC. **Протокол зарегистрирован, сбор деталей ещё не начат.** [Предложение](S3_01_V1_RETEST_PROPOSAL.md) реализовано отдельным форматом `v1-historical-retest-protocol-v2`; прежний `v1-historical-protocol-v1` и пакет первого failed test сохранены. Модель не активирована, новых вероятностей или quality metrics нет.

[Зарегистрированный протокол](evidence/s3-01-v1-retest-protocol.json): SHA `14353a129616d4757638ca91916aeb356e3944b45cdb64ab56cb8e21238452f1`, fingerprint `0d1518cc6446685ddabb4afb880fae72821e93c4aa8444ab1cdb834d853168a9`. [Проверки регистрации](evidence/s3-01-v1-retest-protocol-checkpoint.json).

## Что закреплено

Семь событий, их IDs и UTC-окна взяты непосредственно из сохранённого до discovery intent. Новый request не принимает произвольный список событий. Полные источники привязаны SHA; повторять семь запросов к OpenDota не нужно. Старый формат по-прежнему отклоняет больше пяти событий и не принимает v2 под видом v1.

- Исходный discovery:967 карт /490 известных серий.
- Прежний доступ исключает целые серии:297 карт /157 известных серий.
- Метаданные пригодны для дальнейшей проверки у666 карт /333 серий;4 карты без series ID остаются нерешёнными.
- Текущий знаменатель: **670 карт /333 известные серии**. Детали могут уточнить только доказанную связь с сериями; каждый исходный ID сохраняет disposition, пропуски качества не исчезают из знаменателя.
- Параметры Elo1500/K32/scale400 и historical quality policy SHA `f13ddd38c451fa53bae4f37ffaeea4c2ac852a4d50cb7cdd1156f53175737d4b` прежние. Протокол воспроизводит предыдущий policy из его исходных inputs, а не принимает новый набор порогов.
- Исходные first-scoring receipt/report/registry/freeze связаны между собой и новым протоколом. Первый результат остаётся **FAIL**; его нельзя заменить на PASS, убрать из регистрационной цепочки или выбрать лучший результат между ветками.

Источник остаётся неполным, а наличие метаданных не доказывает10 verified аккаунтов, pro outcome или ≥5 более ранних завершённых pro-карт каждому игроку. Сохраняются conditional reconstructed lineups, assumed event-time availability, отсутствие claims о prospective accuracy/familywise95. Ранее выбранная февральско-июньская выборка календарно предшествует первому августовско-сентябрьскому тесту; этот предел интерпретации записан в протоколе.

## Ограничения следующего сбора

| Условие | Зарегистрированное значение |
| --- | --- |
| История | Последние10 завершённых pro-карт на аккаунт за730дней до01.02.2026,00:00UTC; аккаунты числовым порядком, группами по5 |
| Общий warmup lower bound | 01.01.2024,00:00UTC; только `completed_at < target.started_at` для конкретного прогноза |
| Максимум уникальных карт | 5 000, без молчаливого усечения |
| Детали каждой карты | Не более3 HTTP-попыток, включая retries |
| HTTP-попытки за запуск | До50, включая общие quota/retry ограничения |
| Конец сбора | Все работы terminal **либо13.11.2026,00:00UTC /03:00МСК** |
| Оценка | Одна после terminal collection и проверки отдельного frozen bundle |

Ждать13ноября при завершённом сборе не требуется. Протокол запрещает промежуточные метрики, увеличение окна/попыток после scoring, автоматическую активацию и удаление missing targets из coverage. Число250 из предложения остаётся ориентиром планирования, не новым gate или условием выбора удобных серий.

**Важно для следующего разработчика:** текущий старый collector принимает только v1. Этот срез закрепляет правила и отказывает старому reader на v2; runtime enforcement попыток/deadline и terminal closure нужно реализовать в отдельном adapter с тестами до первого detail request. Регистрация сама не запускает job, scheduler, importer или evaluator.

## Воспроизведение

Новые файлы: `packages/contracts/src/v1-retest-protocol.ts`, `scripts/lib/v1-retest-protocol.mjs`, `scripts/plan-v1-retest.mjs`, `tests/node/v1-retest-protocol.test.mjs`. Существующие contracts/SQL/registry не расширялись молча. После сборки workspace:

```powershell
node scripts/plan-v1-retest.mjs verify `
  .tools/v1-retest-protocol-20261106/inputs.json `
  df251694f13f300ef0865b7a10a70c0422ac3e506d8e41910ba8f7760e58cbe9 `
  docs/evidence/s3-01-v1-retest-protocol.json `
  14353a129616d4757638ca91916aeb356e3944b45cdb64ab56cb8e21238452f1
```

`create CONFIG SHA NEW_PLAN` пишет только новый файл. Реальный повтор на тот же path вернул `OUTPUT_EXISTS`/exit1; SHA зарегистрированного протокола сохранился. `verify` проверяет исходные bytes, предыдущий протокол/первый результат, ledger и параметры повторным построением, без сети или нового model scoring. JSON ошибки на русском не раскрывают raw payload, credentials или внутренний stack.

Каталог проверяется на свежесть относительно **intent до discovery**; последующее чтение уже закреплённой исторической версии не вызывает polling каталога. Все даты registration/evidence/capture упорядочены; поздняя регистрация на/после deadline отклоняется. Повторная проверка ранее зарегистрированного протокола доступна и после deadline.

## Проверки и передача

Повторный локальный access audit перед регистрацией:5 461 JSON/body/JSONL файла,17 добавленных — только заявленные proposal artifacts; изменён только служебный checkpoint manifest со списком файлов, без новой статистики.83 public-таблицы рабочей БД не изменились; активных моделей0. Это bounded local review, не доказательство отсутствия внешнего человеческого знания результатов. Raw источники, локальный аудит и config остаются в `.tools`, публичный протокол содержит ссылки/SHA и агрегаты.

Результаты общих проверок и сохранности записаны в [checkpoint](evidence/s3-01-v1-retest-protocol-checkpoint.json): offline frozen install/typecheck/build,892unit/CLI и181Node PASS.10 новых Node cases проверяют seven-event registration, v1 compatibility, immutable first FAIL, scope/policy/deadline/denominator tampering, namespace/side/cutoff/unknown-series cases, игнорирование outcome полей, overflow и nested file/CLI hashes. Старый frozen replay сохранил FAIL;245 protected artifacts/373 frozen+current code files и first result hashes неизменны. Финальные83 public-таблицы/очередь сохранились,active0,API/Web200.0providerHTTP,без нового scoring,запуска worker или рестарта сервисов. PG integration/browser/Python/Docker/Linux suites не повторялись: persistence/API/UI/dependencies не менялись.

**Следующий точный срез: S3-01/V1-retest/collection** — v2 adapter к существующему resumable collector, общий учёт ≤3 попыток/карта, deadline/terminal closure, cache reuse и source replay; затем ограниченный реальный сбор по этому протоколу. Новых событий и новой настройки Elo не требуется. **GPT-6 Astra · Extra High**.
