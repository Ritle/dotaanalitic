# S1-12 — текущий локальный каталог OpenDota

В рабочую БД добавлены **11 игроков и Team Yandex**; существующая Team Spirit переиспользована по точному OpenDota ID. Все11 игроков и обе организации найдены через `CatalogRepository.search`, который обслуживает picker в `/upcoming`. Повтор того же плана создал0 записей. Это ограниченный срез двух организаций, не полный импорт5732 записей источника.

## Реальные записи

Источник: [OpenDota proPlayers](https://api.opendota.com/api/proPlayers) и профили команд [7119388](https://api.opendota.com/api/teams/7119388), [9823272](https://api.opendota.com/api/teams/9823272). Реестр получен2026-11-01T01:00:35.814Z, профили —01:00:36.014Z/01:00:37.400Z. Всего4 HTTP200: первоначальный диагностический GET и3 GET итогового capture, через общую PostgreSQL-квоту. PandaScore не вызывался.

| Локальная запись | Canonical ID | OpenDota / Steam32 ID |
|---|---|---|
| Team Spirit | 1 | 7119388 |
| Team Yandex | 5 | 9823272 |
| DM | 11 | 56351509 |
| Maladych | 12 | 93817671 |
| Saksa | 13 | 103735745 |
| Larl | 14 | 106305042 |
| Batyuk | 15 | 140835095 |
| 医者watson` | 16 | 171262902 |
| AMMAR_THE_F | 17 | 183719386 |
| not_me | 18 | 218231587 |
| CHIRA_JUNIOR | 19 | 312436974 |
| Yatoro | 20 | 321580662 |
| rue | 21 | 847565596 |

Поиск в форме принимает локальное имя/его часть или **canonical ID** из второй колонки. Названия разных источников могут отличаться: например, для записи17 можно искать `AMMAR`. Эта таблица не устанавливает PandaScore→Steam identity links. Одинаковые названия организаций и ники не используются для объединения.

OpenDota сообщает6 членов Yandex и5 Spirit. Все6 кандидатов Yandex сохранены, включая DM; ни роли, ни пятёрка конкретной карты автоматически не выбраны. У Batyuk provider `is_pro/is_locked` отсутствуют — это остаётся unknown, а не вымышленным true. Флаги каталога вообще не классифицируют карты как профессиональные.

## Контракт импорта

`OpenDotaClient.getProPlayers` использует существующие timeout/retry/size/schema guards и durable quota. `prepareCurrentCatalogue` перепроверяет SHA сырых UTF-8 bodies, точные endpoints/числовые IDs, уникальность организаций и аккаунтов, наличие имени и предоставленного источником Steam64. Он выбирает строки по **numeric team ID**, а не по именам. Steam64 обязан точно равняться `76561197960265728 + Steam32` без JS rounding.

Отдельный `reviewed-current-catalogue-v1` не меняет прежний архивный `reviewed-single-account-v1`. Для текущих account observations `eventAt=null`, `knownAt=fetchedAt`; до этого времени эти доказательства недоступны историческому resolver. Template/прямой provider payload не пишется в БД: проверенный файл review отдельно связывается с raw capture и preview.

Расширенный `IdentityProvisioner` проверяет существующие canonical numeric fields, Steam64, verified/provisional/rejected и cross-provider claims. Несколько целей или противоречие блокируют всю партию. Preview read-only; fingerprint охватывает registry revision и текущее состояние выбранных игроков, aliases и организаций. Apply повторно проверяет всё под bounded locks и выполняет одной транзакцией. Ошибка поздней записи alias откатывает также созданную организацию. Уже существующие display labels и связи не перезаписываются; несовпадение team label показывается предупреждением. Роли, roster periods, карты и сценарии не создаются.

Точный повтор допустим после изменения identity revision, если вся партия уже применена и конфликтов нет. Реальная запись:1 team +11 players +11 account proofs +11 aliases =34 вставки; revision20→42. Реальный повтор:0 вставок, те же canonical IDs/revision.

## CLI и воспроизводимость

Команда capture ограничивает выбор20 организациями; review ограничен100 аккаунтами. Используйте новое имя каждого output: CLI резервирует файл эксклюзивно до сетевого обращения/транзакции. Неудачный запуск может оставить пустой зарезервированный файл. Ошибка после commit явно сообщает `committed:true`.

```powershell
pnpm catalogue:current capture --team-ids 7119388,9823272 --out .tools/current-capture-new.json
# Отдельно изучить source; подготовить review по ReviewedCurrentCatalogueSchema.
# prepareCurrentCatalogue(capture, SHA256_файла_capture, reviewedAt).review даёт шаблон.
# Проверить numeric IDs/Steam64/имена, затем сохранить рассмотренный review.
pnpm catalogue:current preview --source .tools/current-capture-new.json --review reviewed-new.json --out reports/current-preview-new.json
pnpm catalogue:current apply --source .tools/current-capture-new.json --review reviewed-new.json --plan reports/current-preview-new.json --sha256 SHA256_PREVIEW --out reports/current-applied-new.json
```

Capture обращается к источнику; preview/apply работают offline с PostgreSQL. Apply проверяет SHA preview, привязку source/review и свежесть DB plan. Здесь выполнены [review](evidence/s1-12-current-reviewed.json), [preview](evidence/s1-12-current-preview.json), [apply](evidence/s1-12-current-applied.json), [replay](evidence/s1-12-current-replay.json) и [проверка поиска](evidence/s1-12-current-search.json). SHA и код связаны [manifest](evidence/s1-12-current.manifest.json).

Полный raw capture сохранён локально в ignored `.tools/s1-12-current-capture.json`, SHA `ce2ef0854c7d8ea0adfd8de4ef932a1b4cc263524dd877de189346aea9a7f683`; исходный диагностический ответ — `.tools/s1-12-registry.json`. Полный реестр с лишними полями профилей не коммитится. Для exact-byte replay CLI нужен сохранённый raw capture; один checkout содержит review/планы/результат и offline audit, но не5732 полных профиля. Свежий capture требует нового review/preview, а не подмены старых файлов. Старые evidence/SQL001–019 не изменены.

## Проверки и следующий шаг

PASS: frozen install, typecheck,426 unit, build,19 PG identity-provision (6 новых),7 PG/API catalogue и58 Node (2 новых). Новые проверки покрывают numeric selection/namesakes, missing/mismatched/duplicate/overflow IDs, tampered bytes/endpoints/clocks, stale team plan, conflicts, rollback, replay, overwrite и CLI secret redaction. Рабочая проверка поиска read-only:11/11 игроков,2/2 команды. UI не менялся; Chromium заново не запускался (предыдущие17 E2E остаются отдельным S1-11 checkpoint).

Рабочая БД: maps1/players21/teams3/proofs21/revision42/owners0/scenarios0/datasets0/active_models0; upcoming cache2/PandaScore quota2; temporary DB0 на момент read-only проверки. Карты/модели/сценарии не затронуты.

**S1-13 выполнен:** загружены10 завершённых pro-карт; реальные описательные отчёты и replay проверены. [Результат и команды](S1_13_CURRENT_HISTORY.md). Следующий шаг — **S1-14**, запуск ограниченного обновления истории из интерфейса с состоянием задания. Старые архивные объявления не блокируют текущий ручной workflow; S1-07/S3-01/model gates открыты. Модель — **GPT-6.1 Sol · High** для API/queue/UI integration.
