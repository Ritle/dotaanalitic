# S3-01/V1 — подготовка отдельного протокола двух турниров

6 ноября 2026. Продолжение [проверки выполнимости](S3_01_TIER1_PREFLIGHT.md). Реализована команда подготовки нового запроса без изменения старого плана, оценщика, модели или БД. [Намерение пересмотра](evidence/s3-01-v1-release-revision-intent.json) зафиксировано до начала событий; **это ещё не регистрация исполняемого теста**. ID основного DreamLeague30 отсутствует в последнем проверенном каталоге.

## Выбранное направление

Пользователь продолжил работу после предложения BLAST IX + DreamLeague30. Зафиксированы два main events, прежние100 карт/40 серий и все quality gates, warmup с2024-01-01, тот же development dataset и snapshot16декабря2026 03:00МСК. Новый тест охватывает все наблюдённые карты выбранных событий, без отбора удобных команд или результатов. Прежний однотурнирный план сохраняется как архив; выбирать лучший результат между старым и новым планом для активации нельзя. Эта политика выбора зафиксирована в intent; runtime старого архива не переписывался и отдельный механизм отзыва в registry не добавлялся.

[Календарь ESL](https://pro.eslgaming.com/tour/2026/09/introducing-dotas-ept-season-26-27/) подтверждает2–13декабря,24 команды, Swiss и выход8 команд в плей-офф. Конкретное число серий в проверенной странице прямо не задано; заявленные$180000 за Swiss при$2500 за победу в серии дают ориентир72 серии, если весь фонд распределяется по этому правилу. Это **расчёт из объявления**, не зафиксированная сетка и не обещание100 пригодных карт. Перед полным freeze требуется сверить опубликованный формат/UTC schedule и вместимость выборки; подготовка метаданных сама по себе эту проверку не закрывает.

## Что делает команда

`scripts/prepare-v1-release-revision.mjs`:

1. Проверяет SHA входного config, intent и capture каталога.
2. Полностью перепроверяет старый executable bundle существующим reader: plan, catalogue, development, candidate, freeze, код и Node. Код из переданного каталога не исполняется.
3. Сравнивает SHA quality policy старого плана с intent и текущей неизменной policy; запрещает изменение warmup/development dataset и позднюю подготовку с момента первого события включительно.
4. Проверяет source hash, реальные clocks и возраст каталога≤24ч. Дополнительные transport annotations не переносятся в новый plan catalogue.
5. Для известного ID требует его точное совпадение с ожидаемым названием. Для `null` ID ищет **единственную** запись с заранее закреплённым точным `catalogueName`; неоднозначность блокирует подготовку. Квалификации/Division2 запрещены уже в intent; нет fallback с ошибочного закреплённого ID на другой.
6. Возвращает `awaiting_event_binding` и exit3, пока не связаны все события. В этом случае **ни request, ни выходной каталог не создаются**.
7. При полной привязке возвращает `ready_to_register`; режим `prepare` создаёт отдельный каталог с `request.json`, нормализованным `catalogue.json`, `preparation.json` и SHA. Существующий каталог не перезаписывается. Это вход для прежнего planner, не сам зарегистрированный план.

Ни один режим не подключается к БД/API, не загружает карты, не считает метрики и не активирует модель. Во всех ответах `registrationPerformed:false`, `evaluationPerformed:false`, probability/metrics null, deployable false. Публичный контракт intent отдельный; прежний `V1ReleasePlanRequestSchema` по-прежнему требует настоящий numeric ID у каждого события. Неизвестный ID не подменяется заглушкой.

## Запуск на этом ПК

Из корня `dotaanalitic`, после сборки shared packages:

```powershell
$taskRevisionConfig = '.tools/v1-release-revision/inputs.json'
$taskRevisionSha = 'b1631cf30d9e18338bfd78e75ec4e3af742208d940ecd7737e0478cf0a301298'
node scripts/prepare-v1-release-revision.mjs check $taskRevisionConfig $taskRevisionSha
```

Реальный проход6ноября: BLAST league20208 найден, DreamLeague main не найден, `awaiting_event_binding`, exit3. Сохранённый `/leagues` получен6ноября11:35:38UTC; использован повторно без нового HTTP. В нём есть20359 **DreamLeague Season30 Qualifiers** — его нельзя подставлять вместо main event. И `check`, и `prepare` выполнены; выходной каталог не возник. [Evidence](evidence/s3-01-v1-release-revision.json).

При появлении main event получить новый каталог штатным ограниченным OpenDota client, сохранить новым файлом и создать **новый config/SHA**. Не переписывать старые captures/intent и не опрашивать API при каждом повторном просмотре. Каталог старше24ч команда отклоняет; это операторская проверка, фоновый polling не настроен. Если источник использует другое название, требуется явно записанный пересмотр metadata binding до начала теста, а не скрытый fuzzy match.

Config содержит `schemaVersion:1`, ссылки `{path,sha256}` на intent/catalogue и `previousBundle:{path,configSha256,freezeSha256}`. Пути задаются относительно рабочего каталога. Он локальный: сырые API captures/база/development dataset не публикуются.

После успешной привязки:

```powershell
node scripts/prepare-v1-release-revision.mjs prepare $taskRevisionConfig $taskRevisionSha .tools/v1-release-revision/prepared
```

`ready_to_register` означает только готовность source-bound request. Следом существующим `scripts/plan-v1-release.mjs create` зарегистрировать **новый** plan с реально текущей датой; создать новый kernel registration и полный executable freeze/bundle/collection. Использовать прежний model/policy code, не старую регистрацию, связанную со старым fingerprint плана. Старые файлы и registry records сохраняются. Не связывать старый collection или candidate registration с новым планом. Если операция записи прервалась, частичный каталог сохраняется для разбора; для новой попытки нужен новый путь.

Последний срок полного preregistration/freeze — строго до20ноября2026 03:00МСК. Если корректный ID/протокол не готовы, поздняя регистрация объединённого теста не допускается. Нужно новое ещё не начавшееся окно и отдельный intent; нельзя задним числом приписать полную регистрацию текущему документу. Нельзя предварительно оценить BLAST, затем подобрать дополнительное событие или thresholds.

## Проверка бюджета сборщика

Проверено существующее поведение, без новых коллекций и запросов:

| Ограничение | Для двух событий |
|---|---|
| Discovery runs | Не больше10 в отдельном новом collection |
| Запросы discovery | V1 запрашивает только активные закреплённые `/leagues/:id/matches`; до второго события1 endpoint/run, затем2 |
| Верхняя оценка discovery | До20 logical requests за10runs, до60 HTTP attempts с максимум3attempts на запрос; Retry-After и общие квоты сохраняются |
| Detail batch | До50 ID + `/heroes` + `/leagues`: до52 logical requests/156 attempts на одну партию |
| Детали D карт одного final union | `D + 2*ceil(D/50)` logical requests, до утроенного числа attempts |
| Candidate/inventory limit |5000, без тихого усечения;340 локальных карт в предыдущем снимке,4660 nominal headroom без учёта дальнейшего warmup |
| Повтор сбора | Новый discovery union имеет новую привязку; нельзя считать прежние detail captures подходящими автоматически |

Например, **операторский сценарий нагрузки**, не ожидаемая реальная выборка: D=500 →10 batches →520 detail requests/до1560attempts, плюс≤60 discovery attempts. Предельные5000 →5200 detail requests/до15600attempts; это нельзя считать допустимым однодневным запуском при daily budget2000. Дополнительная история расходует отдельную квоту. Планировать партии заранее и оставлять время до snapshot; completeness удалённого источника остаётся unknown. Изменять лимиты или переписывать collector сейчас не требуется, но пройти source/coverage gates после сбора всё равно обязательно.

## Проверки и остаток

Новые синтетические проверки покрывают pending main ID, квалификации/Division2, ошибочный закреплённый ID, повторяющиеся строки/ID, stale/future/tampered sources, deadline, подмену старого плана/порогов/истории, SHA входных файлов и exclusive output. Они не доказывают качество модели. Реальные сохранённые источники проверены отдельно без network/DB/registration. Полные выполненные команды и результаты — в evidence/PROGRESS; PostgreSQL/API/browser проверки не требуются для этого изолированного файлового CLI и не выдаются за выполненные.

**Следующий точный срез: S3-01/V1-evaluation/protocol-feasibility/binding** — после появления main-event metadata сверить ID/формат/окна, подготовить request и отдельно зарегистрировать plan/kernel/freeze/collection до первого события. Подготовка CLI/intent завершена, полная регистрация остаётся открытой. Для этой задачи по routing: **GPT-6 Astra · Extra High**. Ориентир16декабря — предложенный cutoff проверки, не дата гарантированного выпуска.
