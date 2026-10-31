# S0-08 — live-аудит покрытия OpenDota, 2026-10-31

## Результат и предел применимости

Выполнены **пять live-запусков, 40 уникальных карт**: 20 из текущей страницы proMatches и по 5 карт четырёх лиг The International 2021–2024. Все 40 detailed responses получены; ошибки — 0. Текущий справочник лиг подтверждает professional/premium tier для всех 40. Это ограниченный наблюдательный аудит полей, не оценка точности модели или полноты всей pro-истории. [Manifest, версии кода и SHA-256 отчётов](evidence/s0-08-manifest.json).

Основной capture: **2026-10-31T12:48:36.043Z → 12:49:17.355Z**. Пять запусков выполнили **50 HTTP attempts**, все HTTP 200; 429/5xx и transport errors — 0. Это наблюдение данного запуска, не гарантия доступности API. Каждый запрос проходил существующие PostgreSQL quotas, timeout/retry/Retry-After и максимум attempts CLI. Тестами отдельно проверен учёт recovered 429/503/network failures.

## Выборка и покрытия

Recent: первые 20 уникальных IDs из 100 discovery rows, без отбора по качеству. Исторические лиги выбраны заранее из live /leagues: 13256, 14268, 15728, 16935 (premium). В каждой выбраны 5 равномерных рангов после сортировки start_time → bigint match_id, включая первую/последнюю карту. Кандидатов соответственно 487/231/151/121; все ID соответствуют detailed response и ожидаемой лиге. Это стратификация по году/лиге с последующим разбиением по **наблюдённому provider patch ID**. Не заявляется случайная или репрезентативная выборка всех лиг/патчей; для широкого корпуса остаётся S1-08.

| Группа | Даты карт UTC | Source patch IDs (N) | N | 10 distinct accounts | 10 final heroes | Обе команды / серия | 10 picks / structural consistency |
|---|---|---|---:|---:|---:|---:|---:|
| [Recent](evidence/s0-08-live-recent.json) | 2026-10-29 — 2026-10-30 | 60 (20) | 20 | 20 | 20 | 15 / 15 | 19 / 19 |
| [TI league 2021](evidence/s0-08-live-ti2021.json) | 2021-06-23 — 2021-10-17 | 48 (3), 49 (2) | 5 | 5 | 5 | 5 / 5 | 5 / 5 |
| [TI league 2022](evidence/s0-08-live-ti2022.json) | 2022-10-15 — 2022-10-30 | 51 (5) | 5 | 5 | 5 | 5 / 5 | 5 / 5 |
| [TI league 2023](evidence/s0-08-live-ti2023.json) | 2023-10-12 — 2023-10-29 | 53 (5) | 5 | 5 | 5 | 5 / 5 | 5 / 5 |
| [TI league 2024](evidence/s0-08-live-ti2024.json) | 2024-09-04 — 2024-09-15 | 56 (5) | 5 | 5 | 5 | 5 / 5 | 5 / 5 |

Числитель в таблице — наличие/структурная проверка среди N, не модельный допуск. В каждой группе start, winner, completed outcome, league ID, provider patch, native 10 slots, integer lane_role hints и nonempty raw actions присутствуют N/N. **identity_10 означает десять различных валидных source Steam32 accounts**, а не проверенные canonical people. Canonical identity, verified patch, pre-match lineup known_at, post-draft heroes known_at и strict draft_order_valid **не оценены на всех 40**: знаменатель 0, ratio null. Их нельзя описывать как «40 невалидных» или «40 подтверждённых».

У current recent выборки game_mode 2 — 15 карт, 22 — 5; у всех исторических — 2. lobby_type=1 наблюдался во всех 40. Версию правил/первый пик из этих чисел не выводим. Лига 2021 включает карты начиная с июня; название лиги не доказывает, что каждая карта относится к основному этапу TI.

## Аномалии и ранее переданное evidence

В recent отсутствуют team IDs и ненулевой series ID у пяти карт: 9067217876, 9067149165, 9067078024, 9067007060, 9066936100. Все пять имеют game_mode=22 в этом ответе; причина отсутствия metadata не устанавливалась. **9066936100** содержит 12 pick events с дополнительными hero IDs 2,60, при десяти валидных финальных героях. Raw picks не исправлялись; structural consistency false, draft_order_valid null. В выбранных 20 исторических картах эти структурные аномалии не обнаружены; n=5 на лигу недостаточен для утверждения их отсутствия в периоде.

Сохраняется отдельно [live-аудит владельца 50 карт от 2026-10-27](PREDICTION_DATA_RESEARCH_STATUS.md): owner-reported наблюдения, без сохранённых raw JSON. В нём 12 picks у 9062822180 (extras 31/107), 11 у 9061459911 (extra 31), 0 у 9063023867. Это не реконструированные payloads; соответствующие tests/fixtures помечены synthetic и проверяют формы ошибок. Повторный snapshot 9063023867 в S0-01 уже отличался; источник может меняться. [S0-01 audit 20 карт](S0_01_PROVIDER_SPIKE.md) также остаётся отдельным capture. Эти выборки **не складываются** в 110 независимых наблюдений: перекрытие/метод отбора различаются.

Перед изменением аудитора в S0-08 дополнительно выполнен прежний v2 recent audit 20/20 и один запрос каталога для выбора лиг; они не входят в основные 40 карт/50 attempts manifest. Обобщать HTTP counts v2 нельзя: он не сохранял статусы всех попыток.

## Изменения инструмента и воспроизведение

Audit schema **3** сохраняет все selected IDs, метод/размер discovery, flags всех полученных карт, source timestamp/adapter/SHA, patch/league/mode/date distributions, HTTP counters и safe failure codes. Coverage публикуется по всем наблюдениям и отдельно по current confirmed-pro subset. Failed/partial discovery записывает отчёт и возвращает ненулевой exit code. Ни JSON-ответы целиком, ни account IDs/profiles, ключи или raw error text в evidence не включаются.

Добавлен typed getLeagueMatches через тот же ограниченный HTTP client. Измерение identity исправлено: повторные/вне Steam32 IDs не считаются десятью людьми; пустой/нулевой patch не считается coverage. Canonical bigint IDs остаются строками. Отсутствующий discovery league ID даёт unknown, а не выдуманный конфликт. Synthetic/offline mode маркируется явно и не обращается к БД/сети.

После shared:build и настройки DATABASE_URL:

```powershell
node --env-file-if-exists=.env scripts/audit-prediction-sources.mjs --sample 20 --out reports/s0-08-recent.json
node --env-file-if-exists=.env scripts/audit-prediction-sources.mjs --league 13256 --sample 5 --out reports/s0-08-ti2021.json
node --env-file-if-exists=.env scripts/audit-prediction-sources.mjs --league 14268 --sample 5 --out reports/s0-08-ti2022.json
node --env-file-if-exists=.env scripts/audit-prediction-sources.mjs --league 15728 --sample 5 --out reports/s0-08-ti2023.json
node --env-file-if-exists=.env scripts/audit-prediction-sources.mjs --league 16935 --sample 5 --out reports/s0-08-ti2024.json
```

Повторный запуск создаст новый capture, не обязан воспроизвести прежние source bytes или текущую recent страницу. Report SHA в manifest относится к сохранённому файлу, code SHA — к реально использованным source files. Обзор endpoints подтверждён [первичным OpenDota OpenAPI](https://api.opendota.com/api): /leagues, /proMatches, /leagues/{league_id}/matches, /matches/{match_id}. Таблица схемы league/matches описана менее точно фактического массива: клиент проверяет получаемый array projection, количество строк и ID consistency.

## Следующее решение

Измеренные поля позволяют продолжать описательные экраны и проектирование cohorts. Историческая публичная известность состава/ролей/сторон/героев не доказана. Current league tier и provider patch code не подменяют historic known_at или verified release registry. S0-09 должна закрепить strict verified-asof, owner-asserted и retrospective conditional cohorts; S1-08 — расширить исторический корпус. Новых матчей, canonical identities, registry proofs, dataset/model/prediction эта задача в рабочую БД не добавляла. Результаты тестов — [PROGRESS](PROGRESS.md).

Следующая задача: **S0-09 [P0] Point-in-time data readiness**. Рекомендуемая модель: **GPT-6 Astra · High** по проектной матрице, с учётом риска утечки постматчевого состава.
