# S1-17 — период и фильтры сравнения пятёрок

В `/upcoming` у сравнения подтверждённых пятёрок доступны начало/срез UTC с точностью до миллисекунд и optional ID патча/лиги. Используется прежний `POST /teams/compare`; backend, contracts, SQL и зависимости не меняются.

Пустой cutoff означает время серверного запроса, пустой from — 90 дней до effective cutoff. Пустые patch/league — все. UI не назначает будущую дату встречи историческим срезом. Даты переводятся в UTC ISO с precision3, идентификаторы валидируются существующим BIGINT-safe контрактом и остаются строками. From должен быть строго раньше cutoff; cutoff в будущем недопустим. Некорректные native date controls/даты/ID дают русское сообщение без HTTP-запроса; backend остаётся конечной границей валидации.

## Состояние и выборки

Фильтры находятся в отдельной форме вне формы сохранения сценария. Enter запускает только сравнение. Изменение фильтра синхронно скрывает applied result/ошибку и отменяет прежний observer fetch. Игроки, роли, stand-in flags и owner confirmation сохраняются. Нового запроса до явного submit нет. «Сбросить фильтры пятёрок» очищает только четыре фильтра, не запускает сравнение автоматически.

Query key содержит полный applied input. HistoryRefresh инвалидирует прежний prefix compare и перечитывает только активный запрос с теми же явными фильтрами. При пустом cutoff новый запрос получает новый server cutoff; при явном cutoff он остаётся прежним. Отложенный ответ старого периода не показывается.

Ответ отображает effective from/cutoff/snapshot и patch/league из server-normalized input. Этот период/фильтры общие для organization, exact-five, cross-org pairs и личной истории. Статистика организации S1-15 отдельно подписана как последние20 локальных карт; её cohort не меняется фильтрами сравнения. Сила соперников из другого Elo cohort здесь не показывается.

При patch filter карты без проверенного патча не попадают в выборку. Никакого provider-label fallback, сопоставления PandaScore ID или nickname identity merge. N0 остаётся нулевой наблюдаемой выборкой с nullable raw WR; missing verified identity сохраняет N=null. WINDOW_TOO_LARGE предлагает изменить начало и повторить запрос здесь же. UI не расширяет период, не снимает фильтр и не подставляет вероятность автоматически.

## QA и файлы

- `UpcomingLineupCompare.vue`: фильтры/валидация/reset/effective labels и самостоятельная submit form; `UpcomingScenario.vue`: сравнение вынесено из сценарной формы и выключено при сохранении сценария.
- `upcoming-filters.spec.ts`: два новых Chromium cases с реальным auth/API/reader/queue и явно синтетическим источником в disposable DB. Fixed2024 pro-карты и verified patch позволяют проверить N2→league-filter N1→patch-filter N0; bigint league ID больше Number.MAX_SAFE_INTEGER передаётся без потери точности. Enter/reset, сохранение игроков/confirmation, invalid/equal/future dates и invalid IDs без запроса, delayed result, overflow и recovery, history refresh с неизменными явными фильтрами. Созданных сценариев0.
- Desktop/360px screenshots и assertion отсутствия горизонтального overflow; итоговые команды/результаты — в [PROGRESS](PROGRESS.md) и [PROJECT_STATE](PROJECT_STATE.md). Synthetic fixtures не считаются live coverage; рабочие данные не меняются, provider audit/training/model activation не запускаются. SQL001–020 immutable.

Следующий срез — **S1-18: проверка полного пути предстоящего матча**: один browser workflow от расписания/ручного canonical выбора и фильтров до сохранения сценария, Draft Lab и immutable descriptive report; проверить сохранение авторитетного состава, явные разные cohorts и неизменность сохранённого отчёта после обновления истории. Использовать существующие функции, не добавлять прогнозы/identity automation. Модель — **GPT-6.1 Sol · Medium** для интеграционной QA готового UI/API.
