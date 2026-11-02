# S3-06 — V1 runtime и неизменяемый снимок

Срез2026-11-02 добавляет backend/локальную owner CLI `predict:v1 create|get|export`. Запрос выбирает существующий ручной сценарий и точную ревизию. Сохраняются также недоступные попытки с причинами и `null` probability. В рабочей базе нет активной модели; этот срез не разрешает обойти независимую проверку качества.

## Граница текущего среза

Поддерживается только `purpose: what_if_single_map`: условная будущая карта на выбранных владельцем пятёрках. Такой снимок нельзя позднее превратить в prospective forecast. HTTP/UI, назначение конкретной реальной карте, verified-result linking и собственная статистика сервиса ещё не реализованы. Следующий срез — **S3-06/V1-owner-API-UI**, затем S3-07/V1-journal. Общий S3-05/06 остаётся unchecked.

## Проверки перед числовым результатом

- Сценарий принадлежит владельцу; revision совпадает. Состав берётся из immutable scenario snapshot, а не текущего состава организации. Роли/патчи/герои не становятся входами или дополнительными veto для Elo.
- У карты есть будущее scheduledAt. Контекст между картами серии исключён; результат относится к одной условной карте, не BO3/BO5. Проверка старта повторяется после вычисления и при записи SQL.
- `targetScope` — явное решение владельца о Tier1 main event: OpenDota leagueId, название, период `[fromAt, until)`, HTTPS-источник и обоснование. Время решения ставит сервер. Проверяется соответствие **внешнего** leagueId записи canonical league сценария и даты карты. Provider professional/premium не превращается в Tier1. Отсутствующий scope даёт `TIER1_SCOPE_NOT_REVIEWED`.
- Активная V1 модель должна иметь последний committed passing v2 release report и audit активации. Registry и release-plan locks удерживаются до commit результата; ожидающий расчёт читает модель после ожидания lock при READ COMMITTED.
- Неизменённые compiled модули contracts/analytics/prediction/db, package manifests, lockfile и Node binary/runtime сравниваются с зарегистрированным full freeze. Barrel index допускает только добавленные re-export строки новых модулей; прежние export/import/исполняемые bytes совпадают. Новый orchestration имеет отдельные записанные SHA. Изменение старого модуля закрывает выдачу до явного нового compatibility/release решения, даже если изменение кажется несущественным. Архивный executor не переписывается и не исполняется из URI модели.
- История читается отдельным consistent SELECT-only snapshot через существующий OutcomeVerifier и per-map V1 adapter. Cutoff — минимум выбранного scenario cutoff и серверного времени начала расчёта. Source snapshot также ограничен этим cutoff: будущие receipts/изменения canonical state не подставляются в прошлый срез. Ограничение5000 карт не обрезает выборку: отказ сохраняется как `HISTORY_INVENTORY_LIMIT`.
- Игроки связываются только с одной однозначной verified numeric account identity. Конфликт, несколько допустимых accounts, дубликаты или отсутствующая история дают отказ. History всех verified pro tiers сохраняется; для каждого игрока нужно минимум5 завершённых карт, `completed_at < cutoff`. Conditional retrospective допущение помечено; исторический `known_at` не выдумывается.
- Арифметика — прежний общий feature builder и exact candidate scorer. Внешняя вероятность появляется только после всех проверок и commit. Источник с `syntheticOnly:true` production runtime отклоняет.

## Хранение и повтор

Миграция026 добавляет `v1_runtime_snapshots`, `prediction_runs.v1_request_id/issued_at` и сохраняет вероятность в NUMERIC без округления до4 знаков. Старые SQL001–025 не меняются.

Снимок хранит запрос/scope, полный scenario snapshot, source inventory с provenance, признаки/N/coverage, actual code hashes, model/candidate/freeze/report SHA, activation event, причины и предупреждения. `createdAt/issuedAt` берутся из PostgreSQL с6 знаками дробной секунды. `issuedAt` есть только у успешно сохранённого числового результата; это timestamp терминальной записи в успешно завершённой транзакции. Неудачный commit ничего не публикует.

Уникальность `(owner, requestId)` и transaction lock дают exact retry даже после правки сценария или деактивации модели. Изменение запроса при старом requestId отклоняется; пересчёт требует нового ID. JSON bytes проверяются SHA на чтении. SQL проверяет связь с scenario revision/model/activation/latest report; UPDATE/DELETE/TRUNCATE снимков запрещены, удаление связанного prediction или cascade сценария также не проходит. Результат карты не записывается в исходный prediction.

## Локальная команда

После `pnpm db:migrate` и создания сценария сохранить локально JSON:

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "scenarioId": "22222222-2222-4222-8222-222222222222",
  "expectedRevision": 1,
  "purpose": "what_if_single_map",
  "targetScope": null
}
```

UUID выше — placeholders; заменить на новый requestId и ID существующего сценария. `targetScope:null` допустим для сохранения отказа, не для числового прогноза. Полная схема — `packages/contracts/src/v1-runtime.ts`; Tier1 review нельзя заполнять выдуманным событием. CLI использует единственного локально provisioned owner, не принимает пароль или account token в аргументах.

```powershell
$requestSha = (Get-FileHash -LiteralPath '.tools/prediction-request.json' -Algorithm SHA256).Hash.ToLowerInvariant()
pnpm predict:v1 create .tools/prediction-request.json $requestSha
pnpm predict:v1 get 11111111-1111-4111-8111-111111111111
pnpm predict:v1 export 11111111-1111-4111-8111-111111111111 .tools/prediction-snapshot.json
```

Export создаёт новый файл с точными snapshot bytes, не перезаписывает существующий. CLI выводит краткий итог; полный source inventory доступен в локальном export. Новых публичных endpoints в этом срезе нет.

## Проверки и ограничения

Unit tests: mapping Tier1/время/контекст, A/B swap, конфликты/multiple identities, future evidence, strict completion cutoff, late lineup, synthetic refusal, несовместимые kernel/barrel/runtime, запрет смены назначения и безопасные CLI ошибки. PostgreSQL tests: immutable retry после правки сценария, owner isolation/CAS, конкурирующие запросы, ограничение истории, точность вероятности, отказ scope/code gate, rollback неудачного insert, блокировка деактивации до commit, старт карты во время вычисления.

Положительные DB-сценарии используют **явные synthetic contract doubles** journal/scorer/compatibility в disposable database. Они проверяют транзакции и хранение, не показывают качество модели и не активируют рабочую модель. Итоговые исполненные проверки и состояние — [PROJECT_STATE](PROJECT_STATE.md), [PROGRESS](PROGRESS.md).
