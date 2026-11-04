import { createDatabase, V1RuntimeRepository, V1ForecastOutcomeRepository, V1ScheduleResultRepository, sql } from '../packages/db/dist/index.js';
import { V1ForecastRequestSchema, V1OutcomeRefreshSchema, V1ScheduleResultRequestSchema } from '../packages/contracts/dist/index.js';
import { bounded } from './lib/evaluation-discovery-files.mjs';
const [mode,...args]=process.argv.slice(2);
if (['create','refresh','bind'].includes(mode) ? args.length!==2 : !['get','history','binding'].includes(mode)||args.length!==1) {
  console.error('Использование: create|refresh|bind request.json SHA | get|history|binding REQUEST_ID'); process.exit(2);
}
let db;
try {
  const input=['create','refresh','bind'].includes(mode)?(await bounded(args[0],65536,args[1])).data:null;
  const request=mode==='create'?V1ForecastRequestSchema.parse(input):mode==='refresh'?V1OutcomeRefreshSchema.parse(input):mode==='bind'?V1ScheduleResultRequestSchema.parse(input):null;
  if (!process.env.DATABASE_URL) throw Error('forecast_database_required');
  db=createDatabase(process.env.DATABASE_URL);
  const owners=(await sql`SELECT id FROM app_users WHERE is_active LIMIT 2`.execute(db)).rows;
  if (owners.length!==1) throw Error('forecast_owner_required');
  const owner=owners[0].id, runtime=new V1RuntimeRepository(db), outcomes=new V1ForecastOutcomeRepository(db);
  if (mode==='bind') console.log(JSON.stringify(await new V1ScheduleResultRepository(db).bind(owner,request)));
  else if(mode==='binding') console.log(JSON.stringify(await new V1ScheduleResultRepository(db).get(owner,args[0])));
  else if (mode==='history') console.log(JSON.stringify(await outcomes.history(owner,args[0])));
  else if (mode==='refresh') console.log(JSON.stringify(await outcomes.refresh(owner,request)));
  else {
    const saved=mode==='create'?await runtime.create(owner,request):await runtime.get(owner,args[0]);
    if (!saved || saved.snapshot.request.purpose!=='real_map') throw Error('forecast_not_found');
    const s=saved.snapshot;
    console.log(JSON.stringify({id:saved.id,sha256:saved.sha256,requestId:s.request.requestId,status:s.status,
      purpose:s.request.purpose,target:s.request.realTarget,createdAt:s.createdAt,issuedAt:s.issuedAt,
      teamAWinProbability:s.teamAWinProbability,reasons:s.reasons}));
  }
} catch (error) {
  const safe=['forecast_request_conflict','forecast_real_purpose_required','forecast_not_found','forecast_bound_map_conflict',
    'schedule_result_request_conflict','schedule_result_target_required','schedule_result_target_mismatch','schedule_result_map_unverified',
    'schedule_result_already_bound','schedule_result_map_conflict',
    'forecast_schedule_binding_required','scheduled_target_reference_mismatch','scheduled_target_revision_changed',
    'scheduled_target_not_upcoming','scheduled_target_source_changed','scheduled_target_scenario_mismatch','CONFLICT','NOT_FOUND'];
  console.error(JSON.stringify({status:'unavailable',code:safe.includes(error?.message)?error.message:'V1_FORECAST_REJECTED',
    message:'Операция отклонена. Проверьте назначение карты, SHA запроса, редакцию сверки и локальную сборку.'})); process.exitCode=1;
} finally {await db?.destroy();}
