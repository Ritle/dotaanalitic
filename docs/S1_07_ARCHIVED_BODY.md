# S1-07 — доказанная историческая доступность текста анонса

## Положительный результат

Получен публичный архив [официальной Steam-страницы 7.34d](https://web.archive.org/web/20231012155512id_/https://store.steampowered.com/news/app/570/view/3735230544064408127), снятый **2023-10-12T15:55:12Z**. HTML содержит сам `announcement_body` нужного event, не только ссылку/SPA shell. Текст из архива и нынешнего [официального event API](https://store.steampowered.com/events/ajaxgetpartnerevent?clan_accountid=3703047&event_gid=3735230544064408127) имеет одинаковый SHA-256:

`cbb1bb70b4ac6598a4ad641577feaa5d130a6f698d9fb2159d0e4ef9898831d7`

Capture и byte manifest: [projection](evidence/s1-07-archived-announcement.json), [manifest](evidence/s1-07-archived-announcement.manifest.json). Финальный run: **3 HTTP200**, без ошибок/повторов — live Steam event, bounded CDX query, один Memento. Это настоящий source audit, не synthetic fixture. Тексты/HTML, server fields, credentials и персональные IDs не сохраняются в опубликованный JSON; есть только hashes, scope, source clocks/URLs и coverage.

## Что именно проверено

1. Запись CDX ограничена точным original URL и временем раньше первой карты выбранного TI2023 capture, limit5. Фиксированно выбран самый ранний полученный кандидат, без подбора по качеству прогноза.
2. Memento-Datetime совпадает с timestamp CDX, Link rel=original — с официальным Steam URL. HTTP redirects не выполняются, поэтому live page не может незаметно заменить архив.
3. CDX digest **NCRMATL7YMOOIOOAGGIEQJ2YKYHPFEEE** совпал с SHA1/base32 исходного payload. В этом случае CDX относится к **gzip bytes**, а не к декодированному HTML. Дополнительно сохранены SHA-256 compressed/decoded bytes. SHA1 здесь — legacy identifier архива, не новая криптографическая политика продукта.
4. Декомпрессия ограничена4MB, исходный ответ2MB. Извлекается только JSON из data-partnereventstore без выполнения HTML/scripts. Выбирается ровно один eventId; app570, официальный clan и ссылка event→announcement проверяются. Сторонние/дублированные events не получают proof.
5. В архиве event опубликован и не hidden; posttime/updatetime текста не позже archive timestamp. Сравнивается SHA-256 именно body. Если нынешний body изменён, ранний proof относится только к архивной версии, currentBodyKnownByAt=null.

Поля `news gid`, `event gid`, `announcement gid` различаются: current news feed ID5220292521182246432 не равен event3735230544064408127 и body3735230544064408128. Из одного ID другой не вычисляется арифметически; используются фактические ссылки provider payload/официальной страницы.

## Времена и границы вывода

У body posttime=2023-10-05T23:40:41Z, updatetime=2023-10-06T14:41:05Z; у нынешнего event rtime32_last_modified=2026-10-18T14:28:43Z. Event metadata clock не заменяет body revision clock. [Документация Steamworks](https://partner.steamgames.com/doc/marketing/event_tools) отдельно описывает редактирование событий, времена начала и видимости.

Консервативный `bodyKnownByAt` — **время проверенного архива**, а не ранняя дата публикации, backfill или fetch2026. Для всех5 unique map IDs уже существующего S0-08 TI2023 capture текст доказанно доступен раньше старта первой карты2023-10-12T17:00:44Z. `sourceBodyVerifiedMaps=5` относится только к этому тексту. Дубликаты map snapshots не увеличивают число карт; неизвестный start/pro/conflicting observation не получает proof.

**Не доказано:** exact effectiveReleasedAt, coverage interval патча, герои/роли/lineups/outcomes до cutoff, содержание внешней ссылки на hero notes. build_id=0 нормализован в null; анонс не привязан к проверяемому deployment build. Поэтому verifiedPatchMaps=0/trainingExamples=0, verifiedReleasedAt/heroNotesKnownAt=null, autoRegistryEligible=false и deployable=false. Веса не калибровались, Brier/log loss/ECE остаются null. Body proof нельзя использовать как proof всех сведений документа или как полную готовность prediction data.

## Воспроизведение

```powershell
pnpm patch:archive --event '3735230544064408127' --out docs/evidence/new-announcement.json
```

Выход и `.manifest.json` создаются с wx, существующие capture не перезаписываются. CLI не требует DATABASE_URL и не пишет в PostgreSQL. Live endpoint использует ValvePatchClient; ArchiveEvidenceClient сохраняет raw encoded bytes через native HTTPS, чтобы не потерять CDX digest при автоматической декомпрессии fetch. Static official/original URLs, no redirect, timeout20s,1s pacing,2 попытки на запрос и максимум6 archive attempts;429/5xx/network обрабатываются с Retry-After, длинный cooldown сохраняется в client/run. Автоматического polling нет.

До финального run выполнены8 read-only probes официальных страниц, event API и CDX/Memento. Индекс Steam Community по одному exact URL оказался пустым — это не доказательство отсутствия истории. У архивного Valve HTML не установлено содержимого hero notes; он не использован как proof. Два gzip payload распознаны/проверены до реализации, финальный capture воспроизводит положительный Steam case. Полные bodies остаются только в ignored локальной диагностике.

## Статус

Часть historical provenance теперь подтверждена узко и положительно, но **S1-07 остаётся unchecked**. Для её полного temporal gate всё ещё нужны effective release/coverage, dated hero availability/impact и достаточный verified pro cohort. Сохранённые source texts не являются обучающими картами. [Остальные source gaps](S1_07_SOURCE_EVIDENCE.md).
