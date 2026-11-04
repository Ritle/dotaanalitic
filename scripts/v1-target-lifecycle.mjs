import {createDatabase,V1TargetLifecycleRepository,sql} from '../packages/db/dist/index.js';
import {V1LifecycleRequestSchema} from '../packages/contracts/dist/index.js';
import {bounded} from './lib/evaluation-discovery-files.mjs';
const [mode,...args]=process.argv.slice(2);
if(mode==='append'?args.length!==2:mode!=='history'||args.length<1||args.length>2){
  console.error('Использование: append request.json SHA | history PREDICTION_REQUEST_ID [BEFORE_REVISION]');process.exit(2);
}
let db;
try{
  const request=mode==='append'?V1LifecycleRequestSchema.parse((await bounded(args[0],16384,args[1])).data):null;
  if(!process.env.DATABASE_URL)throw Error('lifecycle_database_required');db=createDatabase(process.env.DATABASE_URL);
  const owners=(await sql`SELECT id FROM app_users WHERE is_active LIMIT 2`.execute(db)).rows;
  if(owners.length!==1)throw Error('lifecycle_owner_required');
  const repo=new V1TargetLifecycleRepository(db);
  const result=request?await repo.append(owners[0].id,request):await repo.history(owners[0].id,args[0],args[1]===undefined?undefined:Number(args[1]));
  console.log(JSON.stringify(result));
}catch(e){console.error(JSON.stringify({status:'unavailable',code:['lifecycle_request_conflict','lifecycle_invalid_transition','lifecycle_future_event',
  'lifecycle_integrity','lifecycle_invalid_cursor','NOT_FOUND','CONFLICT'].includes(e?.message)?e.message:'V1_LIFECYCLE_REJECTED',
  message:'Отметка не сохранена или история недоступна. Проверьте назначение карты, SHA и актуальную редакцию. Исходы и прогнозы не изменены.'}));process.exitCode=1;}
finally{await db?.destroy();}
