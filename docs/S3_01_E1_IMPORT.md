# S3-01 E1 — импорт исторических карт DreamLeague 25

**2026-11-02:** получены и импортированы все196 карт из [зафиксированного плана E1](S3_01_E1_PROTOCOL.md). Штатный OutcomeVerifier подтвердил196 профессиональных исходов. Повтор тех же source records дал196 duplicate результатов без новых записей или изменения ревизий. Прежние36 карт, включая их слоты, сохранили полные content signatures.

| Показатель рабочей БД | До | После |
|---|---:|---:|
| Канонические профессиональные карты | 36 | 232 |
| Слоты игроков | 360 | 2320 |
| Слоты с canonical player ID | 360 | 1725 |
| Canonical players / account proofs | 165 /165 | 165 /165 |
| Identity revision | 330 | 330 |
| Организации | 35 | 44 |
| Канонические серии | 28 | 28 |
| Provider receipts | 155 | 547 |
| Quality assessments | 114 | 310 |
| Source field observations | 2507 | 6818 |
| Field observations с knownAt | 0 | 0 |
| Patch registry / datasets / models | 0 /0 /0 | 0 /0 /0 |

32 source account IDs пока не связаны с canonical players; неизвестными остаются595 слотов. Полные canonical lineups доступны для65 из232 карт, исходы/финальные герои/команды — для232. У196 новых карт пока нет canonical series reference; source inventory содержит94 provider-серии. Идентичности, серии, роли и патчи не заполнялись догадками. Отсутствует draft events у одной карты; timeline verification отсутствует у всего корпуса.

Проверенные исходы не являются готовыми strict training examples. Source `knownAt` остался NULL, `fetchedAt` отражает реальное получение в2026, event time относится к2025. Наличие полного завершённого состава не подтверждает его доступность до старта. Метрики будущего E1 holdout остаются NULL; его сроки и Elo1500/K32/scale400 не менялись, модель не создавалась.

## Источники и квоты

До импорта выполнен [live source audit](evidence/s3-01-e1-source-audit.json):8 карт из лиги17765,10 HTTP200, без transport errors. Это ограниченный аудит, а не оценка репрезентативности или исторической доступности. Затем для всех196 плановых IDs сохранены full raw observations с источником, временем, endpoint и SHA; отдельно сохранены `/heroes`, `/leagues`, `/leagues/17765/matches`.

Основной capture ограничивался200 HTTP attempts через существующий OpenDota client и PostgreSQL budget. После60 успешных HTTP источник сообщил minute remaining0. Следующие139 записей были отложены до отправки, исходный index сохранён. Resume использовал оставшийся attempt budget, выжидал cooldown/Retry-After; два HTTP429 дополнительно потребовали ожидания. По достижении200 attempts получены195 maps и3 references, остававшаяся карта8200463236 была отмечена request_budget_exhausted.

Для этой одной карты выполнен отдельный явно разрешённый recovery с лимитом3 attempts; фактически потребовался один HTTP200. Итого capture201 attempts:199 HTTP200 (196 details +3 references),2 HTTP429, transport errors0. Вместе с аудитом —211 attempts. Исходный лимит основной партии не менялся, дополнительный recovery учтён отдельно; per-client limit200 и общие minute/day/month guards не ослаблялись. Смена ключей, обход rate limits или ручной сброс quota не выполнялись.

Первая sandbox-попытка аудита остановилась до HTTP; сетевые/DB операции выполнены разрешённым запуском. Исходный blocked report и capture indices остались локально. Это отдельно от исправленного spawn EPERM: обычные typecheck/test/build отработали внутри MXC.

## Проверки перед записью и применение

План с SHA b8306aa23b4779dcd4ee0d26a34ee031767f458634df9e9da4ab37567abaaa62 воспроизведён через прежний E0 export и pinned discovery. Все196 плановых IDs представлены ровно один раз. Проверены raw-file/payload SHA, schema, endpoints, provider, реальные fetch clocks и целостность каталожных наблюдений.

Для каждой карты проверены положительный professional/premium tier, завершённый boolean outcome, лига/старт/source series из плана, согласие с текущим discovery, две разные организации и ровно десять разных source accounts в native slots0..4/128..132. Все восемь пересечений с аудитом сохранили тот же payload SHA. При ошибке исключалась бы вся известная provider-серия; фактически exclusions0. Это import eligibility, не model eligibility; будущий Elo replay применит свои overlap/identity/series gates отдельно.

Перед apply зафиксированы36 существующих maps и counts. Existing IngestionService получал только проверенные локальные captured observations; внутри импорта новых HTTP не было. Первый запуск:196 новых карт,0 duplicate/0 conflict. После этого196 исходов заново подтверждены существующим OutcomeVerifier с receipt/reference binding. Replay:196 duplicate, те же counts/content signatures/data revisions; старые36 карт не менялись. Идентичности и canonical series не provision-ились этим импортом.

## Артефакты и воспроизведение

- [Manifest](evidence/s3-01-e1-warmup-manifest.json): IDs/SHA всех observations/references/indices, request accounting, code hashes и before/after counters.
- [Review](evidence/s3-01-e1-warmup-review.json): полный196-map inventory, eligibility и exclusions до записи.
- [Apply](evidence/s3-01-e1-warmup-apply.json) и [replay](evidence/s3-01-e1-warmup-replay.json): per-map import results, verified outcomes, quality summary и32 unresolved account IDs.

Полные provider bodies, private runtime reports и одноразовые orchestration helpers остаются в ignored `.tools/s3-01-e1-capture/`, `.tools/s3-01-e1-{import-initial,import-resume,import,recover-last,publish}.mjs`. Это настоящие сохранённые responses, не synthetic provider fallback. Capture хранит оригинальные clocks и сырой payload локально; source snapshots в БД используют штатную нормализованную projection. Полные raw профили/чат не публикуются в Git. Manifest SHA не заменяет наличие этих файлов: clean checkout без локального архива не воспроизводит exact bytes.

Импорт осуществлялся `node --env-file-if-exists=.env .tools/s3-01-e1-import.mjs apply`, повтор — `replay`. Их outputs создаются exclusive `wx`, существующие отчёты не перезаписываются. После изменения identity/series registry нужен новый reviewed reimport и новый report filename; существующий replay checkpoint проверяет только прежнюю неизменную конфигурацию. Синтетические fixture данные не применялись к рабочей БД.

## Проверки и следующий шаг

PASS: frozen install/typecheck/505 unit tests/build;27 disposable PostgreSQL cases (importer14/corpus5/outcome verifier8);22 migration files и historical001–005 SHA; source/manifest/code hashes; post-import real OutcomeVerifier196 и duplicate replay196. Production TS/SQL/dependencies/lockfile/API/UI не менялись. Дополнительные тесты для одноразовой data-only orchestration не добавлялись; существующие importer/source/quality boundaries проверены автоматикой и настоящим replay. Browser E2E, остальные API/DB suites, Node fixture runner и Python не повторялись. Работающие сервисы не перезапускались, push/deploy не выполнялись.

**Последующий identity/series срез выполнен:** подтверждены32 numeric аккаунта и94 серии; все196 карт повторно обработаны, ещё один проход196 duplicate. [Отдельный manifest и проверки BO1](S3_01_E1_LINKS.md) сохраняют результат этого import checkpoint неизменным. Следующий S3-01 E1 — executable collector/scoring guard по frozen plan с отказом от ранней оценки. E1 параметры и будущий holdout не подбирать по этим данным. Strict S1-07/S3-01 и prediction quality gates остаются открытыми.
