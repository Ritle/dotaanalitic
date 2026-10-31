# S3-01 — исторические account ID для первой карты TI2023

Дата проверки: 2026-11-01 (сохранённые fetch timestamps — UTC 2026-10-31). **Подтверждены архивные source associations для 6 из 10 account ID одной карты. S3-01 остаётся открытой: 0 canonical merges, 0 verified map lineups, 0 training examples.**

## Доказательства и пределы

Продолжен [предыдущий TI12 checkpoint](S3_01_HISTORICAL_EVIDENCE.md). Карта7378530387 выбрана заранее как первая из существующего capture, начало2023-10-12T17:00:44Z, league15728. Один ответ OpenDota дал10 Steam32 account ID с native `player_slot`; это ретроспективное наблюдение с `knownAt:null`, а не доступный до матча состав.

| Архив официального team-info API | `knownByAt`, UTC | Строк members / registered IDs | Точные совпадения с account ID карты |
|---|---|---|---|
| [team8291895](https://web.archive.org/web/20220816121930id_/https://www.dota2.com/webapi/IDOTA2Teams/GetSingleTeamInfo/v001?team_id=8291895&get_dpc_info=true) | 2022-08-16 12:19:30 | 7 / 5 | 4 |
| [team8260983](https://web.archive.org/web/20220805020435id_/https://www.dota2.com/webapi/IDOTA2Teams/GetSingleTeamInfo/v001?team_id=8260983&get_dpc_info=true) | 2022-08-05 02:04:35 | 6 / 5 | 2 |

Проверены CDX digest encoded bytes, exact original URL, Memento-Datetime, timestamp и SHA-256. Повторный CLI capture совпал с первоначальными raw snapshots по payload/projection SHA. `knownByAt` означает «источник уже содержал эти данные к моменту архивирования»; это не самая ранняя публикация. `time_joined` остаётся отдельным утверждением источника, не становится `knownAt`.

Сопоставление выполняется только по точному Steam32 account ID, включая историю в других организациях. Ники не используются для объединения людей. Старые зарегистрированные пятёрки не переносятся на карту2023 года;13 source members не означают13 участников карты или13 примеров обучения. Роли, полные имена и игровая статистика не сохраняются в projection. Ни один account ID не импортирован как canonical player.

Нет совпавшего архивного account evidence для **94054712,346412363,136829091,184620877**. Это4 из10 source accounts, а не4 неизвестных аккаунта в OpenDota. Датированные профили/проверенные связи личности ещё нужны; даже покрытие10/10 само по себе не доказывает actual map lineup known-at, стороны, series membership или patch/draft availability.

## Ограниченный поиск

- Точные team-info и teamdetailsv2 запросы с нижней границей2023-01-01 вернули4 пустых индекса.
- Удаление нижней границы года для двух точных team-info URL обнаружило приведённые архивы2022 года. Старые account associations могут быть полезны при переносах между организациями; год турнира не ограничивает возраст identity evidence.
- Четыре точных `IDOTA2DPC/GetPlayerInfo/v001?account_id=…` CDX-запроса до старта карты, без нижней границы года, вернули пустые результаты. Это отсутствие в конкретных bounded queries, не доказательство отсутствия любых источников.
- Текущий Valve team-info ответ использован только для проверки формы:1 member row, поле registered IDs отсутствует, `knownAt:null`. Он не включён в историческое покрытие.

В этом checkpoint выполнено18 прямых HTTP-запросов:10 предварительных CDX,2 archive snapshots,1 текущий Valve response,1 OpenDota map и4 запроса финального CLI; все HTTP200. Web search считается отдельно. OpenDota использовал существующий quota client и изменил только счётчики бюджета. Широкие prefix queries из прошлого checkpoint не повторялись.

## Воспроизведение

- [Отчёт](evidence/s3-01-ti12-account-evidence.json), [SHA manifest](evidence/s3-01-ti12-account-evidence.manifest.json).
- [Ретроспективное наблюдение account ID](evidence/s3-01-ti12-map-accounts.json), [bounded probes и независимый raw replay](evidence/s3-01-ti12-account-probes.json).

```powershell
pnpm cohort:accounts --out reports/new-ti12-account-evidence.json
pnpm test:fixtures
```

CLI проверяет SHA предыдущего выбора карты, её ID/start/league/native teams и выполняет только два exact team-info index lookup с последующим snapshot каждого найденного источника. Индекс ограничен5 строками; используется самый ранний возвращённый snapshot до cutoff, без утверждения, что найден самый ранний существующий архив. Максимум6 HTTP attempts, timeout20s, pacing1s,2 попытки на request, Retry-After/cooldown; redirects запрещены. Схема, Steam32 диапазон, native slots, дубликаты, registered subset и часы валидируются; неизвестное остаётся null.

Запись отчёта эксклюзивная (`wx`); существующий путь отвергается до сети. CLI не подключается к БД. Exit0 означает, что оба team-info capture проверены, **не** готовность dataset;3 — неполное/ошибочное получение,2 — аргументы/существующий файл,1 — локальная ошибка. Источник может измениться или исчезнуть из архива; новый capture получает новое имя и новые fetch timestamps.

Node-тесты воспроизводят coverage из сохранённых projections при фиксированном snapshotAt и проверяют byte hashes артефактов. Полная повторная проверка CDX/Memento требует raw bytes: они оставлены в ignored локальной диагностике, а удалённый replay выполняется CLI. `localFileSavedAt` в preliminary probes — время локального файла, явно не historical known-at; точные `fetchedAt` финального capture сохранены отдельно. Старые evidence reports не изменены.

## Следующий точный шаг

Поиск продолжен в [Steam-profile checkpoint](S3_01_PROFILE_EVIDENCE.md) до9/10, затем в [registry/identity checkpoint](S3_01_IDENTITY_EVIDENCE.md) до10/10 source accounts. [Канонические связи применены](S3_01_IDENTITY_PROVISION.md):10 игроков,10 proofs/aliases, replay0 inserts. **Следующий шаг S3-01 — pre-start lineup evidence карты7378530387**, затем side/series/patch и широкий cohort. Ники регистрации не использовать как identity join; прежние пустые exact queries не повторять без нового основания.

Real frozen cohort и четыре непустых временных окна ещё не получены. S1-07 и отдельный v8 S1-08 corpus gate открыты; S3-02 автоматически не начинается. Рекомендуемая модель следующего шага: **GPT-6 Astra · Extra High**, переключение вручную.
