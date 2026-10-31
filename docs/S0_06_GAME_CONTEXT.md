# S0-06 — контекст карты, исторические правила и доступность героев

## Реализованный срез

`@dota/db` предоставляет чистую `resolveGameContext`, внутренний writer `GameRegistryRepository` и `GameContextRepository.readAsOf({matchId,cutoffAt,stage,teamAId,teamBId})`. Чтение использует repeatable-read snapshot карты, S0-04 context observations и реестра. Новый HTTP endpoint не добавлен; будущие analytics/scenario services используют этот boundary. Resolution контекста не означает eligibility для обучения или разрешение показывать вероятность.

Миграция **011** добавляет immutable `patch_release_evidence`, `draft_rule_evidence`, provenance существующего `hero_availability_rules` и `game_context_registry_state.revision`. Исторические SQL 001–010 не изменяются. Typed context whitelist расширен полями `league_id`, `game_mode`, `lobby_type`; policy обновлена до `strict-asof-v2`. Сырые provider observations и canonical completed-map поля не становятся verified-asof facts автоматически.

## Время, патчи и доказательства

Каждый новый registry proof содержит независимые event/known/fetched, source, evidenceRef, reviewState и SHA-256. Writer принимает только валидированный контракт; статус accepted задаёт доверенный процесс проверки источника, а не HTTP payload провайдера. Одинаковый proof идемпотентен, включая конкурентные повторы; новый proof атомарно повышает revision. UPDATE/DELETE запрещены. Исправления добавляются, противоречия не разрешаются последней записью; ручной review/supersession остаётся отдельным этапом.

As-of reader допускает accepted/conflict evidence только при `knownAt <= cutoffAt` и event не позже cutoff. Поздний fetch с настоящим датированным архивным доказательством допустим; поздний fetch сам по себе не подтверждает раннюю известность. Нельзя задним числом приписывать knownAt вновь установленным датам или правилам. Миллисекундная точность enforced и Zod, и SQL; микросекунды не округляются к cutoff.

Патч определяется по verified `releasedAt <= actual map start`, а не label/provider patch code или mutable `patches.released_at`. Требуется явный доказанный горизонт `coverageUntil` (exclusive); последний известный патч не продолжается бесконечно. Evidence должно обосновывать и дату релиза, и покрытие указанного интервала. Новая release с закончившимся покрытием даёт gap, не откат к старой release. Разные patch IDs на одной дате или разные даты одного актуального patch ID дают conflict со всеми относящимися proof IDs. Справочник не заполняется выдуманными реальными датами.

## Независимые составляющие контекста

- **Стороны:** Radiant связывается с A/B только если обе подтверждённые команды точно совпадают с запросом. First pick читается независимо и затем переводится в A/B; неизвестная ориентация не мешает сохранить известную игровую сторону первого пика. Массив игроков не определяет сторону.
- **Карта/серия:** mapNumber и seriesId читаются из отдельных verified observations. Не выводятся из времени, победы или `series.best_of DEFAULT 3`. Счёт до карты остаётся сохранённым evidence, но недоступен MVP prediction inputs. Серийная вероятность не реализована.
- **Правила драфта:** exact patch + gameMode + lobbyType выбирают подтверждённую версию. `draftRule.value` означает применимый ruleset, `draftOrderVersion` требует также совпадающего verified map claim. Несовпадение явно предупреждается. **`draftOrderValid` остаётся null:** проверка фактической последовательности действий — P1 S2-05. Ни десять финальных героев, ни версия ruleset не являются такой проверкой.
- **Герои:** eligibility проверяется только для post-draft context heroes, а не наличия героя в завершённой карте. Требуются известные patch/league и rule interval `[validFrom,validTo)`. Nullable scope в явном правиле означает все патчи/турниры; отсутствующее правило даёт `value:null`. Несовместимые allow/deny правила дают conflict без неявного приоритета; явный запрет — false. FK не позволяет создать proof для неизвестного каталожного героя. Частичный draft остаётся частичным.
- **Pre-match:** выбранные герои, первый пик и версия драфта не возвращаются, даже если timestamps claims ранние. Все остальные stage/cutoff/conflict ограничения S0-04 сохраняются; cutoff после старта и конфликт канонической карты отвергаются.

Результат содержит warnings, cutoff/stage, policy versions, registryRevision, map dataRevision и field/proof IDs. Для derived cache нужны все эти версии и входные A/B; один match ID недостаточен. Нет universal decay, новых моделей, эвристического confidence или fabricated 50/50. Raw 0/11/12 picks, final heroes и quality assessments импорта не переписываются.

## Проверки и эксплуатация

`pnpm test:game-context` запускает реальную PostgreSQL-проверку в отдельных временных БД; `pnpm test` включает pure tests. CI содержит новый suite. Synthetic правила/патчи/турниры тестов не описывают настоящие Dota releases и не записываются в рабочую БД.

Перед использованием reader выполнить `pnpm db:migrate`. Legacy hero rules получают unverified status и не используются без нового полного proof; существующие строки сохраняются. Реальная source coverage и исторические evidence остаются S0-08/09. Полный draft timeline validator — S2-05. Следующая задача **S0-07: verified outcomes и frozen datasets**, без реализации DatasetBuilder до S3-00. Рекомендуемая модель: **GPT-6 Astra · High**.

Фактические результаты проверок зафиксированы в [PROGRESS](PROGRESS.md) и [PROJECT_STATE](PROJECT_STATE.md).
