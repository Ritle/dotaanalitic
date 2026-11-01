# S1-07 — проверка активной технической версии Valve

**Результат 2026-11-01:** публичный Valve IGCVersion_570 действительно вернул поле `active_version`: клиент **6969**, сервер **6969**. Источник принят для сохранения этого числового наблюдения. **Он не принят как доказательство patchLabel=7.41f:** буквенной версии и соответствия числового номера патчу в ответах нет. Production collector/SQL/adapter не добавлены. [Manifest и решение](evidence/s1-07-active-version-source-review.json).

Это проверка одного семейства источников технической версии, а не повтор прежнего аудита OpenDota code60 или дат публикаций. Поиск использован для обнаружения endpoints; сторонние сайты/трекеры не приняты как evidence.

## Первичные ответы

Четыре последовательных backend GET, все HTTP200, без токена, retry, pagination или периодического polling. Сохранены точные raw bytes и SHA-256, а не только JSON projection. Время ниже — UTC; это снимки конкретного запуска, не обещание актуальности после него.

| Источник | FetchedAt | Полученные значения | Raw bytes |
|---|---|---|---|
| [GetClientVersion/v1](https://api.steampowered.com/IGCVersion_570/GetClientVersion/v1/) | 2026-11-01T20:36:36.413Z | success=true; min_allowed_version=6969; active_version=6969 | [82 bytes](evidence/s1-07-active-version-client.json) |
| [GetServerVersion/v1](https://api.steampowered.com/IGCVersion_570/GetServerVersion/v1/) | 2026-11-01T20:36:37.774Z | success=true; engine=1; deploy_version=6969; active_version=6969; response_time=1793565392 | [117 bytes](evidence/s1-07-active-version-server.json) |
| [UpToDateCheck, app570/version0](https://api.steampowered.com/ISteamApps/UpToDateCheck/v1/?appid=570&version=0) | 2026-11-01T20:36:39.138Z | success=true; up_to_date=false; version_is_listable=false; required_version=37; message=OUT OF DATE | [122 bytes](evidence/s1-07-active-version-up-to-date.json) |
| [GetSupportedAPIList/v1](https://api.steampowered.com/ISteamWebAPIUtil/GetSupportedAPIList/v1/) | 2026-11-01T20:37:07.001Z | IGCVersion_570 перечисляет GetClientVersion/GetServerVersion v1, GET, parameters=[] | [21518 bytes](evidence/s1-07-active-version-api-list.json) |

Официальная [документация UpToDateCheck](https://partner.steamgames.com/doc/webapi/ISteamApps#UpToDateCheck) описывает входной `version` как установленную версию игры, appid — как приложение. Она не задаёт соответствие required_version ↔ IGC active_version ↔ номер balance patch. Запрос version=0 — диагностическая проверка, не проверка реально установленного клиента владельца. Числа37 и6969 различаются в ответах; ни одно нельзя преобразовывать в7.41f без независимого evidence.

Official API list подтверждает существование методов, но не документирует значения response fields, гарантии cache/freshness или глобальное состояние всех серверов. Отсутствие других методов в этом публичном списке не доказывает, что других источников у Valve нет. Publisher-only build APIs не вызывались: по Steamworks они требуют ключ издателя приложения; обычный пользовательский Steam API key не заменяет эти права.

## Область доказательства и время

Допустимое утверждение: «в ответе официального endpoint для app570, полученном в T, поле active_version имело значение6969». Client/server снимки получены в разное время, не атомарно. Совпадение значений не подтверждает версию конкретной профессиональной карты, турнирного сервера, историческую release boundary или баланс-патч.

Сохранены requestedAt, fetchedAt и recordedAt; review завершён2026-11-01T20:38:36.223Z. `response_time`, если интерпретировать число как Unix seconds, соответствует2026-11-01T20:36:32Z. Его не приняли за время deployment или historical knownAt. HTTP Date также не доказывает начало действия версии. Заголовки Age/Cache-Control/Last-Modified/ETag в трёх version responses отсутствовали; гарантии свежести из их отсутствия не выводятся.

Для будущего наблюдения можно утверждать локальную доступность полученного содержания к fetchedAt с отдельными recorded/reviewed clocks. Нельзя задним числом назначать knownAt октябрьским картам. Начало действия technical version и её соответствие balance label остаются неизвестными.

## Конкретная acceptance policy

| Условие | Решение |
|---|---|
| Fixed official host/path/app570; успешный HTTP и success=true; ожидаемая shape, integer uint32 version; сохранён raw SHA и clocks | Сохранить typed numeric observation в namespace IGCVersion_570 |
| Клиент и сервер сообщают разные active_version | Сохранить оба ответа, указать несогласованность; не выбирать один автоматически |
| Значение изменилось между captures | Это кандидат на сигнал смены технической версии; не доказательство изменения баланса или состава патча |
| Значение не изменилось | Не доказательство непрерывности версии, отсутствия server-side hotfix или свежести кэша |
| Известен только технический номер | patchLabel=NULL, prospectivePatchEvidence=[] |
| Есть последняя публикация7.41f и technical number6969 | Не соединять по близости даты; correspondence остаётся непроверенным |
| Есть независимая, применимая к scope связь exact technical version→exact balance patch с собственными source/clocks/review | Отдельный последующий review может подготовить active_version proof; не auto promotion |

Минимальная projection в manifest:

```json
{
  "kind": "valve_gc_numeric_version_observation",
  "appId": 570,
  "clientActiveVersion": "6969",
  "serverActiveVersion": "6969",
  "patchLabel": null,
  "effectiveReleaseAt": null,
  "coverageUntil": null,
  "historicalKnownAt": null,
  "leagueId": null,
  "matchId": null,
  "prospectivePatchEvidence": []
}
```

Это source-bound результат review, **не** новый production schema и не объект, автоматически записанный в registry. В [подготовленный контракт](S1_07_PROSPECTIVE_PATCH_CONTEXT.md) нельзя подставить raw numeric active_version вместо `patchLabel`. Проверка существующей Zod schema с явно synthetic envelope и label="6969" отвергнута именно по patchLabel. Она доказывает только несоответствие формата; строка7.41f могла бы пройти синтаксис, но это не создало бы доказательства соответствия. Название source field `active_version` не равнозначно нашему reviewed evidence kind.

## Проверки и воспроизводимость

Raw SHA проверены для4 artifacts; три payload shapes проверены отдельно; два IGC метода подтверждены официальным API list. Малые raw snapshots включены в репозиторий с LF, их SHA можно воспроизвести из checkout. Manifest фиксирует4 backend requests отдельно от поиска/просмотра официальной документации в браузерном инструменте. Browser-open API endpoints не вернул читаемых данных; evidence получено прямыми backend GET.

One-off capture: timeout15s, redirects запрещены, максимум1MiB наversion body, минимум1100ms между тремя version GET; прекращение при429/5xx вместо немедленного повторного запроса. Последующий API-list GET ограничен4MiB и выполнен отдельно, спустя27с. Все ответы200, лимиты не достигнуты. Автоматизации, фонового опроса, установки клиента или запросов с publisher credentials нет.

Одноразовый review сначала не нашёл zod из корня monorepo; исправлен import через существующий contracts package, без установки dependencies. После этого все4 SHA/3 shapes/2 methods/label probe PASS. Итоговые frozen install/typecheck/test/build и документационные проверки записаны в PROGRESS. DB integration/browser/Python/backtest не запускались; рабочая БД не читалась и не изменялась, сервисы не перезапускались. Новых постоянных tests/production helpers для source-only review не добавлено.

S1-07/S3-01/corpus gates остаются открытыми. Прежние16 недавних карт по-прежнему patch unknown, последние saved strict previews36/0 не пересчитывались. Проверка технической версии не закрывает pre-start lineup/teams/heroes, размер выборки, backtest или calibration.

**Следующий шаг S1-07:** одна ограниченная проверка первичного соответствия IGC technical version→balance patch в данных игрового клиента Valve. Требуются exact version, patch label и происхождение одного согласованного snapshot; не брать mapping из даты новости или стороннего трекера. Если доступного подтверждения нет, завершить эту ветку явным source blocker и предложить владельцу конкретный альтернативный scope, вместо новых таких же диагностических CLI. Модель: **GPT-6 Astra · High**. Полный download/установка Dota2 не входят в этот шаг.
