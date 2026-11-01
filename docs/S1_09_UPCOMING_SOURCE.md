# S1-09 — источник предстоящих матчей и турнирных заявок

## Выбранный владельцем срез

2026-11-01 владелец после обсуждения цели приложения выбрал расписание будущих встреч и ожидаемые составы, затем поручил начать. Это явный выбор порядка по AGENTS§10. **Срез S1-09 — проверка источника и CLI; следующий S1-10 — экран расписания.** S3-01 остаётся незавершённой. Поиск дат объявления старых пятёрок не является зависимостью экрана предстоящих матчей. Историческая проверка моделей и остальные P0 prediction gates сохраняются.

Результат: PandaScore действительно отдаёт расписание Dota2 и заявки выбранного турнира. Живой запрос с локальным ключом выполнен; это не вывод только из документации и не синтетический пример. Клиент предназначен пока для одного ручного аудита, без фонового polling, записи в БД или нового HTTP/UI endpoint.

## Полученные данные

[Финальный отчёт](evidence/s1-09-upcoming-source-final.json) получен **2026-11-01T00:16:46.760Z**:

| Поле | Наблюдение источника |
|---|---|
| Расписание | Первая страница20 предстоящих встреч, глобальная полнота не оценена |
| Выбранная встреча | Team Yandex — Team Spirit, provider match1753769 |
| Время по расписанию | 2026-11-01T13:00:00Z = 16:00 МСК |
| Турнир | PARI Universe / 2026 / Playoffs, provider tournament22231 |
| Формат встречи | BO5; это серия, а не пять уже сыгранных карт и не цель модели MVP |
| Заявки турнира | 8 команд; для выбранной пары ровно5 ожидаемых игроков на сторону |
| Team Yandex | Saksa, watson, ATF, Malady, Chira JUNIOR |
| Team Spirit | Larl, Yatoro, Batyuk, rue, not me |
| Профиль идентификаторов | Один sampled profile9495: поля id/current_team.id/current_videogame.id; явного Steam/account поля в проверенном inventory нет |

Это **ожидаемые заявки источника на турнир**, не гарантия участия в конкретной карте. Порядок игроков в ответе не задаёт роли или Radiant/Dire. Данные о переносах/заменах могут измениться после capture; в UI потребуется время обновления и ручная корректировка.

[Предварительная проверка](evidence/s1-09-upcoming-preliminary.json) выбрала ближайший матч Team Synapse — HellNight- в другом турнире22302. Обе заявки содержали по6 игроков: сохранены все6, статус requires_manual_selection. Клиент не выбрал пять по порядку массива. Это реальный пример ограничения автоматического заполнения.

**Связь с историей OpenDota ещё не реализована.** PandaScore player ID — другой namespace; совпадение никнейма не доказывает Steam32 или canonical player ID. Проверка одного профиля не доказывает отсутствие Steam IDs во всём API. В отчёте canonicalPlayersLinked=0, playerHistoryLinks=requires_verified_provider_mapping, steamAccountCoverage=not_assessed. Следующий UI может показать заявки и потребовать явного выбора канонических игроков для сценария; автоматический merge по имени запрещён.

## Команда и границы

Добавьте в локальный `.env` **PANDASCORE_API_TOKEN** из [кабинета PandaScore](https://app.pandascore.co/); секрет не должен попадать в VITE_ переменные, Git, отчёт или чат.

```powershell
pnpm schedule:audit --out reports/new-upcoming.json
pnpm schedule:audit --out reports/new-tournament.json --tournament 22231
```

Без `--tournament` выбирается ближайшая будущая not_started встреча с первой страницы20 строк; с флагом — ближайшая встреча указанного турнира **на этой странице**. Отсутствие турнира на странице не означает отсутствие матчей в API. Время — scheduled_at; null, отменённые и уже наступившие даты не выбираются. Названия событий могут быть пустыми: нормализуются в null; полное название сохраняется отдельно, если есть.

После выбора выполняются exact tournament rosters и inventory одного профиля игрока выбранной пары, выбранного по минимальному provider ID. Обычно3 GET. Host фиксирован, Bearer только в заголовке, redirects запрещены; максимальный бюджет6 попыток, spacing4s, до2 попыток на запрос, timeout15s, body2MiB, Retry-After и предел ожидания10s. 401/403/обычные4xx не повторяются. Это лимит ручного запуска; перед постоянной синхронизацией нужен отдельный durable quota/cache boundary. Не запускать CLI циклически как замену scheduler.

Zod проверяет потребляемые поля/ID/даты, дубликаты участников, границы и namespace; unknown/неполные заявки сохраняются с coverage. Не читаются/не сохраняются биографии, email, фотографии и logo assets; профиль проецируется только в ID и названия/типы identifier fields, без их значений. ID в JSON строки. Ключ отсутствует в URL; ошибки не печатают provider body/transport exception. CLI дополнительно отказывает в сохранении отчёта при отражённом значении ключа.

Exit0 / captureStatus=complete означает завершённую проверку источников, даже если expectedLineupReady=false. Без ключа — exit3/blocked/0 HTTP с неизвестной coverage; при сбое сохраняются уже полученные данные и структурированный error. Неверные аргументы/overwrite/path outside project отклоняются до HTTP с exit2; write failure — exit1. Все файлы создаются исключительно один раз, без перезаписи captures.

Расписание/заявки не становятся профессиональными исходами или model inputs автоматически. match ID PandaScore не является Dota map ID. Новых identity links/map results/training examples/predictions не создано; вероятности не выдаются.

## Проверки и evidence

Прямые запросы PandaScore: **7 HTTP200** — preliminary2, failed schema capture1, diagnostic1, final3. Неудачный capture сохранён в [source.json](evidence/s1-09-upcoming-source.json); [diagnostic](evidence/s1-09-upcoming-shape.json) хранит только paths/types и SHA. После failure-first regression пустые короткие названия обрабатываются как unknown. Отдельный regression сначала выявил преобразование типа ID до field inventory; исправлено сохранение исходных типов. Оба исправления проверены полным unit suite.

[Manifest](evidence/s1-09-upcoming-source.manifest.json) связывает все captures по SHA;9 финальных code/runtime/lockfile hashes проверены после root build. Final report SHA `ca8a6f2de18fba7e44b3b6c4b1ebf0d0dbb75ec2ab917e541d482f280c07bddb`. Предыдущие S3 evidence не менялись. Working DB прочитана read-only: maps1/players10/account_proofs10/aliases10/identity revision20/datasets0/active_models0/tempDB0.

PASS: frozen install, финальный typecheck,417 unit (22 новых), root build,56 Node tests (4 новых), финальный focused4 после расширения SHA assertions, verifier18/golden, docs/diff. Новые tests используют **синтетические provider-shaped примеры**, живой capture проверяется отдельно. После финального typecheck9 source/runtime hashes перепроверены. Нет изменений SQL001–018, dependencies/lockfile, Fastify routes или UI. PG integration/E2E/Python не затронуты и не повторялись. Подробнее — [PROGRESS](PROGRESS.md).

## Источники документации

- [Upcoming Dota2 matches](https://developers.pandascore.co/reference/get_dota2_matches_upcoming), [rosters endpoint](https://developers.pandascore.co/reference/get_tournaments_tournamentidorslug_rosters).
- [Tournament participants vs team players](https://developers.pandascore.co/docs/tournaments-in-depth): для заявок использовать tournament rosters.
- [Authentication](https://developers.pandascore.co/docs/authentication): Bearer header, server-side private token.
- [Rate limits](https://developers.pandascore.co/docs/rate-and-connections-limits): зависят от плана; live remaining header сохранён, стоимость тарифа не оценивалась.

**Следующая задача — S1-10: защищённый экран «Предстоящие матчи» с server-side загрузкой/кэшем, показом ожидаемых заявок, временем обновления и явной ручной корректировкой.** План должен сохранять неподтверждённые provider→canonical links как unknown; дата/серия не подменяют одну карту. Для реализации — **GPT-6.1 Sol · High**.
