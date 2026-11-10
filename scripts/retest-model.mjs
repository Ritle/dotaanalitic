import { readFile, stat } from 'node:fs/promises';
import { createDatabase, RetestActivationRegistry, PredictionModelRegistry } from '../packages/db/dist/index.js';
const [mode,...args]=process.argv.slice(2);
if (!(mode==='transition'&&args.length===1 || ['readiness','events'].includes(mode)&&!args.length)) {
  console.error('Использование: retest-model.mjs transition REQUEST.json | readiness | events');process.exit(2);
}
let db;
try {
  let input;
  if(mode==='transition') {
    if((await stat(args[0])).size>65536)throw Error('request_limit');
    input=JSON.parse(await readFile(args[0],'utf8'));
  }
  if(!process.env.DATABASE_URL)throw Error('database_required');
  db=createDatabase(process.env.DATABASE_URL);
  const result=mode==='readiness'?await new PredictionModelRegistry(db).readiness():mode==='events'
    ?await new RetestActivationRegistry(db).events():await new RetestActivationRegistry(db).transition(input);
  console.log(JSON.stringify(result));
} catch(e) {
  console.error(JSON.stringify({status:'unavailable',code:/^retest_registry_[a-z_]+$/.test(e?.message??'')?e.message.toUpperCase():'RETEST_TRANSITION_REJECTED',
    message:'Операция остановлена. Проверьте версию, доказательства, текущее состояние реестра и runtime.',teamAWinProbability:null}));
  process.exitCode=1;
} finally {await db?.destroy();}
