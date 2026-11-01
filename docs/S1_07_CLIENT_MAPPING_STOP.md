# S1-07 — client mapping проверен, source branch остановлена

**Решение 2026-11-01:** ограниченная проверка закончена без подтверждения связи technical version6969→balance patch7.41f. Source branch остановлена до появления существенно нового evidence. S1-07 не закрыта; прежние patch/as-of/quality gates сохранены. Подготовлено отдельное [предложение S3-01 E0](S3_01_E0_RESEARCH_PROPOSAL.md), ожидающее выбора владельца.

## Что проверено

Локальная read-only проверка HKCU Steam installation metadata и libraryfolders показала одну зарегистрированную библиотеку. В её metadata не указан app570, appmanifest_570.acf в ней не найден. Это не полный поиск по дискам и не утверждение об отсутствии любых копий Dota2. Пользовательские credentials/config/logs не читались; установка/обновление/скачивание игры не выполнялись. Локального установленного client snapshot для проверки не получено.

Дополнительно рассмотрены три выбранных файла community mirror [SteamTracking/GameTracking-Dota2](https://github.com/SteamTracking/GameTracking-Dota2), pinned revision `ee99709f8b6b2cc1a4644c842645c3839ef043b0`. Это не репозиторий Valve и не прямая доставка файлов Steam; совпадение Git blob SHA подтверждает содержимое mirror commit, а не происхождение deployed game bytes.

| Файл в одном pinned snapshot | Наблюдение | Достаточно для mapping |
|---|---|---|
| [game/dota/steam.inf](https://github.com/SteamTracking/GameTracking-Dota2/blob/ee99709f8b6b2cc1a4644c842645c3839ef043b0/game/dota/steam.inf) | ClientVersion6969/ServerVersion6969, appID570, ProductName=dota2_workshop, SourceRevision11175759 | Нет balance patch label и подтверждённой привязки к турниру |
| [game/dota/gameinfo.gi](https://github.com/SteamTracking/GameTracking-Dota2/blob/ee99709f8b6b2cc1a4644c842645c3839ef043b0/game/dota/gameinfo.gi) | В выбранном файле нет строк6969 или7.41f | Не даёт искомой связи |
| [patchnotes_english.txt](https://github.com/SteamTracking/GameTracking-Dota2/blob/ee99709f8b6b2cc1a4644c842645c3839ef043b0/game/dota/pak01_dir/resource/localization/patchnotes/patchnotes_english.txt) | 26238 matching localization tokens /122 разных labels;104 tokens относятся к7.41f; есть старые7.06d/7.06e/7.07/7.07b/7.07c | История текстов разных обновлений, не active-patch selector |

VersionDate/VersionTime сохранены как raw значения Oct27 2026/12:56:06; timezone неизвестен. Их нельзя переносить в verified releasedAt или historical knownAt. Наличие заметок7.41f в клиентских ресурсах рядом с6969 не устанавливает действующий balance label — та же логика ошибочно связала бы6969 со старыми labels из этого файла.

## Граница вывода

Пять backend GET/пять HTTP200: Git ref, полное дерево с truncated=false, затем три selected raw files по закреплённому revision. Timeout20s; tree body<=8MiB, selected file<=4MiB, request budget5; между последовательными запросами минимум1100ms, без retry/pagination. Удалённые scripts/binaries не выполнялись. Полное дерево не означает, что прочитаны все client assets: рассмотрены только указанные три файла; отсутствие mapping где-либо ещё не доказано.

[Manifest](evidence/s1-07-client-mapping-review.json) хранит URL, clocks, SHA-256, parsed projection, local-installation check scope и решение. Все5 artifact SHA проверены,3 downloaded blobs совпали с exact paths в pinned Git tree. Первая локальная проверка ошибочно сопоставила basename gameinfo.gi с game/core/gameinfo.gi и упала; выбор исправлен на полный путь из pinned URL, исходные bytes/SHA не менялись. Финальные3 blob checks PASS.

Полные tree/localization bytes остаются в ignored `.tools/s1-07-client-mapping/`; публичный manifest не включает большие тексты или приватные локальные пути. Checkout содержит проекцию и pins/hashes, для полного replay нужны локальные raw snapshots либо повторное получение тех же pinned URLs. Публикации Valve, OpenDota code60 и IGC endpoints заново не запрашивались.

## Что прекращается

- Повторные попытки вывести balance label из даты новости, coarse provider code, совпадения имён полей или наличия localization tokens.
- Новые однотипные audit CLI/collector/migration для неподтверждённого mapping.
- Попытки заполнить historical knownAt, patch_id или active-version proof предположением. Canonical assignments0/prospectivePatchEvidence=[], probability=NULL.

Source blocker конкретен: **в проверенных доступных источниках нет принятого первичного соответствия exact technical version↔exact balance patch и его scope**. Допустимый повод возобновить ветку — новый источник с таким утверждением и датированным provenance, а не ещё один такой же fetch.

## Альтернатива для владельца

[S3-01 E0 research proposal](S3_01_E0_RESEARCH_PROPOSAL.md) — отдельный offline player-mean Elo эксперимент без patch features, с event-time reconstruction и явно восстановленной фактической пятёркой. Его результаты не являются prospective accuracy; production source/identity/patch/readiness gates и published-model требования не ослабляются. Даже исследовательская метрика не гарантирована: если нет пригодного holdout, вывод NULL с причиной.

Такой выбор позволяет проверять полезность и воспроизводимость baseline без продолжения нынешней source ветки. Он не обещает прогноз на ближайшую встречу. Реализация E0 не начата: это изменение порядка задач и исследовательского cohort, требующее явного выбора владельца по AGENTS§5.1/§10. До выбора никакая новая ветка не назначается автоматически.

Штатные проверки и итоговые результаты этого documentation/evidence среза — в PROGRESS. Production code/SQL/DB/UI не менялись, service restart/training/model activation не выполнялись.

Последующее решение владельца2026-11-01: «Выполнить исследовательский E0 (рекомендую)». Переход в описанный S3-01 E0 scope разрешён; прежние формулировки ожидания выше относятся к моменту предложения. S1-07 и production gates сохранены. Source review manifest фиксирует состояние до выбора и не переписан.
