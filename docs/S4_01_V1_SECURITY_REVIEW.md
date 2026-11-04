# S4-01/V1 — проверка защиты owner HTTP API

**Продолжение:** [S4-01/V1-queue-coverage](S4_01_V1_QUEUE_COVERAGE.md) исправил и проверил finding S4-SEC-03 для текущего native backup verifier:78 entries включают pg-boss, queued data сохранены, подмена обнаруживается. Описания открытого finding и next task ниже относятся к историческому security checkpoint; старый evidence не менялся. Следующий текущий срез — provider resilience review.

Дата:2026-11-03. Проверены текущие localhost owner API: сессия, CSRF/Origin, no-store, ограничения запросов и исключение исходного пользовательского ввода из ошибок/логов. Это ограниченный code/contract review и regression QA; VPS/HTTPS deployment и выпуск модели в этот срез не входят.

## Подтверждённые нарушения и исправление

1. Fastify router отклонял malformed percent-encoding и слишком длинный параметр до auth/onSend/error hooks. Стандартные ответы400/414 отражали переданный URL, были на английском и без Cache-Control. Новый `frameworkErrors` в `apps/api/src/app.ts` сохраняет400/414, возвращает безопасный русский structured error/requestId и явно ставит `no-store`. Внутренняя framework failure остаётся500 с generic message. Исходный error.message/path не сериализуется. Эти parse errors не выдают данные и не являются обходом сессии.
2. Request serializer удалял query, но сохранял raw path с параметрами, включая неизвестный путь. Теперь лог содержит только зарегистрированный route template либо `[unmatched]`, HTTP method, remoteAddress и request ID. Сырые параметры/query/body, cookie/CSRF/Authorization и внутренний exception text не попадают в request log.

До изменения production code три targeted regression cases были красными. Уточнённый red run сохранил корректное ожидание414 для длинного параметра. После исправления первые3 targeted PASS. Расширенная матрица сначала выявила две ошибки самой фикстуры: имя history table и отсутствие forecast segment в result paths; они исправлены по SQL/route source, `.hasRoute` не позволил принять защиту несуществующего endpoint за покрытие. Финальные6 matrix cases PASS. Первоначальный общий typecheck выявил generic reply.send incompatibility: callback явно типизирован FastifyReply без any, окончательный полный typecheck PASS.

## Область матрицы

Реестр примеров — `tests/helpers/security-routes.ts`:31 GET и18 изменяющих method/path пар (17 POST+1 PUT), всего49 private handlers, плюс31 автоматический HEAD вариант. Для каждой записи проверяется реальное наличие маршрута и anonymous401/no-store. Для всех18 mutations отдельно проверяются отсутствие/неверный CSRF, отсутствие/чужой Origin и cross-site Fetch Metadata:403/no-store до контроллера. Это80 anonymous и90 forbidden requests внутри6 integration cases, а не170 отдельных тестов.

Global owner hook остаётся обязательным для новых routes. Public exceptions — GET `/health`, POST `/api/v1/auth/login` и metadata-only CORS OPTIONS; preflight не даёт private data. Login проверяет Origin, все прочие mutations требуют сессию и session-bound CSRF. Существующие auth tests отдельно проверяют Argon2id/hashed session, expiry/revocation/rotation/reset, один owner, login rate budget/forwarded-header spoofing, cookie options HTTPS config и безопасные ошибки. Протоколы авторизации и пароль владельца не менялись.

Проверены parsing/validation/lookup/handler errors400/413/415/404/500 и ранние400/414. No-store проверяется и на denied/error responses; JSON не содержит synthetic private marker. Проверки не вызывают внешнего провайдера и не создают scenario/prediction/outcome/target/history-refresh records. Rate/admission checks текущего models endpoint выполняются вместе с auth/security suite. Полное поведение upstream retry/quota/provider conflicts остаётся отдельным следующим срезом S4-01.

## Следующий срез

**S4-01/V1-queue-coverage:** устранить пропуск pg-boss в backup/restore fingerprint verification и подтвердить сохранность queued data в изолированной восстановленной БД. Исходную очередь и задание владельца не отменять/не переписывать. Затем отдельно проверить provider timeout/429/Retry-After/5xx/quota/idempotency/stale/partial. Общие S4-01/S4/release gates не закрыты. Рекомендуемая модель: **GPT-6.1 Sol · High**.

## Итоговый QA и рабочая проверка

Frozen offline install, окончательные typecheck/build,727 unit/CLI,21 selected PG и7 selected Chromium PASS.727 unit/CLI прошли одним запуском. PG21=6 новых security+11 existing auth+4 model readiness. Browser7=5 auth+2 readiness; остальные50 предыдущего full57 в этом срезе не перезапускались, UI/domain code не менялся.

Первый стандартный Node run:59/64 PASS,5 старых CLI spawnSync timeout/null status. Причина задержки не установлена. Только5 затронутых файлов повторены с `--test-concurrency=1`, исходными child timeouts и неизменённым кодом:20/20 PASS. Пять прежних failures входят в эти20; итог64 уникальных cases, не79. Единый чистый full64 run не заявлен. Все initial/red/fixture/typecheck/timeout логи сохранены, лимиты не повышались.

Рабочий localhost owner smoke8 checks PASS/0 pageerrors: sanitized400/414 и no-store, anonymous401, действительный NO_ACTIVE_MODEL/null, missing-CSRF/foreign-Origin403, safe404, logout/old-cookie401. POST mutations в smoke были отклонены; только login/logout меняли состояние сессии. Provider calls этого smoke0; новой training/evaluation/activation не было.

В сравнении65 public relations неизменны62. Ожидаемые изменения: auth budget и1 собственная новая revoked session;12 прежних sessions unchanged. Третье изменение — history_refresh_runs0→1 для Aurora Gaming, createdAt `2026-11-03T18:14:33.130Z`, до первого нового теста и до smoke. Владелец **подтвердил ручной запуск** отдельным ответом. Статус queued, attempt/processed/accepted0, sourceFetchedAt null; соответствующий pg-boss job created/unstarted. Задание не отменялось и не изменялось. Сценарии/прогнозы/snapshots/active/release/E1/activations0, прежний report SHA/34 protected artifacts/34 SQL ledger SHA/frozen bundle/compiled inference closure сохранены, compatibleRuntime:true.

### Отдельный открытый finding S4-SEC-03: область сверки очереди

Старые helpers и production `scripts/lib/local-restore-drill.mjs` используют SQL `nspname NOT LIKE 'pg_%'`. Underscore здесь wildcard: фильтр исключает также `pgboss`. Поэтому прежняя таблица сравнения65 relations покрывает **public**, а не всю БД. Сам pg_dump запускается без schema exclusions; потери очереди в dump не установлено, но сравнение её восстановленных fingerprints не было доказано. Исторические evidence/SQL/model artifacts не переписывались.

Новая read-only текущая инвентаризация с `nspname !~ '^pg_'` содержит78 relation entries:65 public+13 pgboss, включая partition parents/children (не независимые события). Это новый полный baseline, а не задним числом придуманная before-сверка pg-boss. Очередь могла изменяться параллельно; её before-fingerprints не сняты. Finding оставлен открытым для следующего среза. Evidence: `docs/evidence/s4-01-v1-security-review.json`.

Полный standalone PG suite, полный browser57, Python/Docker/VPS/HTTPS/offsite/remote CI и новый backup drill не запускались. HTTPS cookie options проверены synthetic production config в существующих auth tests; реальный TLS deployment этим не подтверждается.
