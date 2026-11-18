# S3-09 — входы модели до начала всей встречи

16 ноября 2026. Завершён срез `series-development-dataset`: для 35 source-verified серий подготовлен воспроизводимый development-набор с отдельными признаками и исходами. **33 серии готовы по покрытию признаков: 5 BO1 и 28 BO3.** Две серии сохранены в знаменателе со статусом `unavailable`. Вероятности, метрики качества, обучение и активация в этом срезе не выполнялись.

## Реальные входы и покрытие

Использован [проверенный корпус 35 полных серий / 77 карт](S3_09_SERIES_MEMBERSHIP_EVIDENCE.md), не новая выборка по результатам модели. Новая read-only выгрузка существующим `V1DataRepository` содержит 2285 локальных карт; 2211 проходят общую проверку пригодности pro-истории. Время snapshot: **2026-11-16T09:01:56.536Z**. Это время проверки текущих фактов, а не их исторической доступности.

История начинается с **2024-01-01**, как в существующем V1-профиле; граница не подбиралась по будущим метрикам. Для конкретных встреч февраля–марта2025 фактически использовано от117 до193 более ранних завершённых карт. Новые карты2026 года не становятся историей для этих встреч.

| Формат | Подтверждённых серий | Входы готовы | Недостаточно личной истории |
|---|---:|---:|---:|
| BO1 | 5 | 5 | 0 |
| BO3 | 30 | 28 | 2 |
| Всего | 35 | 33 | 2 |

Во всех 35 первых картах есть 10 разных verified canonical identities с numeric accounts. Недостаток данных в сериях `opendota:951544` и `opendota:951935`: перед ними у account111620041 найдено соответственно **0 и 2** пригодные pro-карты при минимуме5. Это покрытие поставленного локального архива, не утверждение, что игрок нигде больше не играл. Минимум не снижен; нулевой опыт не получает выдуманный рейтинг1500 или вероятность50/50.

В 14 встречах Team A находится на Dire первой карты: ориентация определяется меньшим canonical team ID, а не Radiant. Наборы десяти игроков в последующих картах этих 35 серий совпадают с первой; это записано в отдельной диагностике. Такая проверка не даёт права подставлять последующие составы во вход первой карты.

## Защита от утечки исходов

1. Рейтинги вычисляет прежний `createV1FeatureBuilder`: initial1500, K32, scale400, одинаковое обновление игроков и строгая граница завершения. Параметры и действующее ядро не менялись.
2. Новый адаптер **до вызова** builder удаляет все карты целевой серии по IDs и canonical provider key, текущие/будущие карты и карты, завершившиеся ровно в cutoff. Поэтому поздний непригодный участник другой серии не может задним числом исключить её раннюю карту из текущей истории.
3. Cutoff должен совпадать с проверенным стартом первой карты полного списка. Сценарий получает только её фактическую пятёрку, роли и герои для Elo не требуются. Native slots0–4/128–132 и текущие verified account links проходят существующую проверку source receipt.
4. Функция построения признаков не принимает series label. `rows` содержат входы/признаки/покрытие; `labels` — отдельный массив с победителем всей встречи. Проверено отсутствие `teamAWon` в feature rows. Общий dataset fingerprint намеренно связывает и признаки, и отдельные labels; fingerprint конкретного feature result зависит от отобранной истории и входа, не от будущих исходов.
5. Перед соединением проверяются текущие data revisions, source payload SHA, стороны, времена и исходы всех целевых карт против закреплённого corpus. Исправление источника требует новой ревизии аудита, не тихой замены старой метки.
6. Это **conditional reconstruction**: текущие verified identities и поздно полученные исторические исходы не объявляются известными до матча. Фактические fetch/verification clocks сохраняются; историческая event-time доступность обозначена как допущение. История ограничена supplied eligible inventory.

Идентификаторы серии в V1 history имеют формат `opendota:ID`. JSON tuple keys реестра exposure — другой wire format; они не сравниваются как одинаковые строки. Адаптер отдельно сверяет provider/ID и canonical series UUID. Это исправлено при первом реальном соединении; неудачная сборка не создала выходной файл.

Независимая сверка прошла по **5324 включениям карт** в 35 историй: ни одной карты целевой серии, начала или завершения на/после cutoff. Это число повторных включений одних и тех же исторических карт, не 5324 независимых наблюдения.

## Файлы и воспроизведение

- [series-development-export.mjs](../tools/research/series-development-export.mjs): существующий DB exporter, repeatable-read/OutcomeVerifier, SHA manifest, exclusive output; без HTTP и business writes.
- [series-development-core.mjs](../tools/research/series-development-core.mjs): временной фильтр, состав первой карты, соединение source revisions, отдельные rows/labels и полный знаменатель.
- [series-development.mjs](../tools/research/series-development.mjs): offline `build`/`verify`, повторная проверка родительского membership artifact, input/code SHA, безопасные пути и запрет перезаписи.
- [series-development.test.mjs](../tests/node/series-development.test.mjs): ручной Elo-oracle, mutation будущих/целевых исходов, exact cutoff, перенос исторической пригодности, A/B, cold start и bigint IDs.

```powershell
node --env-file-if-exists=.env tools/research/series-development-export.mjs .tools/NEW-development-inventory.json
node tools/research/series-development.mjs build .tools/s309-development-input.json 1dfd14eed4966763dd7167ffde2595b31a7c803e8e37b98e452dd7edae375f9f .tools/NEW-series-development.json
node tools/research/series-development.mjs verify .tools/s309-development-r1.json 3f2e106de2798fa93bcbff47f6dca6597b4d9063f1c6d6cbdc9381b00aebe35c
node --test tests/node/series-development.test.mjs tests/node/series-membership.test.mjs tests/node/series-corpus.test.mjs
```

В `build` используется закреплённый input manifest, а не автоматически последний экспорт. Новая выгрузка требует нового manifest с её SHA. Полные большие исходники остаются в ignored `.tools`; [evidence](evidence/s3-09-series-development.json) хранит hashes, покрытие и результаты проверок. Runtime-файлы и root exports активной модели не менялись. Внешних запросов0, записей бизнес-данных0, scoring0, activation0.

## Следующая задача

**S3-09/series-development-evaluation:** выполнить offline-оценку фиксированного кандидата на этих33 пригодных сериях, сравнить IID-преобразование с исходной map probability и постоянным baseline0.5. Показать Brier/log loss/калибровку отдельно по форматам и coverage33/35, сохранив обе недоступные серии в знаменателе. Это уже просмотренная development-выборка одного турнира, не независимый release test; результат сам по себе не разрешает публикацию. Рекомендуемая модель: **GPT-6 Astra · High**.


Проверки: **33 Node-теста (10 новых), 6 CLI-проверок, 2 отрицательные проверки адаптера, 1067 пакетных тестов в 8 workspaces, frozen offline install/typecheck/build, 71 SQL checksum, doc links и diff check — PASS.** Общий запуск прошёл с первого раза. Runtime/admission точно совпадают с активацией действующей модели; readiness=model_eligible. Отдельные PG/browser suites не запускались: API/UI/схема не менялись; реальная read-only выгрузка БД выполнена.
