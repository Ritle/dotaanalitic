# S3-01 — исторические источники TI2023

**Статус: положительный source checkpoint, S3-01 остаётся открытой.** Найдены два разных доказательства: опубликованные метаданные турнира и зарегистрированные ники одной организации. Ни одно не является полной strict-as-of записью карты; `trainingExamples=0`, `deployable=false`.

## Что удалось подтвердить

| Источник | Доказанно доступен к UTC | Узкий результат |
|---|---|---|
| [Архив официальной страницы TI12](https://web.archive.org/web/20231007101410id_/https://www.dota2.com/esports/ti12) | 2023-10-07 10:14:10 | Embedded DPC_DATA: event21 / league15728 / registration period8 и объявленные registration deadlines |
| [Архив registration API Valve для team8291895](https://web.archive.org/web/20231001083937id_/https://www.dota2.com/majorsregistration/teammembers?team_id=8291895) | 2023-10-01 08:39:37 | Пять nickname rows: Topson, Sneyking, Nine, skiter,33; source confirmation timestamps сохранены отдельно |

Для обоих проверены exact original URL, Memento-Datetime, timestamp/digest CDX, encoded bytes и SHA-256 декодированного содержимого. Декомпрессия ограничена; HTML/JS не исполнялись. Projection не сохраняет cookies, session IDs или полные имена. `knownByAt` — консервативная верхняя граница из архива, **не** самая ранняя публикация и не `confirmation_time`.

Исходная группа — пять уникальных карт [S0-08 TI2023](evidence/s0-08-live-ti2023.json), начиная с7378530387/2023-10-12T17:00:44Z. Все пять сегодняшних source references указывают на league15728, существование которой подтверждено более ранним архивом. **Это не пять доказанных до старта map→league assignments или составов.**

Один дополнительный OpenDota response через общий PostgreSQL quota budget дал для первой карты native team IDs8291895/8260983 и series815175. Они использованы только для точных архивных запросов. Их `knownAt=null`; actual sides/series не объявлены известными заранее. Canonical matches/players/identities не синхронизировались.

## Как изменился поиск

1. Официальная TI12 страница содержит DPC config, а не lineup. Её JS указывает отдельные team-info endpoints; архив кода не доказывает ответы endpoints.
2. [Архив registration UI](https://web.archive.org/web/20230927115904id_/https://www.dota2.com/majorsregistration/rosters) содержит пять **пустых** nickname slots и AJAX search. Это интерфейс, не пустой зарегистрированный состав.
3. Два bounded prefix CDX-запроса roster/team-info завершились по25s timeout. Timeout не трактуется как отсутствие архива.
4. Exact query по team8291895 нашёл snapshot2023-10-01 с пятью строками. Для team8260983 exact URL/window вернул `[]`; это ограниченный отрицательный результат, не отсутствие исторических сведений вообще.

В registration response нет `account_id`/Steam ID. Ники нельзя присоединять к canonical players по совпадению строк. Организация и её зарегистрированный состав не доказывают, кто вышел на карту или какую native side занял. Изменения, stand-ins и роли неизвестны.

Объявленный в DPC config add-lock предшествует `confirmation_time` одной регистрационной строки. Это дополнительная причина не выводить соблюдение roster lock из календарного поля; без правил исключений/изменений нельзя объявлять регистрацию ошибочной или состав неизменным.

## Артефакты и воспроизведение

- [TI12 metadata](evidence/s3-01-ti12-evidence.json), [SHA manifest](evidence/s3-01-ti12-evidence.manifest.json), [bounded probes](evidence/s3-01-ti12-probes.json).
- [Registration response и exact lookup results](evidence/s3-01-ti12-registration.json), [SHA manifest](evidence/s3-01-ti12-registration.manifest.json).

```powershell
pnpm cohort:evidence --out reports/new-ti12-evidence.json
```

CLI использует tracked S0-08 capture, exact official URL, October2023 window, limit5 и самый ранний возвращённый snapshot. Максимум6 archive attempts, timeout20s, pacing1s,2 попытки на request, Retry-After/cooldown; redirects запрещены. Output с `wx`, existing output отвергается **до сети**. CLI не требует DB и не импортирует proofs. Capture complete означает проверенный источник; `strictDatasetStatus` остаётся unavailable. Exit0 — capture complete,3 — unavailable/partial,2 — arguments/existing file,1 — local failure.

Для registration response повторить exact CDX/original из lookup, получить `id_` bytes без автоматической декомпрессии и передать CDX record + Memento/original headers + fetchedAt в чистую `verifyArchivedTeamRegistration`. Экспорт из `@dota/ingestion` принимает официальный numeric-team URL, не выполняет сеть и не создаёт canonical links. Raw bodies остаются в ignored локальной диагностике; SHA/minimal projection доступны в Git.

Финальный TI12 CLI:2 HTTP200, metadata projection совпала с независимо полученным raw snapshot. Предварительные probes:8 HTTP200 +2 timeout; exact lookup:1 OpenDota HTTP200 +3 archive HTTP200. Всего16 прямых сетевых попыток вне sandbox:14 HTTP200 и2 timeout; первоначальный sandbox connection denial записан отдельно. Web-tool search не включён в эти HTTP counters. Старые source captures не перезаписаны.

## Оставшиеся evidence gates

Для пяти карт неизвестны canonical account links, actual lineup known-at, native side known-at, verified series membership, effective patch release/coverage и post-draft hero timestamp. Зарегистрированные nickname rows дают **0** verified canonical players и **0** verified map lineups. Доказанный ранее текст анонса7.34d не становится deployment/hero proof.

Последующий [account checkpoint](S3_01_ACCOUNT_EVIDENCE.md) проверил exact team-info архивы2022 года для8291895 и8260983:6/10 source account ID первой карты имеют совпадение до cutoff. Это отдельные доказательства, не добавление account IDs к пяти nickname rows этого регистрационного ответа. Canonical links и actual map lineup всё ещё не подтверждены.

Последующий [Steam-profile checkpoint](S3_01_PROFILE_EVIDENCE.md) добавил три самостоятельных source observations; saved coverage9/10 не означает verified canonical identities. Следующий шаг — **S3-01**: датированное официальное account/roster evidence для184620877, отдельный identity review, затем actual map lineup/side/series и patch coverage. Уже пустые exact profile queries и широкие prefix queries не повторять без новой причины. Только после доказательств формировать real frozen cohort и проверять четыре окна. S1-07 и отдельный v8 S1-08 corpus gate открыты; S3-02 автоматически не начинается. Модель: **GPT-6 Astra · Extra High**.
