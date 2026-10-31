# S2-01 — сохранённый сценарий одной карты

Владелец продолжил предложенную после S1-08 ветку S2-01. S1-07 остаётся открытым prerequisite для prediction; сохранение сценария не активирует модель и не создаёт training target.

## Реализованный контракт

- `/scenarios` — список; `/scenarios/new` — создание; `/scenarios/:id` — редактор и история.
- `GET /api/v1/scenarios?offset=0`, `POST /api/v1/scenarios`, `GET /api/v1/scenarios/:id`, `PUT /api/v1/scenarios/:id`, `GET /api/v1/scenarios/:id/history?offset=0`.
- POST принимает `ScenarioInputSchema`; PUT принимает `{expectedRevision,input}` целиком. Состав, baseline и контекст меняются одной транзакцией. Отдельные planned `/lineup`, `/expected-lineup`, `/context` пока не предоставляются. Это минимальный атомарный срез вместо нескольких конкурирующих способов редактирования одной редакции.
- Название, две разные организации, UTC cutoff, optional planned start; явно подтверждённые владельцем 10 разных canonical player IDs с ролями 1–5 и stand-in флагами. Все IDs проверяются по локальному каталогу, bigint никогда не преобразуется в Number. Неполный ввод остаётся в форме, не сохраняется как confirmed.
- Optional expected five независимо для A/B: ручная база сравнения, не официальное обещание участия и не источник фиксированного штрафа. Одни игроки могут повторяться между выбранным и ожидаемым составом; внутри каждого набора стороны не пересекаются. Stand-in baseline остаётся в полном JSON snapshot; SQL003 baseline projection хранит только player/role/source/confirmation, как предусмотрено исторической схемой.
- Nullable series ID, номер карты, счёт до карты, Radiant slot, first-pick slot, venue/stage. Никаких дефолтных сторон/первого пика/турнирных данных. Счёт задаётся парой и суммируется в `mapNumber - 1`. При известной серии проверяются обе организации (в любом порядке), best-of и отсутствие уже выигранной серии. A/B-счёт не переориентируется по stored series slot. Только контекст одной карты; series/live prediction не реализована.
- Planned start — пользовательская гипотеза (`eventAt` snapshot), не фактическое начало профессиональной карты. Cutoff не позже known planned start; будущий cutoff допустим как настройка планируемого сценария, а не как доступная будущая история.

## Запись и provenance

Migration015 добавляет `scenario_input_snapshots`: PK `(scenario_id, revision)`, полный input JSONB, SHA-256, manual source и серверный `recorded_at`. Исторические SQL001–014 не меняются. Trigger запрещает UPDATE/DELETE snapshot, проверяет текущую revision при INSERT и самостоятельно ставит clock_timestamp независимо от присланного времени.

Транзакция блокирует принадлежащий владельцу scenario `FOR UPDATE`, сверяет expected revision, проверяет references, обновляет текущие SQL-проекции и добавляет новый snapshot. Два конкурирующих сохранения одной revision дают один успех и один409; проигравший не меняет историю/состав. Ошибка catalog/series откатывает всё. Hash считается по валидированному DTO с сортировкой ролей, его порядок полей задаёт Zod; это fingerprint входа, не model/data revision.

Response содержит source `manual`, server `recordedAt`, `knownAt=recordedAt` исключительно для утверждения владельца, `predictionEligibility='not_assessed'` и `OWNER_ASSERTION_ONLY`. При записи после cutoff добавляется `RECORDED_AFTER_CUTOFF`. Нельзя использовать это как verified historic lineup proof или backdate knownAt до пользовательского cutoff. Snapshot не добавляет receipt/context fact, не меняет match_players и не запускает training/inference. Времена HTTP имеют миллисекундную точность; PostgreSQL сохраняет исходную серверную точность. Для будущего as-of reader сравнивать исходный SQL timestamp, не выводить historic eligibility из rounded transport timestamp.

Все операции owner-scoped; mutations требуют existing Origin/CSRF guard; ответы no-store. Ранее сохранённые predictions/reports не изменяются. Последующая S2-02 расширила общий snapshot contract для героев: old-client PUT без draft при существующих героях/банах блокируется409; явный full draft меняется атомарно. [Текущий draft contract](S2_02_DRAFT_LAB.md).

Списки/история возвращают20 строк и `hasMore`; offset0–10000. Legacy scenario без snapshot не выдаётся как подтверждённый новый сценарий. Delete/clone, контекстные evidence proofs и durable analytics cache не входят в этот ticket.

## UI и проверка

Форма сбрасывает подтверждение при правках. Серверные snapshots кешируются Vue Query, редактируемая копия отделена от кеша; ожидаемый состав тоже копируется. Фоновая загрузка не перезаписывает незавершённый ввод. При409 правки остаются в форме; кнопка явно загружает последнюю редакцию с заменой локального ввода. История показывает старые имена/составы/контекст и даты, не пересчитывает их через новые данные.

Проверки: contracts для incomplete/duplicate roles/players, confirmation/provenance injection, scores/time и baseline; real disposable PostgreSQL/API для auth, ownership, atomic concurrent edits, immutable history, server clocks, series orientation и rollback. Chromium проверяет create/reload, baseline, две вкладки с409, явный reload, edit и responsive360px. Синтетические fixtures существуют только в тестовых БД и не являются pro статистикой или моделью.

Следующий ticket по выбранной ветке — S2-02 Draft Lab. До production probabilities необходимо вернуться к незакрытым S1-07 и всем model/coverage gates.
