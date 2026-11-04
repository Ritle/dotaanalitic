# S4/V1 — актуальный статус реестра модели на Home

Дата:2026-11-03. Home читает защищённый `GET /api/v1/models/readiness` вместо фиксированного сообщения об отсутствии опубликованных моделей. Новый HTTP adapter вызывает существующий `V1ModelRegistry.readiness()`; проверка release evidence/активации остаётся прежней. Новых training/evaluation/activation действий, provider calls, SQL или dependencies нет.

## Контракт и смысл статуса

`V1ModelReadinessSchema`: `stage:pre_match`, server UTC `checkedAt`, `status`, `reason`, nullable UUID `modelId`, nullable release `reportSha256`, **всегда** `teamAWinProbability:null`.

- `unavailable / NO_ACTIVE_MODEL`: активной модели нет; modelId/reportSha256 null.
- `unavailable / ACTIVE_MODEL_EVIDENCE_INVALID`: активная версия существует, но её evidence не прошло прежний gate; modelId сохранён, reportSha256 null.
- `model_eligible / reason:null`: прежний gate реестра пройден; присутствуют modelId/reportSha256. Это не результат проверки сценария и не прогноз.

Сессия владельца обязательна, ответ `no-store`, query строго пустой. Никакого выбора modelId/stage или активации через query. GET ограничен20/min,429 с Retry-After; unexpected DB/contract failures дают безопасный500. UI не получает bundle/file paths, raw artifacts или provider credentials. GET использует прежнюю транзакционную проверку реестра с advisory locks; он не создаёт прогноз/сценарий/снимок/событие активации. В одном API допускается только одна одновременная HTTP-проверка: остальные получают429 `MODEL_CHECK_BUSY`, Retry-After1s. Admission освобождается в finally и после ошибки; ожидающие registry locks не заполняют весь pool, необходимый prediction/history.

## Home

Отдельный блок показывает этап «До драфта · одна профессиональная карта», причину, идентификатор версии при наличии и время проверки UTC. Кнопка выполняет новое чтение; запрос также обновляется при возврате на Home/focus по общему Vue Query policy. Интервального polling нет.

Loading/error и бизнес-недоступность раздельны. При refetch прежний допуск скрыт сразу; при HTTP error или malformed DTO старый успешный статус не показывается.401 очищает auth/query cache и переводит на login. Никаких50/50 или процентов. Даже при `model_eligible` явно указано, что версия кода, составы, более ранняя история и Tier1 scope проверяются отдельно во время расчёта. Статус реестра не доказывает прохождение всех runtime gates.

Новый contracts module подключён только additive re-export. Существующие registry/inference/history modules и compatibility policy не менялись; замороженный executor не перезаписывается.

## Проверки

Новые contract tests проверяют три состояния, null probability, связанность model/release evidence и отказ при лишних/неизвестных полях. API integration через настоящий owner/API/disposable PG проверяет401, no-store, strict query, реальный пустой реестр, rate limit, bounded admission и отсутствие domain writes. Положительный/invalid gate в HTTP projection проверяется только явно synthetic doubles, без реальной активации. Browser проверяет loading, actual no-active registry, UTC time/360px, скрытие stale eligibility при выполняющемся refetch/failure, invalid/malformed/401 и отсутствие вероятностей.

### Исполненный QA

Frozen offline install, typecheck, дополнительный финальный API typecheck и build PASS. Unit/CLI727 PASS одним последовательным запуском:54 analytics+20 contracts+13 web+33 prediction+331 db+228 ingestion+47 API+1 worker. Node fixtures64 PASS/0 skipped. Selected PostgreSQL integration11 PASS:4 новых HTTP/admission tests и7 существующих registry cases, только disposable DB.

Полный Chromium run:56 PASS/1 FAIL. Прежний login test ожидал удаляемую фиксированную фразу Home. В `auth.spec.ts` только этот assertion заменён проверкой фактического no-active registry status; тот же1 case повторён PASS с исходными лимитами.57 уникальных browser cases покрыты с учётом повтора; единого чистого full57 run нет. Новые2 cases прошли в основном прогоне, включая synthetic eligible/invalid/malformed/401. Production code для повтора не менялся. Все исходные логи сохранены в `.tools/s4-readiness-*`.

Рабочий owner browser flow5 checks PASS/0 pageerrors: anonymous401, действительный NO_ACTIVE_MODEL/null/no-store/UTC, повторная проверка, desktop/360px без overflow, logout и401 с прежней cookie. Первый/повторный check остаются чтением реестра; кроме login/logout POST не было. Screenshots synthetic и working просмотрены. Реальная модель не активирована.

Read-only SQL сверил65 таблиц:63 unchanged, только штатные auth_login_budget/auth_sessions(+1 revoked). Все10 прежних sessions неизменны. Source cache/quota/observations, прежний report SHA,33 protected artifacts и34 migration-ledger SHA сохранены. Старые compiled runtime modules совпали, кроме contracts barrel: удаление единственной новой export строки восстанавливает прежний SHA. Добавлен только новый contracts module; полный frozen bundle verified, `compatibleV1Runtime:true`, policy не менялась. Active/scenarios/predictions/snapshots/release/E1/activations0; working artifacts1/reports1. Provider calls0, ни обучения, ни реальной оценки/активации.

Evidence: `docs/evidence/s4-v1-model-readiness-status.json`. Полный standalone PG suite, Python, Docker/VPS/HTTPS и remote CI не запускались. Общий S4 и независимые quality/release/active-model restore gates открыты.

## Следующий срез

**S4-01/V1-security-review:** проверить полноту защиты текущих owner HTTP routes, no-store/CSRF/Origin/rate limits и отсутствие секретов в ошибках; исправить только обнаруженные нарушения с regression tests. Без VPS/deploy или изменений model gate. Общий S4, независимая оценка качества и active-model restore остаются открытыми. Рекомендуемая модель: **GPT-6.1 Sol · High**.
