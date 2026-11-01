# Предложение S3-01 E0 — исследовательский Elo без patch features

**Статус: владелец явно выбрал выполнить E0 2026-11-01; реализация начата. Публикация модели не разрешена.** Основание — завершённая ограниченная [проверка client mapping](S1_07_CLIENT_MAPPING_STOP.md): связь технической версии с balance patch не подтверждена доступными источниками. Дальнейшее повторение тех же source audits прекращается. S1-07 остаётся открытой; данное решение не объявляет её выполненной.

## Какой результат предлагается получить

Один offline эксперимент, который проверит, можно ли на доступных реальных pro-картах воспроизводимо оценить простой player-mean Elo по хронологии, без patch/time/hero весов. На выходе — локальный research artifact с cohort/assumptions, выбранными map IDs, source hashes, временным разделением целых серий, числом оцениваемых карт и исследовательскими Brier/log loss при достаточном входе. Это проверка метода и pipeline, а не обещание полезного прогноза будущей встречи.

Основа — уже реализованная математика [S1-05](S1_05_CHRONOLOGICAL_ELO.md), без новой зависимости, нейросети, калибровки или автоматического подбора коэффициентов. Рейтинги принадлежат игрокам, организация не передаёт рейтинг новому составу. Начальный prior и параметры сохраняются явно как unvalidated configuration. Не менять production replayElo/readiness/identity/source gates ради запуска исследования.

## Явные допущения и разница с текущим strict cohort

| Факт | Допущение только в E0 | Что нельзя заявлять |
|---|---|---|
| Фактические десять участников из завершённой карты | Состав реконструирован; эксперимент условен относительно знания этой пятёрки | Что пятёрка была объявлена до драфта |
| Canonical identities, проверенные к моменту экспорта | Допустима текущая подтверждённая числовая связь аккаунта; историческая доступность отдельно unknown | Что identity proof был получен до старта исторической карты |
| Pro classification и исходы прошлых карт, полученные поздним импортом | Event-time reconstruction; до целевой карты разрешены только более ранние и завершённые карты | Что исторический источник публиковал исход именно тогда |
| Версия баланса | Не используется как feature/filter/weight, остаётся unknown | Что patch gate выполнен, дрейф отсутствует или веса полезны |

Это отдельный cohort `research_event_time_reconstructed`, **не** `strict_verified_asof`, **не** production training dataset и **не** существующий conditional_lineup_reconstructed, в котором исключения ограничены allowed assumedFacts. Source knownAt/fetchedAt/recordedAt сохраняются реальными и не заменяются startedAt/end. Нельзя подать E0 artifact в DatasetBuilder/registry как strict данные.

## Ограниченный scope реализации после выбора владельцем

1. Прочитать текущий реальный pro-корпус read-only. Последний сохранённый inventory:36 карт/28 серий; эти числа проверить при исполнении, не считать результатом нового запроса. Один canonical matchId = одна карта; обе стороны содержат пять разных verified numeric accounts, десять distinct identities, native slots и verified outcome. Не заполнять пропуски и не объединять по никам.
2. Создать отдельный frozen research export с исходными clocks, assumptions и SHA; никакой записи в production dataset/model tables. Сохранить все исключённые карты и причины. Файлы не перезаписывать, повторный запуск должен воспроизводить fingerprint.
3. До расчёта метрик закрепить player-mean Elo configuration и whole-series chronological split. Не разделять карты одной известной серии между evaluation partitions; неизвестные/пересекающиеся по времени группы исключить с причиной. Не подбирать конфигурацию по финальным результатам. Для baseline не изображать обучение/calibration, которых нет.
4. Обновлять рейтинг только результатами более ранних карт после их event-time завершения; перекрывающаяся или одновременная карта не видит чужого будущего исхода. Текущая карта даёт label только для оценки; её outcome/duration/GPM/kills не входят в признаки. Duration прежних карт используется только для reconstruction completion clock, не для текущего исхода.
5. Сохранить aggregate research metrics, N, exclusions, cold-start coverage и comparable constant-prior baseline на той же выборке. Внутренние expected values допустимы для offline математической проверки; не отдавать их как пользовательские вероятности отдельных встреч. Если нет валидного holdout/оценённых карт, метрики=NULL и точная причина; не обходить exclusions ради числа.
6. Проверить повторяемость, swaps, zero samples, duplicate maps, temporal overlap, whole-series split и отсутствие target leakage на synthetic tests; реальный export/метрики держать отдельно от synthetic fixtures. Финальные штатные проверки и docs/progress обязательны.

## Что остаётся за пределами

- Нет прогнозов GamerLegion—CyberHero или другой будущей встречи, endpoints/UI вероятностей, `is_active=true`, activation, автоматического retraining или deployment.
- Нет изменения `matches.patch_id`, source knownAt, accepted context proofs и старых prediction snapshots.
- Нет приравнивания event-time reconstruction к prospective performance. 36 карт сами по себе не подтверждают достаточность, а сильный score на такой выборке не закрывает quality gate.
- Нет обещания величины ухудшения от отсутствия patch features. Чтобы ответить на этот вопрос, позже потребуется сопоставимый независимый эксперимент с реальными patch facts и достаточно широкими данными.

## Почему требуется выбор владельца

[AGENTS.md §5.1](../../AGENTS.md) требует «select the current unchecked task only»; текущая S1-07 не закрыта. §10 разрешает другой порядок: «If user explicitly chooses another ticket, follow their choice». Предложенный E0 переводит работу в S3-01 и явно меняет исследовательские допущения относительно имеющегося strict cohort, поэтому не выводится автоматически из исправления source mapping.

Рекомендуемый выбор — **выполнить E0 в указанном scope**, сохранив S1-07 и все production prediction gates открытыми. Альтернатива — остаться в strict режиме; source branch не возобновляется без конкретного нового первичного evidence. Выбор E0 не разрешает упрощённую production модель.

Следующая модель при выборе E0: **GPT-6 Astra · Extra High** (если доступно): temporal reconstruction и whole-series evaluation требуют проверки утечек. После фиксации архитектуры узкую реализацию можно передать Sol · High. Модель выбирается владельцем вручную.
