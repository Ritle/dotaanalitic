# S2-07/reader-ui — рейтинговая практика в карточке игрока

Текущий этап2026-11-06: [таблица практики по героям](S2_07_RANKED_HERO_SUMMARY.md) добавлена для validated OpenDota v2, с отдельными N/wins/WR/recency. Этот документ ниже сохраняет исторические результаты availability UI до подключения summary; последующие source-control и hero-summary завершены.

Источник требований: [§0.8](../TECHNICAL_SPEC.md), [backend reader](S2_07_RANKED_PRACTICE_READER.md). Этот срез показывает доступность текущей рейтинговой истории; геройские агрегаты пока не включены. [Проверки, hashes и live acceptance](evidence/s2-07-ranked-ui.json).

Текущий source checkpoint: [OpenDota v2/Dendi197 ranked-карт](S2_07_RANKED_COVERAGE_CONTROL.md). Пустые live cases этого UI checkpoint ниже остаются историческими фактами проверки. Непустая выборка теперь доступна в карточке61; текущий следующий срез — S2-07/hero-summary.

## Как пользоваться

1. Откройте игрока из справочника или по ссылке на его canonical карточку. Например, локальная карточка Yatoro: `http://localhost:5173/players/20`.
2. Под профессиональной статистикой героев раскройте **«Рейтинговая практика»**. Блок изначально свёрнут; раскрытие проверяет сохранённые данные выбранного источника.
3. Выберите OpenDota или STRATZ. Для STRATZ нужна настройка backend token; неподключённый источник объясняется в блоке. Смена источника сама не загружает историю из внешнего API.
4. Нажмите **«Загрузить рейтинговую историю»** либо **«Обновить рейтинговую историю»**. Обновление одного игрока использует существующий bounded reader. Пока запрос выполняется, повторная кнопка и смена источника заблокированы.
5. При наличии observation видны его точный30-дневный период/время обновления и число пригодных карт, если они есть. В **«Покрытие рейтинговой истории»** раскрываются полученные строки, пригодные карты, ограничение/прерывание выдачи, дубликаты/конфликты, причины исключения и verified Steam32.

Всё время подписано UTC, как в других отчётах. Период и фильтры профессиональной статистики не меняют pub-окно: здесь фиксированы текущие30 суток и ranked All Pick.

Пустой результат означает «Данные рейтинговых игр за период не получены». Это не утверждение, что игрок не играл или не умеет играть на герое. Полнота всей истории остаётся неизвестной даже при просмотренной выдаче провайдера. **WR/бонусы к вероятности/геройские оценки в этом срезе не показываются.**

## Обработка состояний

- Неподтверждённый/конфликтующий аккаунт, disabled/unconfigured source блокируют загрузку и объясняют причину. Другой источник можно выбрать отдельно.
- Устаревшее observation остаётся видимым с датой и отметкой stale. При cooldown кнопка включается после указанного retryAt; часы интерфейса не запускают HTTP.
- При обновлении, уже запущенном другим запросом, есть **«Проверить результат обновления»** — только чтение сохранённого результата.
- Сетевой/HTTP сбой показывает русское сообщение и **«Повторить проверку»**, которое повторяет cache-only read. Некорректный report и несовпадение player/provider не выводят raw payload.
- Навигация/смена источника используют отдельные query keys; задержанный ответ другого источника не подменяет текущую карточку. Manual refresh сохраняет captured player/provider key, при unmount его browser request отменяется.

## Реализация

`RankedPractice.vue` добавлен только в player-ветку EntityView рядом с профессиональным PlayerHeroReport. Native details/summary поддерживают клавиатуру; controls используют существующие design tokens, responsive wrap и44px targets. Блок по умолчанию свёрнут, отдельная форма выбора игроков не нужна.

Vue Query: ключ `ranked-practice/playerId/provider`, staleTime60s, gcTime5min; refetchOnWindowFocus/refetchOnReconnect и retries выключены. Ни таймер cooldown, ни переключение источника не передают refresh=true. Чтение использует owner CSRF и существующий backend endpoint. Источники не объединяются в клиенте; storage/model/API контракт не менялся.

Три UI-client unit tests проверяют cache-only payload/CSRF, отклонение чужого player/provider/некорректного ответа и обработку401/сбоя транспорта. Семь Chromium tests используют отдельную synthetic PostgreSQL database и один тестовый owner login; покрывают collapsed/no-request, real negative cache с fake provider, источник без side effects, capped/unknown coverage, cooldown без автообновления, identity/source errors, transport retry, duplicate action guard, late response, concurrent-source refresh и360px.

Live acceptance использует существующую owner session без нового логина: Yatoro20 — collapsed→read→manual refresh→fresh replay→STRATZ cache-only→OpenDota; затем Collapse130. Только1 внешний OpenDota request,5 ranked endpoint calls; auto/provider requests при cache read/source switch/replay —0. Desktop/360px inspected; page errors/overflow0. Существующий backend вернул empty; это не положительный ranked-coverage аудит.

До/после77 public-таблиц: изменились только provider_quotas, ranked_practice_cache, ranked_practice_observations;74 таблицы полностью неизменны.340 pro-карт, canonical links, составы, модели и очередь сохраняются. Raw browser state/receipts/screenshots — только в ignored .tools/test-results, без credentials в документации.

Frozen offline install/root typecheck/build, **855 unit/CLI (3 новых) и7 Chromium** — PASS. Проверены45 прежних SQL checksum, внутренние Markdown links, whitespace diff,245 protected artifacts/150 original modules/frozen bundle/runtime compatibility. API/SQL/dependencies не менялись; рабочие API/Web/worker не перезапускались. Standalone API/PG, full Node/browser, Python/Docker/Linux suites не перезапускались. Браузерные тесты включают собственную изолированную PG fixture. Первые6 browser cases прошли, затем добавлен седьмой concurrent-refresh regression и повторён целевой suite; повторные проверки не увеличивают число уникальных тестов. Ошибок приложения/падений тестов в этом срезе не было; предупреждения Node о NO_COLOR/FORCE_COLOR и existing Rollup annotations не блокировали проверки.

Исторический следующий срез S2-07/ranked-coverage-control выполнен; текущий — **S2-07/hero-summary**, по [проверенному OpenDota v2 cohort](S2_07_RANKED_COVERAGE_CONTROL.md). Не расширять ranked-фильтр турнирными/Practice картами и не обходить закрытую историю. Если данных нет, доступность/описательная pro-аналитика продолжают работать. **GPT-6.1 Sol · High.** S2-07 в целом остаётся открытой.
