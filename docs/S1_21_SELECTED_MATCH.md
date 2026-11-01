# S1-21 — GamerLegion — CyberHero

Проверка 2026-11-01. Владелец выбрал встречу 2 ноября 2026, 22:00 МСК / 19:00 UTC. Это запись расписания BO3, не отдельная карта и не прогноз серии. PandaScore match1756304, tournament22236. **S1-21 завершена в объёме подготовки проверенного локального каталога и ограниченной pro-истории.** Связи PandaScore → canonical сохраняют unknown; будущая пятёрка ещё не подтверждена. Ниже сохранены результаты первого checkpoint и итоговой проверки.

## Подготовленные данные

Existing S1-12 catalogue capture → reviewed numeric evidence → preview → apply создал CyberHero и10 игроков,10 account proofs и10 aliases. GamerLegion уже присутствовал. Steam32/Steam64 проверены как числовые идентификаторы; совпадение ника не использовалось для объединения игроков. Историческая доступность заявки не утверждается: knownAt равен текущему fetchedAt, начиная с2026-11-01T15:50:43.622Z.

| Команда / canonical team | OpenDota team | Игрок / canonical player | OpenDota account |
|---|---|---|---|
| GamerLegion /6 |9964962|Bignum /22|90423751|
| GamerLegion /6 |9964962|RCY /24|154974246|
| GamerLegion /6 |9964962|Fayde /25|160119017|
| GamerLegion /6 |9964962|Yuma /26|177203952|
| GamerLegion /6 |9964962|Speeed /27|191362875|
| CyberHero /46 |10282069|bb3px /23|93526520|
| CyberHero /46 |10282069|darkniA /28|196482746|
| CyberHero /46 |10282069|Htrd /29|340421206|
| CyberHero /46 |10282069|WoE /30|1092267175|
| CyberHero /46 |10282069|sematary /31|1682179459|

Live prediction-source audit выполнен до импорта:10 завершённых карт с positively established professional tier, исходами и10 distinct hero/account slots на каждой. Источник не доказывает canonical patch, series grouping, роли или pre-start roster availability. Current-history preview/apply принял10 карт:6 новых и4 ранее существовавших обновлены после добавления identity evidence. В локальных отчётах каждой команды и каждого указанного игрока теперь N5. Это ограниченная описательная выборка, не оценка вероятности победы.

Catalogue replay: already_applied /0 writes. History replay:10 duplicates /0 import errors /0 HTTP; первоначальный apply также использовал сохранённые capture/audit без дополнительных HTTP. Полные capture остаются ignored `.tools`; их byte SHA-256, audit receipts, source clocks и результат UI сохранены в [evidence manifest](evidence/s1-21-selected-match.json). Manifest не заменяет отсутствующие исходные capture при воспроизведении на другом компьютере.

## Открытая связь имён CyberHero

Штатный PandaScore refresh `/tournaments/22236/rosters` от2026-11-01T16:01:41.550Z перечисляет Ainkrad, bb3px, WoE, Wein, Htrd. Реестр OpenDota перечисляет darkniA и sematary вместо Ainkrad и Wein. Это расхождение названий; оно само по себе не доказывает замену игроков.

Есть кандидаты Ainkrad → account196482746 и Wein → account1682179459, но PandaScore canonical links не созданы. Публичная [страница Dota2ProTracker Ainkrad](https://dota2protracker.com/player/Ainkrad) показывает account196482746; это полезное дополнительное свидетельство названия аккаунта, не подтверждение PandaScore player27481. Вторичные страницы дают кандидата Wein, но не заменяют проверенный source-bound numeric link. Два обычных HTTP200 запроса Steam alias history для уже известных Steam64 вернули только darkniA/zombie и sematary. Искомые Ainkrad/Wein там отсутствуют; отсутствие в короткой истории также не опровергает alias-гипотезу. Новые identity/alias claims по этой гипотезе не записывались.

Первый checkpoint оставил задачу открытой до проверки source-bound numeric links для PandaScore player27481/Ainkrad и53184/Wein. Эта проверка выполнена ниже. Состав конкретной будущей карты требует отдельного ручного выбора и подтверждения; task completion не заменяет это действие.

## Проверки и ограничения

Реальный Chromium login → выбранная встреча → tournament roster refresh → выбор только организаций6/46 → поиск10 локальных игроков →12 pro-history API reports →360px layout → logout: PASS. Игроки/роли не выбраны, confirmation=false, scenario save disabled, pageErrors0. Один PandaScore roster HTTP; cache теперь4. Секреты читаются helper внутри процесса, не включены в manifest.

Read-only DB check: migrations20, maps16/pro16, participants160/resolved104, players31, teams10, account proofs31, identity revision62, owners1, scenarios0, datasets0, active_models0, history_runs0, temporary DB0. Migration verifier20 PASS. Код приложения, SQL, зависимости и lockfile не менялись; frozen install/typecheck/434 unit/build/full28 Chromium уже PASS на том же коде в S1-20 в этой сессии, повторно для data-only checkpoint не запускались. Новые проверки здесь — actual capture/preview/apply/replay, browser/API acceptance, Steam observations и DB/migration/docs integrity. Docker/remote CI/Python backtest не запускались.

Canonical patch/series/roles и историческая предматчевая известность остаются unknown. Полные canonical пятёрки на обеих сторонах: GamerLegion4/5 карт, CyberHero0/5; это ограничивает roster reports. S1-07/S3-01/corpus gates открыты, прогнозы unavailable. Локальные API3000/web5173/worker сохранены запущенными; существующий owner/password не изменён. Push/deploy/training не выполнялись.

## Итоговая проверка и решение о готовности

Два целевых запроса штатным `PandaScoreClient` через общую PostgreSQL quota успешно выполнены: `/players/27481` в16:16:48.783Z и `/players/53184` в16:16:52.467Z, оба HTTP200. Имена/ID соответствуют Ainkrad/27481 и Wein/53184. В обоих ответах из полей идентификаторов есть только `id` и `current_videogame.id`; Steam/account identifier или внешний профиль отсутствует. Проверены исходные bytes/SHA и endpoint ID; полный ответ хранится ignored, публичный [completion manifest](evidence/s1-21-completion.json) содержит inventory и хеши. Это наблюдение о двух полученных профилях, не утверждение об отсутствии идентификаторов во всём API или всех тарифах.

**Подтверждённых PandaScore → canonical связей0 для всей выбранной встречи**, а не «8 подтверждены,2 неизвестны». Остальные совпадающие ники также не являются numeric evidence. Десять локальных account proofs относятся к OpenDota/Steam; они позволяют читать историю именно этих аккаунтов. Сходные названия организаций тоже не создают provider identity mapping. Гипотезы Ainkrad/darkniA и Wein/sematary остаются только кандидатами; aliases/canonical links не дописывались.

Исходное требование S1-21 прямо допускает unknown при отсутствии proof. Поэтому отсутствие cross-provider mapping блокирует автоматическое заполнение заявки, но не подготовку каталога, просмотр истории или ручной сценарий. Первоначальное ожидание обязательного подтверждения этих двух связей было излишним условием завершения всей задачи. В существующем UI уже показано «Связь этих игроков с локальной историей ещё не подтверждена»; игроки выбираются вручную, роли и будущую пятёрку подтверждает владелец. Дальнейший поиск архивных ников не является обязательным этапом текущего workflow.

Реальная проверка [сравнения организаций](http://localhost:5173/compare?teamA=6&teamB=46) после login: ID6/46 из ссылки, все10 player fields пустые, POST comparison200/schema PASS, mobile360px без overflow/pageerrors, logout PASS. За стандартное окно90 дней в локальной выборке GamerLegion1 победа/5 карт, CyberHero4/5; H2H0/rate=null. История выбранных пятёрок остаётся null. Эти частоты описывают малую локальную выборку, прогноз и model остаются null. Сценарий не создан, роли/игроки не назначались.

На продолжении заново выполнены frozen install/typecheck/**434 unit**/build — PASS; pnpm в sandbox первоначально остановился до изменения node_modules из-за non-TTY/store environment, запуск с существующим store вне sandbox успешен. Chromium sandbox launch дал EPERM до входа; разрешённый запуск вне sandbox завершился PASS. Migration20, hashes, docs links/diff и финальное состояние БД проверены. Полный28 Chromium suite здесь не повторялся: код приложения не менялся; он PASS в предыдущем S1-20 checkpoint. Код/SQL/dependencies/lockfile прежние. После двух профильных запросов current-window quota requests3; business counts прежние, scenarios0/datasets0/models0/tempDB0.

**Следующий шаг в выбранном workflow:** владелец выбирает10 canonical игроков и роли1–5 для ручного сценария одной карты, затем подтверждает их в форме. Этот выбор не создаёт проверенную cross-provider identity и не считается официальным объявлением состава. Для сопровождения этого шага и обычного UI рекомендуется **GPT-6.1 Sol · Medium**; модель/effort выбирает владелец. Доступные режимы сверены с [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6.1-sol), конкретная рекомендация — инженерная оценка для этой задачи.
