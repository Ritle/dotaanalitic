# S1-10 — предстоящие матчи и ручной состав для сценария

## Работа с экраном

После входа владельца откройте **«Предстоящие матчи»** (`/upcoming`), нажмите «Обновить расписание», выберите встречу и «Обновить составы». Показаны до20 строк первой страницы PandaScore, турнир/стадия, плановое время **МСК**, BO-формат серии и ожидаемые игроки. Время получения источника отдельно показано в UTC. Порядок заявки не назначает роли или Radiant/Dire. Шесть игроков отображаются полностью, без first-five fallback.

При ошибке источника последнее расписание сохраняется с предупреждением. Loading/error/empty/не настроенный источник/stale имеют явные состояния. На360px таблица прокручивается внутри панели; кнопка выбора находится рядом с названием встречи и видна без скролла вправо.

Блок **«Выбрать игроков для анализа одной карты»** принимает две разные организации и десять разных canonical player IDs из локального справочника с ролями/заменами. Подтверждение и существующие server-side scenario checks обязательны. После сохранения открывается обычный редактор сценария/отчёты. Из расписания предложены только название и плановое время. **PandaScore IDs не копируются в canonical team/player/league/series IDs.** Native side, series UUID, номер карты и expected canonical baseline остаются неизвестными до ручного редактирования.

Связь provider→canonical пока неизвестна; автоматического анализа заявки одной кнопкой ещё нет. Поиск по имени/ID прямо в форме реализован в [S1-11](S1_11_CATALOG_PICKER.md); запись выбирается явно. Ручной сценарий подтверждает выбор владельца, а не официальное участие игроков в карте.

## API и хранение

Требуется `pnpm db:migrate`: forward-only **019_upcoming_schedule.sql** добавляет `upcoming_source_cache` и `pandascore_request_quota`; SQL001–018 сохранены. `PANDASCORE_API_TOKEN` читается API только из локального `.env`; без ключа ответ сообщает unavailable и не обращается к провайдеру. Новых библиотек нет.

| Маршрут | Действие |
|---|---|
| GET `/api/v1/upcoming` | Чтение сохранённого расписания |
| POST `/api/v1/upcoming/refresh` | Обновление отсутствующего/истёкшего кэша |
| GET `/api/v1/upcoming/tournaments/:id` | Чтение сохранённой заявки |
| POST `/api/v1/upcoming/tournaments/:id/refresh` | Обновление заявки для турнира из сохранённого расписания |

Все endpoints требуют owner session, POST — Origin/CSRF и пустой body. Неизвестные query/body fields и неверные IDs отклоняются. Ответы no-store/Zod DTO не содержат token/provider error body. Отражённый ключ отклоняется до publish и при чтении. Exact endpoint и fetchedAt не позже DB clock обязательны.

TTL5мин считается PostgreSQL. Lease90с защищает от параллельных refresh и поздних writers; HTTP выполняется вне транзакции. Ошибка сохраняет последний payload и retry минимум60с. Runtime HTTP-попытки используют атомарную общую квоту **900/час UTC**, spacing4с, сохранённые Retry-After/remaining=0 cooldown. Квота переживает restart. Индивидуальный запрос ограничен2 попытками; fresh-cache/lease-loser не делают HTTP. Обновление запускается кнопкой; фоновых jobs нет. `schedule:audit` остаётся отдельным bounded ручным diagnostic S1-09.

Текущий mutable cache не является historical training evidence, профессиональной меткой, canonical identity claim или модельным snapshot. BO5 из расписания не разрешает прогноз серии. Manual scenario сохраняет свой immutable input. Prediction gates не закрывались.

## Проверки

[Живой server-service smoke](evidence/s1-10-upcoming-live.json) сохранил20 upcoming rows и8 roster teams турнира22231; выбран Team Yandex—Team Spirit/1753769. **2 GET PandaScore**, затем cache replay без нового quota claim. Записаны только2 provider cache rows и quota state. [Manifest](evidence/s1-10-upcoming-live.manifest.json) связывает SHA `9750a8f1ba314d30b4e37f087f9373cf6b5336a3535a0a11cf8d8552bfbd44af` и9 source/runtime hashes. Capture выполнялся параллельно E2E и видит1 действующую test DB; независимый финальный manifest подтверждает **temporary_databases=0**. Maps1/players10/account_proofs10/revision20/owners0/scenarios0/datasets0/models0 сохранены.

PASS: frozen install/typecheck, **422 unit** (5 новых), build, **10 PG/API** новых случаев, **4 SQL baseline**, **56 Node**, полный **16 Chromium E2E** (2 новых). API cases покрывают auth/no-key, cache reuse,6-player roster, stale fallback, reflected token, leases/late writer, quota race/hour roll/cooldown и schema/provenance. Регрессия exact endpoint/future fetchedAt сначала падала и исправлена. API restart fixture исправлен общим тестовым CSRF signing secret; production auth не ослаблялась. Первичный E2E import исправлен на относительный helper без новой зависимости.

Desktop/360px PNGs просмотрены; после первой проверки выбор перенесён в колонку встречи, полный E2E затем прошёл. Screenshots в ignored `apps/web/test-results/upcoming-{desktop,mobile}.png`, все данные на них явно синтетические.019 применена и replay дал19 SKIP. Verifier/golden, docs/diff проверены. Docker/TLS/restore/remote CI/Python не запускались. API/Vite тестов завершены, native PG сохранён.

**S1-11 выполнен:** записи можно искать и явно выбирать прямо в форме. Текущий следующий шаг — S1-12, актуализация каталога из проверенных numeric source IDs; [handoff и ограничения](S1_11_CATALOG_PICKER.md). Поиск имени не создаёт автоматическую PandaScore→Steam identity связь. История профессиональных карт расширяется отдельным импортом.
