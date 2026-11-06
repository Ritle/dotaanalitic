import { collectionManager } from './lib/v1-collection.mjs';
import { detailCollectionManager } from './lib/v1-detail-collection.mjs';
import { importCollectionManager } from './lib/v1-import-collection.mjs';
const [mode,...args]=process.argv.slice(2), manager=collectionManager(), details=detailCollectionManager({manager});
const imports=importCollectionManager({details}), importMode=mode?.startsWith('import-')?mode.slice(7):null;
const detailMode=mode?.startsWith('details-')?mode.slice(8):null;
const valid = importMode ? ['batch','recover'].includes(importMode)?args.length===5&&/^(?:0|[1-9]\d?)$/.test(args[3])&&/^(?:[1-9]|10)$/.test(args[4]):
  importMode==='export'?args.length===4:['status','reconcile'].includes(importMode)&&args.length===3:
  detailMode ? detailMode==='init'?args.length===4:detailMode==='status'?[2,3].includes(args.length):
  detailMode==='capture'?args.length===4&&/^(?:0|[1-9]\d?)$/.test(args[3]):['recover','export'].includes(detailMode)&&args.length===3:
  mode==='init'?args.length===4:mode==='collect'?args.length===3&&/^(?:[1-9]|10)$/.test(args[2]):['status','merge','recover'].includes(mode)&&args.length===2;
if(!valid){console.error('Использование: init bundle CONFIG_SHA FREEZE_SHA new-directory | status|merge|recover directory COLLECTION_SHA | collect directory COLLECTION_SHA runNumber(1..10) | details-init directory COLLECTION_SHA union.json UNION_SHA | details-status directory COLLECTION_SHA [UNION_SHA] | details-capture directory COLLECTION_SHA UNION_SHA batchIndex(0..99) | details-recover|details-export directory COLLECTION_SHA UNION_SHA | import-status|import-reconcile directory COLLECTION_SHA UNION_SHA | import-batch|import-recover directory COLLECTION_SHA UNION_SHA batchIndex(0..99) attempt(1..10) | import-export directory COLLECTION_SHA UNION_SHA reviewId');process.exit(2);}
try {
 const input=[...args];if(mode==='collect'||detailMode==='capture')input[input.length-1]=Number(input.at(-1));
 if(importMode&&['batch','recover'].includes(importMode)){input[3]=Number(input[3]);input[4]=Number(input[4]);}
 console.log(JSON.stringify(await (importMode?imports[importMode](...input):detailMode?details[detailMode](...input):manager[mode](...input))));
}
catch(e){
 const reasons={collection_busy:'Каталог сбора заблокирован. Дождитесь завершения; после аварийного завершения проверьте родительский и дочерний процессы. Блокировка автоматически не удаляется.',
  collection_source_deadline:'Срок получения источников истёк. Новые HTTP-запросы не выполнены.',
  collection_recovery_required:'Предыдущая попытка требует проверки. Файлы и ошибки сохранены; автоматический повтор HTTP не выполнен.',
  collection_failed_run_preserved:'Неудачная попытка сохранена. Нужен разбор её receipts; удалять её из истории сбора нельзя.',
  collection_incomplete:'Нет полного набора проверенных запусков для объединения.',
  collection_inside_bundle:'Каталог сбора должен находиться вне закреплённого оценщика.',
  detail_collection_plan_required:'Сначала подготовьте пакеты командой details-init для проверенного union.',
  detail_collection_stale_union:'Список discovery изменился. Подготовьте новый union и пакеты; прежние данные сохранены.',
  detail_collection_batch_range:'Такого пакета нет в закреплённом списке карт.',
  detail_collection_recovery_required:'Пакет прерван или требует проверки. Используйте details-recover; новый HTTP-повтор не выполнен.',
  detail_collection_incomplete:'Сохранены не все обязательные пакеты. Проверьте details-status.',
  detail_collection_inventory:'Учёт пакетов повреждён или часть файлов потеряна. Исходные файлы сохранены для разбора.',
  import_input:'Проверьте номер пакета и последовательный номер попытки импорта.',
  import_inventory:'Журнал импорта повреждён или изменена предыдущая попытка. Файлы сохранены для разбора.',
  import_artifact_binding:'Результат импорта не соответствует проверенному пакету или повреждён.',
  import_recovery_required:'Импорт прерван; часть карт могла записаться в БД. При полном manifest выполните import-recover. Без manifest после разбора можно явно начать следующую попытку import-batch; прежние файлы сохраняются.',
  import_incomplete:'Нет завершённого учёта импорта для всех пакетов. Проверьте import-status.',
  import_stale_review:'После сверки появился новый импорт. Выполните import-reconcile ещё раз.',
  import_reconciliation_failed:'Не удалось сверить источники с БД. Предыдущие результаты сохранены.',
  import_execution_config:'Закреплённый оценщик отклонил конфигурацию; модель не активирована.'};
 console.error(JSON.stringify({status:'unavailable',code:e.code==='EEXIST'?'OUTPUT_EXISTS':Object.hasOwn(reasons,e.message)?e.message.toUpperCase():'COLLECTION_REJECTED',
  message:e.code==='EEXIST'?'Каталог уже существует; предыдущие данные сохранены.':reasons[e.message]??'Проверьте SHA, закреплённый оценщик, конфигурацию и сохранённые файлы сбора.',teamAWinProbability:null}));process.exitCode=1;
}
