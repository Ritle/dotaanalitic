# S0-03 — личный доступ владельца

Дата: 2026-10-31. Срез реализует auth часть FR-00: один вручную созданный аккаунт, вход/выход, защищённый API и минимальную web форму. Редактирование preferences, аналитика, восстановление email/OAuth и публичная регистрация не добавлены.

## Запуск и создание владельца

После frozen install, настройки DATABASE_URL и всех восьми миграций:

```bash
pnpm owner:create
pnpm dev
# сброс существующего аккаунта:
pnpm owner:reset --login YOUR_LOGIN
```

CLI запрашивает логин и дважды пароль со скрытым вводом; 12–128 символов. Логин — 3–120 ASCII letters/digits/underscore/dot/hyphen, приводится к lowercase. Пароль не обрезается. Не передавать пароль через argv/URL; флага password нет. Для безопасного pipe из менеджера секретов доступны create/reset с `--login YOUR_LOGIN --password-stdin`; stdin ограничен 1024 bytes, stdout содержит только status, не пароль/hash/token.

Уникальный SQL index допускает один app_users row, включая inactive owner. Повторное создание отказывается; reset меняет hash и отзывает **все** sessions транзакционно, не включает отключённый аккаунт автоматически. Account не создаётся из env/миграции. Проверки создают только synthetic owners во временных БД; аккаунт владельца в рабочей БД в этой задаче не создавался и его пароль не выбирался.

Открыть web **точно по WEB_ORIGIN**, обычно http://localhost:5173. localhost и 127.0.0.1 отличаются для Origin. Local HTTP допустим только для loopback origin при development/test. Production требует HTTPS origin и AUTH_COOKIE_SECRET >=32 случайных символов; пустой/короткий secret не запускает API. Секрет хранится в приватном окружении, не в Git.

В local dev без secret генерируется случайный ключ процесса. DB sessions переживают рестарт, CSRF cookie будет перевыпущена GET me после reload. В production ключ должен быть постоянным; его ротация требует обновления CSRF через me.

## Архитектура и API

- `apps/api/src/modules/auth/service.ts`: Argon2id (64 MiB, t=3, p=1), случайные 256-bit session tokens, в DB только SHA-256. Absolute TTL 12 часов; active owner, expiry и revoked_at проверяются на каждом private request. Dummy Argon2 hash для неизвестного login; ошибка credentials одинакова.
- Login повторно проверяет owner/hash под row lock после Argon2, чтобы reset не позволил выдать сессию по старому паролю. Успешный repeat login отзывает предъявленную старую cookie и выдаёт новый token. Logout отзывает запись, удаляет cookies. Нет JWT/localStorage.
- `http.ts`: cookie/csrf/rate-limit плагины Fastify 5. Default guard закрывает все последующие routes; только GET health, POST login и preflight публичны. Новому feature route не нужно вручную вспоминать подключить auth.
- Login: strict JSON `{login,password}`, обязательный exact Origin. Это также защита login CSRF; anonymous token endpoint не нужен. Все авторизованные POST/PUT/PATCH/DELETE требуют exact Origin + X-CSRF-Token из login/me и signed CSRF cookie. CSRF token привязан к конкретному session hash. Cross-site Fetch Metadata отвергается.
- Login/me JSON: `{owner:{id:uuid,login},expiresAt:ISO,csrfToken}`; session token только в HttpOnly cookie. Logout 204. 401 invalid/missing auth, 403 CSRF/Origin, 400 invalid payload, 429 throttle + Retry-After. API ответы no-store; ошибки структурированы, сообщения на русском.
- Production cookies: __Host-session и __Host-csrf, Secure/HttpOnly/SameSite=Lax/Path=/, без Domain. Local HTTP: dota_session/dota_csrf, HttpOnly/SameSite=Lax/Path=/, Secure=false. Режим определяется проверенным WEB_ORIGIN, не недоверенным X-Forwarded-Proto.
- Fastify trustProxy=false: X-Forwarded-For не меняет rate-limit key. Login <=5 requests/IP/minute; все routes <=120/IP/minute. Дополнительно PostgreSQL global budget <=10 credential attempts/15 minutes, независимо от login/IP и перезапуска. Все попытки (включая удачные) учитываются. За reverse proxy IP limit агрегируется по proxy; для одного владельца это консервативный предел.
- Default logger выводит method/path без query и безопасные events/request IDs, не request body/headers/password/token/hash. Error handler не пишет raw exception или SQL. Native Argon2 Windows prebuild реально исполнен; pnpm предупреждает об ignored install script, runtime работает без разрешения произвольных dependency scripts.

Forward-only `008_owner_auth.sql` добавляет single-owner index и persistent attempt budget. 001–007 не изменены; 001–005 golden сохранены. Существующая БД с несколькими app_users откажется мигрировать, данные не удаляются и аккаунт не выбирается произвольно.

`@dota/contracts` теперь собирается в dist с declarations, используется API и web. Root shared:build явно строит contracts/DB/ingestion; Node production runtime не импортирует TS source. Auth UI хранит только display state/CSRF в памяти; server cache/preferences не дублируются в Pinia. Router закрывает dashboard, восстанавливает сессию через me; login/loading/error/logout keyboard states реализованы на existing CSS tokens.

## Проверки

- Frozen install; typecheck; 66 unit tests; build.
- `pnpm test:auth`: 11 tests на настоящем PG16 с отдельной случайной БД; CLI create/reset через stdin child process, single-owner SQL constraint, hash-only storage, rotation/logout/expiry/inactive, default deny, strict payload, Origin/CSRF/different-session token, spoofed forwarded IP, atomic persistent budget/reset, secret-free logging.
- `pnpm test:ingestion`: 16 прежних import/queue regressions, `pnpm test:integration`: 4 baseline DB invariants. 008 APPLIED; повтор — 8 SKIP.
- `pnpm test:e2e`: реальные API + PG и Chromium, mobile keyboard/360px, wrong password, login/reload/logout/back navigation. Отдельные ports 3151/5179 и temporary synthetic owner, без API/DB mocks. Browser traces отключены, чтобы не сохранять credentials/session payloads; screenshots содержат synthetic display state.
- Дополнительный PASS: migration verifier (8/historical golden), Node fixtures (10), docs links; strict preflight DB 7 checks/0 failures/Docker WARN; compiled Node runtime health=200/private me=401. Mobile/desktop screenshots inspected visually. API build и 11 auth tests повторены с Unicode password через UTF-8 stdin.

Начальные сбои исправлены без отключения проверок: остановленный PG запущен; Zod refinement invalid URL теперь сохраняет field-only error; health unit получает explicit synthetic DB config, не подключается к DB; Playwright helper имеет явный ESM context/root env; history regression создаёт реальную предыдущую страницу, потому что login/logout используют replace.

Docker/production Compose/real TLS/remote GitHub Actions/restore drill здесь не исполнялись. CI дополнен auth suite и PG service для real browser auth, production Compose требует secret. Прогнозы и model activation не добавлены, исторические known_at/patch/provenance импорта не изменялись. Push/deploy не выполнялись.

## Следующая задача

**S0-04 [P0] Point-in-time schema / temporal semantics**: started_at/event_at, known_at, fetched_at, map vs series, verified stage availability. Начать с POINT_IN_TIME_AND_MATCH_CONTEXT и текущих field observations; completed lineup не означает pre-start knowledge. Рекомендую **GPT-6 Astra · High** по [routing guide](CODEX_MODEL_ROUTING.md), [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6-astra): это этап с высоким риском временной утечки, не автоматическая смена модели.
