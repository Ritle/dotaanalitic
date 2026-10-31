# S3-01 — архивные Steam-профили для account evidence

Проверка2026-11-01, fetch timestamps в UTC2026-10-31. **Исторические source observations найдены для9/10 account ID выбранной карты TI2023:6 team-info associations и3 самостоятельно заполненных Steam-профиля. Это разные виды доказательств; verified canonical identities/map lineups/training examples по-прежнему0.**

## Результат ограниченного поиска

Исходные четыре ID взяты из [предыдущего отчёта](evidence/s3-01-ti12-account-evidence.json), выбор карты7378530387 и её10 native slots не менялись. Повторного OpenDota запроса не было.

| Account ID | Архив с числовым SteamID внутри страницы | `knownByAt`, UTC | Содержание |
|---|---|---|---|
| 94054712 | [Numeric profile](https://web.archive.org/web/20131219081742id_/http://steamcommunity.com:80/profiles/76561198054320440) | 2013-12-19 08:17:42 | SteamID76561198054320440, alias Topson |
| 346412363 | [Numeric profile](https://web.archive.org/web/20220914110606id_/https://steamcommunity.com/profiles/76561198306678091) | 2022-09-14 11:06:06 | SteamID76561198306678091, alias Ari |
| 136829091 | [Vanity profile](https://web.archive.org/web/20191014144109id_/https://steamcommunity.com/id/whitemon/) | 2019-10-14 14:41:09 | SteamID76561198097094819, alias Whi†emon |
| 184620877 | Нет snapshot в выполненных exact queries | null | Неподтверждённый исторический account observation |

Профиль подтверждает наличие указанного числового account ID и опубликованного alias на дату архива. Alias редактируется пользователем; он **не удостоверяет личность профессионального игрока**, неизменность владельца аккаунта, команду, роль или участие в карте. Поэтому `verifiedPersonIdentity:false`, `canonicalPlayerId:null`, `teamId:null`, `proStatus:null`, автоматическое объединение запрещено. Совпадение ников не используется.

Формат numeric profile опубликован в [Steamworks Community Data](https://partner.steamgames.com/documentation/community_data); описанный там XML устарел и использован только как дополнительный адрес для двух пустых архивных запросов. Битовое представление account ID проверено по [официальному CSteamID](https://github.com/ValveSoftware/GameNetworkingSockets/blob/master/include/steam/steamclientpublic.h): public universe / individual / default instance; преобразование выполняется bigint, без Number для64-bit IDs.

## Поиск и часы источников

Четыре exact numeric HTML CDX-запроса дали два архива. Для двух оставшихся numeric XML запросы пусты. Их текущие numeric URLs вернули HTTP302 на официальные vanity paths: `/id/whitemon/` и `/id/1523123512351235/`. Redirects2026 года служат только указателями поиска, `knownAt:null`; они не переносят сведения в2023 год. Автоматического перехода по redirect нет.

Точный архивный запрос vanity path для136829091 дал пять индексных строк; выбран первый возвращённый snapshot2019 года и проверен embedded SteamID. Запрос для184620877 пуст. Из8 preliminary CDX queries5 пусты; это не доказательство глобального отсутствия архивов. Прежние GetPlayerInfo queries и широкие prefix queries не повторялись.

Для всех трёх тел проверены CDX SHA-1/base32, exact replay original, Memento-Datetime, encoded/decoded SHA-256, размер, UTF-8 и числовой ID. `knownByAt` — консервативная дата доступности содержимого к моменту архива, не самое раннее появление аккаунта. Source fetch, дата архива и map start сохраняются отдельно. Старые team-info evidence reports не изменены.

## Реализация и воспроизведение

`steam-profile-evidence.ts` принимает только проверенные формы Steam Community profile URL: http/https с соответствующим default port, optional trailing slash, numeric либо точный vanity path. Чужой host/port, credentials, query, fragment, encoded/dot path отвергаются. Протокол/слеш могут отличаться в CDX, но путь должен совпасть; original replay и Memento связываются с выбранной строкой.

Из HTML извлекается единственный JSON `g_rgProfileData` в начале inline script, без исполнения JavaScript. Повторное присваивание, неоднозначные consumed keys, executable expression, external script с inline payload или несовпадающий embedded ID вызывают отказ. Summary, session IDs, полные имена и прочее содержимое профиля не попадают в projection. Pure mixed-source audit раздельно считает organization/profile evidence и объединяет только точные account IDs с историческим cutoff; повторные proofs/перестановки не увеличивают выборку.

```powershell
pnpm cohort:profiles --out reports/new-ti12-profile-evidence.json
pnpm test:fixtures
```

CLI читает [фиксированный lookup plan](evidence/s3-01-ti12-profile-lookup-plan.json), проверяет SHA предыдущего отчёта/карты и соответствие четырём ранее отсутствовавшим account IDs. Максимум8 HTTP attempts для4 индексов и до4 snapshots,2 попытки на request,20s timeout,1s pacing, Retry-After/cooldown и запрет redirects. Другие archive commands сохраняют default budget6. Используется самый ранний **возвращённый** snapshot, index limit5; это не утверждение о самом раннем существующем архиве.

Отчёт создаётся с `wx`; existing path отвергается до сети. DB connection отсутствует. Exit0 — все lookup targets дали проверенные профили;3 — неполное покрытие/ошибка получения;2 — arguments/existing file;1 — local failure. Первый запуск получил три профиля из четырёх. Финальный live запуск вернул exit3 и только два профиля: archive replay для346412363 ответил HTTP302, клиент отказался следовать перенаправлению. Поэтому последний live report содержит8/10, а независимая проверка трёх уже сохранённых raw bodies окончательным парсером —9/10. Историческое доказательство не исчезает из-за ошибки повторной загрузки; свежий отчёт не подменяется старым. `strictDatasetStatus:unavailable` при любом результате.

- [Финальный live report:8/10, HTTP302](evidence/s3-01-ti12-profile-evidence.json), [offline raw replay:9/10](evidence/s3-01-ti12-profile-replay.json), [SHA manifest](evidence/s3-01-ti12-profile-evidence.manifest.json).
- [Preliminary probes, redirects и profiles](evidence/s3-01-ti12-profile-probes.json). Raw bodies остаются в ignored локальной диагностике.

Первый CLI capture повторён после исправления найденной synthetic-регрессии с конфликтующими присваиваниями. Первоначальный отчёт сохранён локально и связан SHA в manifest; финальный live report и offline verification содержат hashes окончательных source/runtime файлов. Final pure replay совпадает с предварительными тремя raw snapshots; дополнительных HTTP-запросов для него нет. Всего27 прямых запросов:13 preliminary (11 HTTP200,2 HTTP302), первый CLI7 HTTP200, финальный CLI6 HTTP200 и1 HTTP302. Итого24 HTTP200/3 HTTP302, timeouts0; redirect не обходился. Web-tool документация/поиск считается отдельно; DB/quota counters не изменялись.

## Следующий шаг

**Продолжить S3-01: датированное официальное account/roster evidence для184620877 и отдельная проверка пригодности identity evidence.** Numeric HTML/XML и найденный current vanity path уже проверены; не повторять их без новой причины. Следующий источник должен содержать явный account ID и подтверждаемое время доступности, а не только ник. Затем actual map lineup/side/series и patch coverage, для post-draft — dated hero proof. Историческое наблюдение аккаунта не снимает остальные gates.

S3-01, S1-07 и отдельный v8 S1-08 corpus gate открыты; S3-02 автоматически не начинается. Следующая модель: **GPT-6 Astra · Extra High**, переключение вручную.
