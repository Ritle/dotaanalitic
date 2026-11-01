# S1-14 — обновление pro-истории из интерфейса

На странице организации (`/teams/:id`) появился блок **«Обновить pro-историю»**. Владелец запускает загрузку до10 завершённых карт по сохранённому числовому ID OpenDota. Отображаются очередь, выполнение, завершение, частичный результат или ошибка; количество обработанных/повторных/исключённых карт, ошибки источника, конфликты и время получения данных. После терминального результата автоматически перечитываются текущие описательные отчёты.

## Запуск

```powershell
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
# Во втором терминале:
pnpm worker:dev
```

Нужна миграция **020_history_refresh.sql**. Рабочая019 и предыдущие SQL не изменены;020 применена локально, повтор мигратора дал20 SKIP. Единственного владельца по-прежнему создаёт `pnpm owner:create` в локальном терминале со скрытым вводом пароля. Web открывать по `WEB_ORIGIN`, обычно `http://localhost:5173`. Worker необходим для обработки: API ставит durable job и возвращает ответ сразу. Закрытие вкладки/API не удаляет задание. Остановка worker оставляет очередь до его следующего запуска.

## API и очередь

- GET `/api/v1/teams/:id/history-refresh` — состояние последнего запуска владельца и доступность источника. При отсутствии запуска не создаёт job и не обращается к OpenDota.
- POST того же маршрута — запуск либо возврат существующего активного/недавно завершённого задания;202 с `HistoryRefreshResponse`. Body/query пустые, ID — bigint-safe decimal string. Нет организации →404, неверные поля →400, auth →401, Origin/CSRF →403, очередь недоступна →503. Для организации без положительного OpenDota ID возвращается `available:false`, `run:null`, без задания.
- Все ответы owner-only/no-store. GET не расходует provider quota. POST защищён Origin/CSRF и rate limit20/min; дополнительный durable cooldown действует на организацию. Свободный provider ID/URL/sample из браузера не принимается.

`history_refresh_runs` хранит состояние, owner/canonical team/provider ID snapshot, попытку, progress, safe audits и cooldown. Исторические данные/предсказания не меняются этой таблицей. Run row и pg-boss job коммитятся **одной транзакцией**; ошибка enqueue откатывает run. Advisory lock и unique partial index дают одну активную запись на организацию, в том числе между API-процессами. Job ID совпадает с run UUID, очередь `opendota-team-history` использует `exclusive` policy и numeric canonical team singleton key. Producer общий в `packages/ingestion`; worker регистрирует history consumer рядом с прежним map consumer. Pg-boss own schema остаётся отдельной.

Пока запуск queued/running, повторные клики возвращают тот же run. После завершения — минимум5 минут cooldown, после partial/error — минимум60 секунд (при доступном Retry-After может быть больше). API GET сверяет незавершённый run с job: cancelled/failed/missing/неожиданно completed job переводит зависшее состояние в error/partial. Это локальное согласование состояния, без HTTP к провайдеру. Старый результат не выдаётся за продолжающееся бесконечное выполнение.

## Выполнение и корректность

Worker использует **неизменённый S1-13 capture/eligibility pipeline**: fixed cutoff, последние завершённые карты numeric organization, SHA/endpoints/clocks/inventory, positive pro tier, согласованность discovery/detail и завершённый исход. Дальше существующий `IngestionService` импортирует проверенные сохранённые responses. Дополнительного скачивания каждой карты при импорте нет. У каждой карты собственная идемпотентная транзакция и прежние conflict receipts; вся партия не обещает global atomicity/exactly-once.

На одну попытку максимум39 HTTP attempts:1 discovery +2 references +до10 details, с ограниченными retries клиента. **Общая PostgreSQL quota**/Retry-After продолжают действовать между API/worker/CLI. History worker допускает максимум3 попытки pg-boss с delay/backoff; долговременный provider cooldown может остановить следующую попытку до HTTP. После исчерпания попыток — явный error/partial и возможность нового запуска после cooldown. Постоянные source errors не повторяются бесконечно. Экспирация/abort перед следующей картой останавливает обработку; уже завершённые карты можно безопасно переимпортировать.

Каждая новая попытка получает token и возрастающий номер. Поздняя старая попытка не может забрать run или изменить его progress/terminal status. Проверка token выполняется перед каждой картой и при записи результата. Уже начавшаяся canonical-map transaction сохраняет собственные idempotency/conflict guards. В safe audit каждой попытки — source hashes/times/endpoints, eligibility/reasons/error codes и capture SHA; оригинальные chats/profiles/credentials не сохраняются в run и не возвращаются API. Нормализованные map receipts и references сохраняются прежним importer. Неизвестные accounts/roles/patch/series остаются unknown; canonical identities не создаются и не backdate-ятся. Обучение и активация моделей не запускаются.

UI использует Vue Query: polling3s для queued/running,10s во время cooldown; повтор запуска блокируется на кнопке и сервером. Ошибка проверки состояния имеет отдельный retry. Без source ID кнопка disabled с объяснением. После завершения invalidation затрагивает только mutable catalogue/pro-maps/roster/player-heroes/strength/compare; сохранённые immutable scenario reports не пересчитываются. Для новых frozen report versions сохраняется явное действие владельца.

## Проверки и границы

Новые8 API/PostgreSQL cases проверяют auth/Origin/CSRF/strict input, zero side effects GET, недоступный source ID, concurrent duplicate POST, restart, running click, actual captured import, exact-map replay, cooldown, partial/permanent/transient source failure, cancelled job, fencing и rollback enqueue. Network transport в них **явно синтетический**, БД disposable. Первый прогон показал смешение src/dist классов ошибки в фикстуре; fixture/client/worker приведены к одной сборке, production guards не ослаблялись.

Новые2 Chromium cases проверяют кнопку, queued/running/completed после reload, запрет повторных кликов, автоматический переход N0→2, partial N1, GET failure/retry и source-unavailable. Desktop/360px screenshots просмотрены, overflow отсутствует; ignored `apps/web/test-results/history-refresh-{desktop,mobile}.png`. Это синтетические UI-проверки, не новые официальные результаты матчей. Реальная source coverage остаётся отдельным [S1-13 audit](S1_13_CURRENT_HISTORY.md).

Pg-boss12.38.0 уже был установлен для worker; S1-14 подключает ту же pinned библиотеку к ingestion для общего producer/consumer. Lockfile обновлён **pnpm**, frozen install прошёл. Никаких Redis/новых сервисов. Рабочие данные S1-13 не пополнялись синтетикой, сетевые вызовы OpenDota/PandaScore в этом срезе не выполнялись. Итоговые проверки и состояние — [PROGRESS](PROGRESS.md), [PROJECT_STATE](PROJECT_STATE.md).

Итог PASS: frozen install/typecheck/434 unit/build,8 PG/API history +18 прежних ingestion/queue,4 SQL baseline,60 Node и полный19 Chromium E2E.020 applied/replay20 SKIP; verifier/golden/docs/diff PASS. Native PostgreSQL сохранён, test DBs удалены, API/Vite завершены. В рабочей БД history runs0/owners0, прежние10 pro-карт/21 players/53 participant links, datasets/models0. Remote CI/Docker/TLS/restore/Python в этом срезе не запускались.

Следующий срез — **S1-15: сводка выбранной предстоящей встречи в `/upcoming`**, после явного выбора canonical организаций: N/даты/источник/предупреждения, обновление обеих историй через S1-14 и ссылки на существующие отчёты. Ручной выбор5 изN и подтверждение ролей сохраняются; nickname/provider IDs не объединяются. Модель — **GPT-6.1 Sol · Medium**, поскольку следующий срез использует готовые API и компоненты UI.
