# Продолжение проверки загруженной истории

Срез `S2-01/role-owner-check/history-enrichment-resume` дополняет [первичную подготовку](S2_01_HISTORY_ENRICHMENT.md). Он не запускает прогноз или обучение.

## Использование

В выбранном составе откройте **«Изменить игроков и роли» → «Личная pro-история A/B»**. После завершённой загрузки с принятыми картами появляется **«Продолжить проверку загруженных карт»**. Действуют показанная пауза, блокировка активного задания и проверка пяти числовых аккаунтов. Период/глубина выбирают отдельную историю.

Кнопка проверяет недостающие аккаунты участников, серии и пригодность прежних карт для Elo. Поиск карт, match-detail, heroes/leagues HTTP не выполняются. Числовые профили могут запрашиваться в пределах прежних ограничений; quota, lease, кэш и negative cooldown сохраняются. Дополнительные карты загружаются отдельной кнопкой «Загрузить историю игроков».

Результат **«Повторно проверено N из M карт»** отделён от первичного импорта. Исходное окно загрузки сохраняется; свежий raw/eligible N имеет собственное время. Unknown/partial не превращаются в нулевой опыт или вероятность.

## Scope, очередь, отчёт

- Owner/session/CSRF POST `/api/v1/players/history-refresh/resume` принимает только `{runId}`. Клиент не задаёт произвольные карты или чужой scope.
- Используется прежняя очередь `opendota-player-history`, совместная блокировка пятёрки/параметров и cooldown. Одновременные запросы получают одно задание; изменившиеся/конфликтные аккаунты блокируются.
- Новое задание `operation:evidence_resume` ссылается на первоначальный import через `parent_run_id`. Scope — accepted/duplicate map IDs исходного отчёта, не более 50; SQL сверяет владельца, bindings, options и scope.
- Повтор следующей проверки использует первоначальный scope: ошибка предыдущего продолжения не удаляет карту из последующих проверок. Оригинальный отчёт не переписывается; терминальные resume reports и родитель после создания продолжения защищены.
- Ещё не проверенные профили получают очередь перед cached private/failed. Пределы 100 неизвестных аккаунтов/20 profile accesses и 42 HTTP attempts, включая registry/retries, не увеличены.

## Явное происхождение проекций

Старый импортёр хранит нормализованную проекцию, а не исходные bytes OpenDota. Ей **не назначается SHA оригинального ответа**.

1. Source audit первоначального задания связывает endpoint/map ID, SHA и fetched_at с конкретным accepted/partial receipt. Hero/league references берутся из quality assessment этого receipt.
2. Проверяются положительный pro tier, завершение до исходного fetched_at, event_at, десять различных Steam32 и native slots. Конфликтная карта или отсутствующий source/reference не вызывают скрытый сетевой fallback.
3. Производные observations получают adapter **`stored-history-projection-v1`**, собственные bytes/SHA и время деривации, attempts=0. В raw body добавляется `_history_projection` с parent receipt/SHA/fetchedAt/reference IDs. Это локальная деривация, а не новый ответ провайдера.
4. Неизменённый `IngestionService` повторно проверяет проекцию после новых identity/series proofs. Новая `player_history_projection_replays` связывает run/attempt/map с parent и derived receipts, SHA/time и reference IDs; UPDATE/DELETE/TRUNCATE lineage запрещены.
5. Исходные receipt/SHA/event_at/known_at/fetched_at сохраняются. Поздний proof не доказывает историческую доступность; действуют conditional V1 правила без backdating или обхода strict cohort.

При отсутствии audit/reference показывается `STORED_PROJECTION_UNAVAILABLE`; автоматического повторного скачивания нет. Обычная новая загрузка остаётся отдельным явным действием владельца.

## Совместимость и качество

Миграция **043_player_history_resume.sql** добавляет operation/parent/scope в runs и append-only lineage. SQL001–042, frozen kernel, 150 исходных runtime modules и старые release artifacts не меняются. Report **v4** требует operation/parent; v1–v3 читаются с прежним смыслом. Optional operation/parent/canResume расширяют ответы обратно совместимо.

Повтор не создаёт новых canonical maps или дубликатов identities/series. Для нового наблюдения/attempt допустимы новые derived receipts/lineage той же карты; это не новые независимые тренировочные примеры. После прохода существующий runtime builder считает свежий raw/eligible N. Синтетические fixtures по-прежнему не допускаются к production history/model gate.

Pure/PG/API/browser regression проверяют provenance, часы, owner/CSRF, cooldown/concurrency, scope/immutability, отсутствие повторных HTTP, идемпотентность фактов, legacy gaps, конфликты аккаунтов, batch progress и сохранение ручной пятёрки. Реально выполненные проверки и bounded live run фиксируются в evidence/PROGRESS после QA. Готовность истории не означает passed model gate.


## Выполненная проверка 5 ноября 2026

Frozen offline install, root typecheck/build,822 unit/CLI,74 Node,43 уникальных PG/API +6 финальных повторов guard suite,11 Chromium — PASS. После последнего пояснения о недоступном source повторены web typecheck/build. На рабочей YeS—GL для GamerLegion продолжены25/25 карт:0 ошибок/конфликтов/новых карт,0 profile requests и0 HTTP в resume;51 аккаунт уже был подтверждён. Eligible N25/25/25/57/25, выбор пятёрки сохранён, desktop/360px без ошибок/переполнения.

Миграция043 применена, API28448 и отдельный worker19020 работают. Сохранены242 protected files,150 исходных runtime modules/frozen bundle,340 карт/3400 слотов,1238 старых receipts/9 старых reports и3 других queue jobs. Модели/evaluations/forecasts не менялись, active0. После завершения действует обычный cooldown15 минут, отображаемый в интерфейсе. [Evidence](evidence/s2-01-history-enrichment-resume-r2.json). Общий owner-check других пятёрок и независимый release gate не объявляются завершёнными. Следующий срез — **S4/V1-schedule-freshness**, GPT-6.1 Sol · High.


Финальная recovery-проверка: если worker остановился до записи отчёта, кнопка продолжения использует уже закреплённый scope карт. Полный проход822 unit/CLI дополнен1 новой уникальной регрессией (итого823), PG/API43 дополнен1 новым случаем (итого44); финально повторены6 targeted units и7 resume PG/API. DB build и чтение сохранённого реального отчёта в новой версии UI/API — PASS. Старый evidence сохранён, финальный результат — [revision2](evidence/s2-01-history-enrichment-resume-r2.json). Текущие API4604 и отдельный worker17732.
