# S2-07/ranked-coverage-control — непустая история и исправление проекции

Дата владельца:2026-11-06. Время source receipts сохранено в UTC. Задача выбрана вслед за [UI доступности](S2_07_RANKED_PRACTICE_UI.md), в пределах разрешённой S2-07 и [TECHNICAL_SPEC §0.8](../TECHNICAL_SPEC.md). [Raw SHA, планы, source/DB проверки и логи](evidence/s2-07-ranked-coverage-control.json).

## Вывод

**OpenDota предоставляет рейтинговую историю Dendi:200 полученных строк,197 пригодных карт за зафиксированные30 суток,25 известных героев.** Три строки старше нижней границы исключены. Предыдущий reader отклонял эти строки из-за ошибки запроса: explicit `project` не включал hero_id/duration. Это общий дефект OpenDota reader, исправленный без player-specific правил.

Пустые ответы прежних аккаунтов остаются фактами прежних проверок. Нельзя объяснять любую пустую историю приватностью: доступность зависит от конкретного источника/аккаунта. STRATZ вернул пустую ranked-выдачу того же Dendi, хотя OpenDota вернул непустую. `isAnonymous/isStratzPublic` не являются универсальным межпровайдерным доказательством доступа.

## Зафиксированный аудит

До HTTP проверены три **существующих verified** canonical связи: Speeed27→191362875, Dendi61→70388657, Saberlight89→126212866. Названия только для отображения, новые связи по nickname не создавались. Порядок и cap10 HTTP зафиксированы заранее; после результатов список игроков не расширялся. Выбор непустого account основан на доступности ranked/mode/time, не на героях или победах.

| Этап | HTTP | Результат |
|---|---:|---|
| STRATZ, latest20 visible maps каждого из трёх аккаунтов | 3 | По20 строк; только Practice/Captains Mode или Captains Draft,0 recent ranked |
| Независимая проверка OpenDota, те же accounts | 4 | Speeed/Saberlight пусты; Dendi200 ranked rows, но v1 rejected200 как invalid_row |
| Исправленный v2 OpenDota Dendi,2×100 | 2 |197 maps,3 outside_window,0 duplicate/conflict |
| STRATZ ranked reader Dendi | 1 | Пустая выдача |
| **Всего** | **10** | HTTP200, без retries/429/5xx |

Первый план не делал OpenDota независимым от результата STRATZ. Перед дополнительными запросами зарегистрировано уточнение: проверить первичный источник на тех же аккаунтах, сохранив общий cap10. После обнаружения projection defect второе уточнение отвело оставшиеся3 запроса на тот же Dendi после регрессии/исправления. Ни профиль с403, ни чужие credentials/Private Access не обходились. Массового HTML scraping нет.

Первая видимая STRATZ карта Speeed —2026-11-05, Saberlight —2026-11-03, Dendi —2026-06-11. Это ограниченная latest20 выдача, не полная перепись истории или окончательный диагноз приватности. Practice/league карты не подставлены в ranked sample.

## Подтверждённая причина и исправление

[Официальная реализация OpenDota `/players/:id/matches`](https://github.com/odota/core/blob/master/svc/api/spec.ts) выбирает user project вместо стандартного matchesCols, если project непуст. [Middleware](https://github.com/odota/core/blob/master/svc/api/api.ts) отдельно добавляет always/filter/sort columns. Поэтому запрос только account_id/leagueid/patch вернул match_id/player_slot/radiant_win/lobby_type/game_mode/start_time/account_id, но не героя и длительность.

В v2 явно перечислен весь нужный набор: match_id, player_slot, radiant_win, account_id, hero_id, start_time, duration, lobby_type, game_mode, leagueid, patch, average_rank, party_size. Не ослаблены проверки hero/outcome/side/time или формата ID. Недостающие поля не восстанавливаются догадками/дополнительным запросом на каждую карту.

Синтетический regression воспроизвёл настоящую server projection semantics и упал до исправления (0 вместо1 пригодной карты), затем прошёл. Дополнительно проверено поведение legacy cache: payload v1 читается как stale, может обновиться до TTL, lease/cooldown сохраняются, новые publications требуют v2. Предыдущие immutable observations не переписаны; SQL миграция не потребовалась.

Контракт принимает v1/v2 для чтения, текущий `RANKED_PRACTICE_ADAPTER_VERSION=ranked-practice-reader-v2`. Это версия pub reader, не версия модели. Импорт pro-карт/старый frozen OpenDota client не менялся.

## Эмпирическое покрытие OpenDota v2

Окно: **[2026-10-06T21:26:38Z, 2026-11-05T21:26:38Z)**. Первая пригодная карта:2026-10-06T21:27:35Z; последняя:2026-11-05T17:17:35Z. Завершение проверено строго до среза; completion basis — start_plus_duration, source knownAt неизвестен и остаётся null.

| Поле/проверка | Покрытие |
|---|---:|
| Уникальные пригодные map IDs |197 |
| Exact numeric account, герой, native side, исход, start/completion |197/197 |
| Герои присутствуют в локальном справочнике |197/197,25 distinct heroes |
| Party size |197/197 |
| Average lobby rank |0/197 → unknown |
| Provider patch code |0/197 → unknown |
| Подтверждённая pos1–5 |Не установлена, не выводится из линии |
| Дубликаты/противоречия |0/0 |

Сырые200 строки и197 maps не являются397 независимыми играми; это один cohort, три строки исключены. Повторный fetch с другой проекцией также не увеличивает число карт. Cap2×100 и реальная completeness всей истории остаются явно ограниченными/unknown. Две заполненные страницы не доказывают полноту карьеры. Это эмпирическая проверка одного публичного аккаунта, не оценка покрытия всех pro-игроков.

## Сохранение и следующий срез

Для проверки работающего интерфейса выполнен отдельный append одного настоящего captured pub observation через обычный repository: сохранены исходные fetchedAt/raw SHA, повторно проверены canonical account/hero catalogue, два предыдущих observations остались immutable. Уточнение scope зафиксировано до записи; новых HTTP и pro imports оно не добавило. Никаких production mocks или подмены capture time временем публикации.

Доступна [карточка Dendi](http://localhost:5173/players/61): раскройте «Рейтинговая практика», источник OpenDota. Видны197 карт, точный source период, cap200 и три исключения по дате. Live cache-only чтение выполнено через существующую owner session:0 provider HTTP/0 новых логинов/page errors/overflow, desktop/360px проверены. Геройские проценты пока не публикуются (`statisticsEnabled:false`).

## Фактически выполненные проверки

- Frozen offline install/root typecheck/build и **856 unit/CLI** — PASS.
- **14 source client units и11 API/PG**, включая explicit projection и v1→v2 cache refresh без переписывания old facts — PASS. Новый projection regression сначала дал ожидаемый FAIL,13 прежних тестов прошли; после исправления14/14 PASS.
- **7 Chromium** на isolated PG/synthetic provider fixtures — PASS, включая чтение old v1 payload новым контрактом.
- Сверка200 общих IDs двух реальных проекций подтвердила совпадение account/slot/outcome/lobby/mode/start; теперь дополнительно заполнены hero/duration.197 нормализованных строк проверены против raw JSON, windows и local hero catalogue; receipt SHA проверены.
- За весь audit/publication77 public tables:73 полностью неизменны; только2 quota tables и2 ranked tables изменились.340 pro maps/queue/models/saved identity/roster/scenario facts сохранены.
- 245 protected artifacts/150 original modules/frozen bundle/runtime compatibility,45 historical migrations и ссылки/whitespace — PASS. SQL/dependencies/lockfile не менялись.
- Локальный API перезапущен с v2 (PID24372); Web/worker retained. Full Node/browser/Python/Docker/Linux suites не перезапускались. No commit/push/deploy.

Следующий точный срез: **S2-07/hero-summary** — сырые games/wins/nullable WR и recency по героям для проверенного OpenDota v2 cohort, отдельно от pro; source/window/cap/unknown coverage остаются видимыми. STRATZ ranked fields ещё не прошли непустой live audit, автоматического объединения providers нет. Для predictive effect потребуется самостоятельная temporal pro ablation; V1 Elo не меняется. **GPT-6.1 Sol · High.** S2-07 в целом остаётся открытой до описательного hero block.
