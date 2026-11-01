import {readFile,stat,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createDatabase,IdentityProvisioner,canonicalContextJson} from '../packages/db/dist/index.js';
import {prepareCurrentAccounts} from '../packages/ingestion/dist/index.js';
import {CurrentAccountSelectionSchema} from '../packages/contracts/dist/index.js';
const [mode,sourceFile,selectionFile,...args]=process.argv.slice(2),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
if(!['preview','apply'].includes(mode)||!sourceFile||!selectionFile||args.length!==(mode==='apply'?3:1)){
 console.error('Использование: provision-current-accounts.mjs preview source.json selection.json new-plan.json | apply source.json selection.json plan.json plan-file-sha256 new-result.json');process.exit(2);
}
let db,output,committed=false;
try{
 const read=async(file,limit)=>{if((await stat(file)).size>limit)throw new Error('input_size');return readFile(file);};
 const source=await read(sourceFile,16*1024*1024),selection=CurrentAccountSelectionSchema.parse(JSON.parse(await read(selectionFile,65536)));
 const prepared=prepareCurrentAccounts(JSON.parse(source),sha(source),selection);
 let plan;
 if(mode==='apply'){
  const bytes=await read(args[0],1024*1024);if(sha(bytes)!==args[1])throw new Error('plan_hash');plan=JSON.parse(bytes);
  if(plan.mode!=='current_accounts_preview'||canonicalContextJson(plan.review)!==canonicalContextJson(prepared.review))throw new Error('plan_binding');
 }
 if(!process.env.DATABASE_URL)throw new Error('database_configuration');
 output=await open(args.at(-1),'wx');db=createDatabase(process.env.DATABASE_URL);const service=new IdentityProvisioner(db);
 let result;
 if(mode==='preview')result={plan:await service.preview(prepared.review),databaseWrites:0};
 else {const applied=await service.apply(prepared.review,plan.plan.fingerprint);committed=true;
  result={...applied,databaseWrites:applied.playersCreated+applied.accountProofsAdded+applied.aliasesAdded};}
 const report={schemaVersion:1,mode:'current_accounts_'+mode,generatedAt:new Date().toISOString(),source:{file:sourceFile,sha256:sha(source)},
  selection,review:prepared.review,...result,warnings:prepared.warnings,networkRequests:0,verifiedMapLineups:0,trainingReady:false,deployable:false};
 const content=JSON.stringify(report,null,2)+'\n';await output.writeFile(content);
 console.log(JSON.stringify({status:result.status??result.plan.status,sha256:sha(content),accounts:prepared.review.accounts.length,
  plannedPlayers:result.plan?.plannedPlayers,playersCreated:result.playersCreated,accountProofsAdded:result.accountProofsAdded,databaseWrites:result.databaseWrites}));
 if(result.plan?.status==='blocked')process.exitCode=3;
}catch(error){console.error(JSON.stringify({code:['identity_plan_stale','identity_provision_conflict'].includes(error?.code)?error.code:
 error?.code==='EEXIST'?'output_exists':'current_accounts_failed',committed,message:committed?
 'Изменения записаны, но отчёт не сохранён. Повторите тот же план с новым именем файла.':
 'Операция не выполнена. Проверьте source SHA, список аккаунтов, план и БД. При изменении данных нужен новый preview.'}));process.exitCode=1;
}finally{await output?.close();await db?.destroy();}
