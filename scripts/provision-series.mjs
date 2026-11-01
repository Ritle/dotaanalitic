import {readFile,stat,open} from 'node:fs/promises';
import {createDatabase,SeriesProvisionRepository} from '../packages/db/dist/index.js';
import {SeriesProvisionRequestSchema,SeriesPlanFingerprintSchema} from '../packages/contracts/dist/index.js';
const [mode,config,...args]=process.argv.slice(2);
if(!['preview','apply'].includes(mode)||!config||args.length!==(mode==='apply'?2:1)){
  console.error('Использование: provision-series.mjs preview request.json new-plan.json | apply request.json plan-sha256 new-result.json');process.exit(2);
}
let db,output,writeAttempted=false;
try{
  if(!process.env.DATABASE_URL||(await stat(config)).size>65536)throw new Error('configuration');
  const request=SeriesProvisionRequestSchema.parse(JSON.parse(await readFile(config,'utf8')));
  const expected=mode==='apply'?SeriesPlanFingerprintSchema.parse(args[0]):null;
  output=await open(args.at(-1),'wx');db=createDatabase(process.env.DATABASE_URL);
  const repository=new SeriesProvisionRepository(db);
  let report;
  if(mode==='preview')report=await repository.preview(request);
  else{writeAttempted=true;report=await repository.apply(request,expected);}
  await output.writeFile(JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,fingerprint:report.fingerprint,created:report.created??0,
    groups:report.groups?.map(g=>({providerSeriesId:g.providerSeriesId,maps:g.mapIds.length,reasons:g.reasons}))??report.mappings?.length,
    mapWrites:0,trainingReady:false,deployable:false}));
  if(report.status==='blocked')process.exitCode=3;
}catch(error){
  const codes=['series_plan_changed','series_plan_not_ready','series_request_mismatch','series_inventory_limit','series_snapshot_in_future'];
  console.error(JSON.stringify({code:codes.includes(error?.message)?error.message:error?.code==='EEXIST'?'output_exists':'series_provision_failed',
    writeAttempted,message:'Проверьте конфиг, план и миграцию 022. При изменении данных подготовьте новый preview. Повторное применение того же успешного плана не создаёт дубликаты.'}));
  process.exitCode=1;
}finally{await output?.close();await db?.destroy();}
