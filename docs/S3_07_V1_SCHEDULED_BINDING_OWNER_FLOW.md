# S3-07/V1-scheduled-binding-owner-flow — привязка и сверка в интерфейсе

**Продолжение:** [отмена и повторное открытие](S3_07_V1_SCHEDULED_TARGET_LIFECYCLE.md) добавлены для всей встречи; прежнее сопоставление и сверки сохраняются. Ниже — исходный checkpoint привязки результата.

На странице сохранённого прогноза встречи доступны ручное сопоставление с первой картой OpenDota, сохранение проверенного результата и история сверок. Исходный forecast, вероятность, составы и прежние отчёты остаются неизменными. Используются существующие CLI repositories и SQL032–033; новых миграций или правил допуска модели нет.

## Действия владельца

1. Открыть сохранённую попытку на `/schedule-targets/:targetId?forecast=UUID`. В блоке «Результат сыгранной карты» указать ID карты и ID серии **OpenDota**, HTTPS-источник и объяснение точного соответствия встрече PandaScore. Карта должна быть импортирована и проверена в локальной истории, включая pro outcome, команды, турнир, серию и map1.
2. Проверить, что это именно первая карта этой встречи, включая повторные встречи тех же команд, и отметить подтверждение. Любое изменение полей снимает подтверждение. Сервис не скачивает указанный URL и не выдаёт ручное сопоставление за автоматическое доказательство межпровайдерных ID.
3. Сохранить связь. Она действует для данной редакции назначения и видна у других её прогнозов. Ошибочную связь нельзя перезаписать новым UUID; correction/remapping workflow остаётся будущим отдельным срезом. Если исходная попытка сохранена без Tier1 scope, её привязка недоступна по прежним правилам.
4. Нажать «Проверить и сохранить результат». Победитель, фактическое начало, совпадение составов и prospective eligibility вычисляются по проверенным локальным фактам. Пользователь не вводит исход или время. При неизменном содержимом возвращается прежняя outcome revision; при исправлении источника создаётся новая.
5. Для обновления собственной статистики создать новый отчёт в журнале. Старые прогнозы и отчёты не переписываются. Только действительно выданный до фактического старта прогноз с допустимым исходом влияет на prospective metrics; unavailable, what-if и поздние записи не увеличивают N.

Сохранённая связь содержит источник, объяснение, server review time и SHA. Каждый выбранный прогноз сверяется отдельно: совпадение состава относится к нему, а не к исходному прогнозу, через который была сохранена связь. История сверок показывает по20 записей с exclusive revision cursor; добавление новой редакции не сдвигает старую страницу. Архивная выбранная сверка явно помечается. CheckedAt — время сохранённой сверки, не обещание текущего состояния источника.

Потерянный ответ восстанавливается повтором **того же UUID/body**. Для refresh сохраняется исходный expectedRevision; повтор после provider correction возвращает первоначальную запись. Получение новых фактов требует нового запроса после чтения последней редакции. Конфликт не исправляется незаметной сменой expectedRevision. Для обоих типов записи форма блокируется на время неизвестного результата.

## HTTP и защита

База маршрута: `/api/v1/schedule-targets/:targetId/forecasts/:forecastId`.

| Метод | Суффикс | Смысл |
|---|---|---|
| GET | `/result-binding` | `{binding:null}` либо bounded owner binding projection |
| POST | `/result-binding` | Сохранить явное owner-reviewed сопоставление |
| GET | `/outcomes?beforeRevision=N` | Последние20 либо более ранние immutable сверки |
| POST | `/outcomes` | Проверить текущие факты и сохранить semantic revision |

Binding body: requestId/matchId/providerSeriesId/sourceUrl/rationale/confirmedByOwner:true. Prediction UUID, target SHA и owner выводятся из пути и сессии; winner/model/clock/redirect fields запрещены. Refresh body: только requestId/expectedRevision; map ID выводится из неизменяемой связи.

Все endpoints — owner/session/no-store, POST — Origin/CSRF и6/min. Общая admission guard result mutations ограничивает число ожидающих DB-lock запросов. **До** repository retry lookup проверяются owner, target и конкретный scheduled forecast: nonce из другого пути не позволяет прочитать либо изменить другую запись. Верификация остаётся в прежних SQL/repositories, включая pre-start и roster semantics. No public signup, source URL fetching, model fitting, activation или dataset creation.

HTTP projection не выдаёт owner UUID, raw map-number observation JSON, source payloads, model artifact/code bytes. В ответе остаются проверенный outcome/receipt provenance, revision/SHA, source/review metadata и понятные причины. CLI contracts и история сохранены.

## Следующий шаг

**S3-07/V1-scheduled-target-lifecycle:** versioned отмена/повторное открытие PandaScore назначения, отдельный audit и учёт в журнале с приоритетом ever-verified map binding; owner API/UI. Отсутствие на частичной странице расписания не означает отмену. Весь S3-07/V1 release остаётся открытым; независимый model gate ещё обязателен. Рекомендуемая модель: **GPT-6 Astra · High** — следующий срез затрагивает миграции, temporal lifecycle и правила статистики.

## Проверено 2026-11-03

**QA завершена:** offline frozen install, полный typecheck/build PASS. **711 уникальных unit/CLI,112 isolated PostgreSQL,31 browser E2E** PASS; новых4/8/3 соответственно. В первом targeted browser прогоне2/3 PASS, один beforeEach превысил30s во время подготовки synthetic fixture с ожиданием будущего старта. Убрано ненужное ожидание реальных часов только в test helper: fixture не выдаёт вероятность и не заявляет prospective eligibility. Повтор3/3 и итоговый31/31 PASS без изменения production code или timeout. Desktop и360px результат просмотрены, переполнения страницы нет. Один прежний evaluation-details CLI test превысил60s (reported129932ms; параллельно20s tool wait вернулся через128.4s). Неизменённый1-test файл повторён с прежним60s лимитом, затем выполнены оставшиеся API40/worker1.711 — уникальные тесты после успешного повтора, не сумма повторов.33 migration checksums/docs links/diff проверены. Evidence: `docs/evidence/s3-07-v1-scheduled-binding-owner-flow.json`.

**Сохранность:** новых миграций нет; SQL001–033 и26 protected artifacts unchanged.21 working-table fingerprints, E0 exact replay,232 feature rows, archived executable/current kernel compatibility PASS. Primary/metric kernels и старый report revision1/SHA bd42a60064c42daa4281bcb0e8972eba79d72737a4fccffe480d8a8725767398 сохранены; N0/legacy cancelled null. Рабочие models1/artifacts1/active0/activations0/E1/release0/scenarios0/predictions0/snapshots0/outcomes0/refresh0/reports1/lifecycle0/scheduleTargets0/scheduleResultBindings0. Dota provider calls/imports/training/реальные оценки/активации0 вне изолированных synthetic fixtures; рабочие записи не создавались.
