# ПК2 · Передача исследований ПК1 на 24 ноября 2026

**Последний проверенный коммит ПК1 — `612d4dcc646978fdb891e416ed91e0c8d3503698`.** От общей базы `94f3f85` до него 71 коммит. В приватном реестре сохранён Git bundle со всей этой историей, кодом, тестами и документами. Ниже приведены результаты по состоянию на этот коммит. Указанные пути относятся к его дереву.

## Что готово и что это даёт ПК2

| Направление | Сделано и проверено | Что остаётся открытым |
| --- | --- | --- |
| Общий реестр | Оба ПК могут читать снимки просмотренных ID и файлы по SHA-256. Есть каталог ранее локальных материалов, перенос крупных файлов частями, восстановление пакетов и публикация отчёта после успешного расчёта. В сводке миграции 1 609 исследовательских файлов. Выгрузки истории Elo двух ПК описаны раздельно. | Перед выбором независимых серий читать актуальные ревизии исключений обоих ПК. Перечень ресурсов и команды находятся в `docs/SHARED_RESEARCH_REGISTRY.md`. |
| Победитель серии до драфта, S3-09 | Сверены сетки, источники, составы и покрытие Elo. В историческом срезе PGL условные входы готовы на 113 из 138 BO3. Подготовлены повторяемый просмотр зимнего календаря, общий снимок Elo и проверка прежнего просмотра целых серий. | Готовность входов и независимость проверяются раздельно. В срезе DreamLeague 27 все 46 спорных серий исключены до уточнения прежнего просмотра, за пределами издания остаётся максимум 13 предварительных кандидатов исходного среза. Для допуска серии должны быть подтверждённо завершены **до 23 ноября 2026, 15:42 МСК**. Будущие матчи идут в отдельное наблюдение. Регистрация, проверка качества и активация модели серии остаются отдельными шагами. См. `docs/S3_09_SERIES_INDEPENDENT_SCOPE.md`. |
| Draft Lab и базовая модель H2 | Из Live открывается редактор одной карты. Он принимает десять разных героев и сохраняет ручной сценарий. Восстановлен оригинальный артефакт H2, сверены 262 контрольных примера. В копии БД воспроизведён внутренний расчёт PlayTime — Xipto со статусом `computed_shadow_only`. При историческом сравнении H2 правильно выбрала победителя на 124 из 186 карт. | Интервал выигрыша H2 над H1 по log loss включает ноль. Для независимой проверки H2 подготовлен протокол DreamLeague 30 Swiss. На передаваемом срезе регистрация открыта, требуются ID основного издания и этапа и сверка исключений. Предложенный крайний срок регистрации — 30 ноября, 21:00 МСК. См. `docs/S3_04_PLAYER_HERO_EXPERIMENT_EVALUATION.md` и `docs/S3_04_DL30_SWISS.md`. |
| Характеристики героев и драфта H3 | Реализованы четыре исторических признака — противостояния, союзные пары, темп по длительности и способность к убийствам. Каталог 127 героев даёт ещё восемь разностей между пятёрками — среднюю скорость и дальность, а также шесть тегов возможностей. Проверены архивы клиента, позиции, опыт на герое, экономика мида и боковых линий, время первой потери внешней башни. | На исходной строгой выборке **0 карт** с полным комплектом входов H3 и подтверждённой временной доступностью. Для рабочего прогноза после пиков нужно сначала сравнить модели на общих картах, затем независимо проверить зафиксированный вариант. Полный перечень экспериментов, SHA и команды приведены в `docs/S3_04_DRAFT_HERO_CONTEXT.md`. |

### Какие признаки выдержали сравнение

На 184 ранее изученных картах из 85 серий H2 дала 123 верных ответа. С опытом на герое в ожидаемой роли получилось 126, с экономикой мида — 124, с экономикой боковых линий — 122, с темпом по башням — 121. На общем поднаборе Wallachia 9 скорость и дальность дали 76/111 против 73/111 у H2, при этом ошибка калибровки составила 0,13216 при пороге 0,10. Во всех этих проверках 95%-й интервал разницы log loss включал ноль. Доказанного улучшения для выпуска модели пока нет. Подробные результаты — `docs/evidence/s3-04-h3-block-comparison.json` и `docs/evidence/s3-04-h3-first-tower-evaluation.json`.

### Что установлено по турнирам

История союзных пар обеих сторон и противостояний на совпадающей серверной сборке подтверждена для восьми целых серий и 16 целевых карт. Это четыре окна **разработки**.

| Окно | Турнир | Целевые серии / карты | Сборка |
| --- | --- | ---: | ---: |
| Обучение | ESL One Birmingham | 5 / 10 | 6725 |
| Валидация | DreamLeague 29, BetBoom Team — Xtreme Gaming | 1 / 2 | 6790 |
| Калибровка | Esports World Cup, Nigma Galaxy — Aurora Gaming | 1 / 2 | 6852 |
| Поздняя проверка разработки | Wallachia 9 | 1 / 2 | 6934 |

Для серии EWC `1118356` целевые карты — `8886788497` и `8886893266`, более ранние карты истории — `8885871759` и `8886728756`. На каждой целевой карте сохранилось по одной ранее встречавшейся союзной паре каждой стороны и четыре противостояния. У всех четырёх реплеев сборка 6852. Регламент EWC требует актуальную версию Valve, а архив клиента указывает на **7.41d**. Датированного прямого подтверждения активного номера до игр нет. В отчёте `inferredPatch=7.41d`, `canonicalPatch=null`, `patchKnownAt=null`. Из 148 файлов игровых параметров у 21 различаются записи в индексе между сборками 6799 и 6852. Среди файлов выбранных героев различие только у Alchemist на второй карте. Изменение численного входа модели ещё предстоит проверить.

## Как получить результат на ПК2

Из корня рабочей копии проекта в PowerShell. Нужны настроенный туннель к общему реестру, локальный `.env` ПК2 и установленные зависимости команды реестра. Даже версия CLI на общей базе `94f3f85` умеет скачивать файлы командой `get`. Для команд ниже выберите свободные пути для пакета и отдельной рабочей папки. При ненулевом коде команды остановитесь на этом шаге.

```powershell
git fetch origin refs/heads/draft-lab/dl30-first-request
git cat-file -e '94f3f853d068030a6c367eb00f857a4e2815f856^{commit}'
$sha = '2ceb574822378f74af1e1ea78347556c0926f6448dbf279098f472d09c4c14ff'
$bundle = '.tools/pc1-research-94f3f85-612d4dc.bundle'
$review = '../pc1-research-612d4dc'
node --env-file=.env tools/research/shared-research-artifact.mjs get $sha $bundle
git bundle verify $bundle
git fetch --no-tags $bundle refs/heads/draft-lab/dl30-first-request
git worktree add --detach $review 612d4dcc646978fdb891e416ed91e0c8d3503698
git -C $review rev-list --count 94f3f85..HEAD
```

Ожидаемый результат последней команды — `71`. В отдельной папке доступны `docs/IMPLEMENTATION_PLAN.md` с чек-листом работ, `docs/PROGRESS.md` с историей и `docs/evidence/` с отчётами. Полный перечень коммитов выводит `git -C $review log --reverse --oneline 94f3f85..HEAD`. Эта процедура сохраняет текущую ветку и локальные правки ПК2.

### Контрольный повтор EWC

Продолжайте в том же PowerShell из исходной рабочей копии ПК2. Команда реестра возьмёт настройки из её `.env`. Для офлайн-проверки в отдельной папке нужен Python 3.14 или новее.

```powershell
New-Item -ItemType Directory -Force -Path "$review/.tools" | Out-Null
node --env-file=.env tools/research/shared-research-artifact.mjs get 6f979579af94fc1af6bcc7b84dd97de04d42c70c37db9d58ced8c6b50a9bdb26 "$review/.tools/h3-ewc-patch-sources.json"
node --env-file=.env tools/research/shared-research-artifact.mjs get afb07045ac57e8f9178d08b9be0dcfa8add182592c03b975cdbfed50d659360d "$review/.tools/s3-04-h3-pair-history.json"
Push-Location $review
try { python -B tools/research/review_h3_ewc_patch.py verify } finally { Pop-Location }
```

Ожидаемая строка — `7.41d 210 4 21`: номер последнего патча в архиве описаний, число его ключей, число карт и число изменившихся записей файлов. SHA-256 эталона `docs/evidence/s3-04-h3-ewc-patch.json` — `b8a69a64fee81ac1b17983123286751fde0ebcffdb154d4f6425aa021ccd0943`. Команда сверяет весь отчёт. На ПК1 в отдельной копии, начатой с общей базы, пакет и оба входа скачаны из реестра, результат воспроизведён. В исходной разработке также прошли сборка, проверка типов, 1 067 тестов пакетов и 112 исследовательских тестов. Два теста БД прошли при отдельном запуске после тайм-аута загрузки.

## Дополнение после среза 612d4dc · характеристики четырёх драфтов

24 ноября проверены обе сборки на 27 разных героях. Все восемь характеристик пятёрок совпали на всех четырёх картах. У Alchemist дальность 150 и скорость 290 в обеих версиях. Его индивидуальный файл содержит способности. Изменения там не затронули входы профиля. Канонический патч остаётся неизвестен. Для чтения результатов достаточно скачать JSON отчёта из реестра.

Для полного повтора используйте тот же `$review`, в котором уже выполнена проверка EWC выше. Три команды скачивания выполняются из рабочей копии с настроенным `.env`. В отдельной папке нужны установленные по lockfile зависимости и собранный пакет `@dota/analytics` (команда ниже использует путь пакета).

```powershell
node --env-file=.env tools/research/shared-research-artifact.mjs get a108b4f4246aac2de35d0cfeccf532b61221bda576f7593be0b920c7a8bd0f24 "$review/docs/evidence/s3-04-h3-ewc-client-values.json"
node --env-file=.env tools/research/shared-research-artifact.mjs get 63c63db6a64c6b76191c3a40774d4b12ee69b634473fd41bfa32294e45f04db9 "$review/.tools/h3-ewc-client-values-sources.json"
node --env-file=.env tools/research/shared-research-artifact.mjs get 1f656c4efa6a79d02cab0e4a496b389e4838a226ced15fd956162f677eae81ae "$review/tools/research/review-h3-ewc-values.mjs"
Push-Location $review
try {
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE) { throw 'Dependency installation failed' }
  pnpm --dir packages/analytics build
  if ($LASTEXITCODE) { throw 'Analytics build failed' }
  node --experimental-strip-types tools/research/review-h3-ewc-values.mjs verify
} finally { Pop-Location }
```

Ожидаемый итог — 27 героев, 19 изменений полей способностей Alchemist и пустой список изменившихся характеристик на каждой из четырёх карт. Следующий шаг ПК1 по Draft Lab — проверить убийства игроков на двух предыдущих картах EWC и измерить покрытие драфтов данными, доступными до старта.

## Дополнение · убийства героев EWC

Исходные ответы двух карт дали 20 проверенных счётчиков. В серии Nigma — Aurora прошлые карты покрывают 7/10 героев на первой карте и 5/10 на второй. Для июля квитанций с датой получения до начала игры нет. В приватном реестре доступны отчёт, исходные ответы и скрипт. Команды выполняются из рабочей копии ПК2 с настроенным реестром, `$review` — отдельная папка среза `612d4dc` и ранее скачанной историей.

```powershell
node --env-file=.env tools/research/shared-research-artifact.mjs get c63f8aeb01f1277860efcb93dfd55c0d5736a2402b3221fcb76bd3c7f9cba8ac "$review/docs/evidence/s3-04-h3-ewc-kills.json"
node --env-file=.env tools/research/shared-research-artifact.mjs get 2c120e4bf0d28070aa1e6b97e2df6ddc90ac7bd2ba87fab359f5f7fd28d2e471 "$review/.tools/h3-ewc-kill-receipts-r1.json"
node --env-file=.env tools/research/shared-research-artifact.mjs get f0e9d171e5d48aba6f9eef8d33d9bc21168fb182e20d16688f97ed8d625648ae "$review/tools/research/review_h3_ewc_kills.py"
Push-Location $review
try { python -B tools/research/review_h3_ewc_kills.py verify } finally { Pop-Location }
```

Ожидаемое покрытие по сторонам — 4/5 и 3/5 на карте `8886788497`, 2/5 и 3/5 на карте `8886893266`. Следующий шаг — проверить сохранённые ответы остальных карт истории и измерить покрытие четырёх окон разработки.

## Ревизия истории убийств по всему архиву

ПК1 обработал все 2 243 карты замороженной истории. Найдены 21 289 счётчиков, в том числе 1 531 ноль. На 108 картах отсутствует исходник с нужным SHA-256, ещё у 61 слота не подтверждена личность. Ретроспективно обе стороны покрыты во всех 1 657 целевых драфтах, все десять героев — в 1 598. При требовании подтверждённой доступности до старта покрыты 0 драфтов. История пригодна для ретроспективного эксперимента разработки.

Для ПК2 достаточно готового отчёта. Для пересчёта в папке `$review` должны быть прежняя история пар и скрипт предыдущего дополнения об EWC. Скачайте четыре новых файла из рабочей копии с настроенным реестром. Режим `verify` сверяет новую историю побайтно и проверяет покрытие всех окон.

```powershell
node --env-file=.env tools/research/shared-research-artifact.mjs get d545b4c98f00ad1f2a2262abbf2924c73ec85ed115b03e6a39e586dbe4be6d3c "$review/docs/evidence/s3-04-h3-kill-history-coverage.json"
node --env-file=.env tools/research/shared-research-artifact.mjs get fc48d72410d41f47a2a2c7675584d9883e11306cd6e49ef05fd7eba90189a1c5 "$review/.tools/h3-kill-receipt-projections-r2.json"
node --env-file=.env tools/research/shared-research-artifact.mjs get 3f7e05b7f05eae22f605971de1dfe978e7c87f414d4d71426c0e55bcffbd5e1d "$review/.tools/s3-04-h3-kill-history-r2.json"
node --env-file=.env tools/research/shared-research-artifact.mjs get 9fe5132e2eabb9ca20e90f68ee77c684be30ac5c9d881a5418c2488a2a22e40f "$review/tools/research/review_h3_kill_history.py"
Push-Location $review
try { python -B tools/research/review_h3_kill_history.py verify } finally { Pop-Location }
```

Для обучения, валидации, калибровки и позднего окна ожидаемое покрытие всех десяти героев — 830, 305, 280 и 183 драфта. Следующий шаг ПК1 — закрепить правила парной проверки H2 с добавлением разности убийств за 10 минут. Активация по этому отчёту не проводилась.

## Протокол сравнения H2 с интенсивностью убийств

В приватном реестре опубликованы входы для 1 657 драфтов и правила первого сравнения. В позднюю оценку войдут 184 карты из 85 целых серий. Для каждой карты определена разность средних показателей героев двух пятёрок. Для 181 из этих 184 карт есть история всех десяти героев. Результат обучения появится на следующем шаге ПК1.

Для просмотра достаточно первого JSON. Для пересчёта в копии `$review` на базе `612d4dc` нужны ревизия истории убийств и отчёт о покрытии из предыдущего раздела. ПК1 проверил восстановление из общего реестра на отдельной копии той же ревизии.

```powershell
node --env-file=.env tools/research/shared-research-artifact.mjs get 282048c0e80d473b9ec62564a9cd2be0f4aadb3a231c04b64c1e60471635af3b "$review/docs/evidence/s3-04-h3-kill-rate-plan.json"
node --env-file=.env tools/research/shared-research-artifact.mjs get 6278e1605d12bbe224e8da4cef73e9c45050d8201745a1d9ea175007a9abe850 "$review/tools/research/freeze_h3_kill_rate.py"
Push-Location $review
try { python -B tools/research/freeze_h3_kill_rate.py verify } finally { Pop-Location }
```

## Результат эксперимента с убийствами героев

H2 верно выбрала победителя на 123 из 184 поздних карт, модель с интенсивностью убийств — на 122. При оценке по 85 целым сериям 95% интервал разницы log loss составил от −0,001683 до +0,006598. Brier вырос на 0,001091. Кандидат получил решение `no_positive_development_signal`. Следующий шаг ПК1 — найти прямую привязку игровых патчей к картам для проверки совместного набора признаков H3.

Для просмотра отчёта из рабочей копии с настроенным общим реестром:

```powershell
node --env-file=.env tools/research/shared-research-artifact.mjs get 1cc1023c4d5851f978d1bc443312a6840aa716d289477b71d4f6a9f1fb1ff841 .tools/h3-kill-rate-result-pc1.json
```

Для повтора в отдельной папке скачайте пакет с входами, скриптами, четырьмя снимками и исходным эталоном H2. Архив содержит только файлы исследования. Команды рассчитаны на доступную локально ревизию `612d4dc` из первого раздела и свободные пути. Строгий режим `verify` проверяет в том числе версию Windows, Python, библиотеки BLAS и их архитектуру из поля `environment` в снимке обучения. На ПК1 полный повтор из скачанного архива прошёл на чистой копии базовой ревизии ПК2.

```powershell
$zip = '.tools/h3-kill-rate-replay-pc1.zip'
$copy = '.tools/pc1-kill-rate-evaluation-review'
$pythonExe = (Resolve-Path .venv/Scripts/python.exe).Path
node --env-file=.env tools/research/shared-research-artifact.mjs get 49cd0c49b1087c775dfd3802ea298490e756198b86a107872a5d5ddeb0e85d6f $zip
if ($LASTEXITCODE) { throw 'Download failed' }
git worktree add --detach $copy 612d4dcc646978fdb891e416ed91e0c8d3503698
if ($LASTEXITCODE) { throw 'New review copy required' }
Expand-Archive -LiteralPath $zip -DestinationPath $copy -Force -ErrorAction Stop
Push-Location $copy
try { & $pythonExe -B tools/research/evaluate_h3_kill_rate.py verify } finally { Pop-Location }
```

## Версии STRATZ для четырёх турниров

STRATZ по отдельным ID выдал 7.40c для Birmingham, 7.41c для DreamLeague, 7.41d для EWC и 7.41f для Wallachia. В выборке 14 карт. Более ранняя история на той же версии источника покрывает обе стороны восьми целевых драфтов из четырёх полных серий. Эти метки получены после игр, их происхождение внутри STRATZ неизвестно. Строгий H3 по-прежнему имеет 0 пригодных серий. ПК1 продолжит проверку на границе патчей в Birmingham.

Для просмотра достаточно первого файла. Для пересчёта в копии `$review` нужны история убийств r2 и план сравнения интенсивности убийств из предыдущих разделов. Ниже команды восстановления из приватного реестра. ПК1 проверил их повтором на копии базовой ревизии ПК2.

```powershell
node --env-file=.env tools/research/shared-research-artifact.mjs get 0ef6ab346b34a796a5c2291466b5a8b70703690a86bf694f4ad152f275ee6321 "$review/docs/evidence/s3-04-h3-stratz-pilot-patches.json"
node --env-file=.env tools/research/shared-research-artifact.mjs get af031bdf42a3a8ed1f41d82b57e1ebbc975e07cd2604162aac0c818b352a445b "$review/.tools/h3-stratz-pilot-patch-receipts-r1.json"
node --env-file=.env tools/research/shared-research-artifact.mjs get 3f6b955183f155e02a4750633ca26acd149e1d26264fe45581e13b63f11434a1 "$review/tools/research/review_h3_stratz_patches.py"
Push-Location $review
try { python -B tools/research/review_h3_stratz_patches.py verify } finally { Pop-Location }
```
