import {open} from 'node:fs/promises';
import {Steam32Schema} from '../packages/contracts/dist/index.js';
import {createProviderRuntime} from '../packages/ingestion/dist/index.js';
const [id,file,...rest]=process.argv.slice(2);
if(!Steam32Schema.safeParse(id).success||!file||rest.length){console.error('Использование: capture-player-profile.mjs account-id new-capture.json');process.exit(2);}
let output,runtime;
try{
 output=await open(file,'wx');runtime=createProviderRuntime(process.env,3);
 const result=await runtime.client.getPlayer(id);
 await output.writeFile(JSON.stringify({schemaVersion:1,mode:'current_profile_capture',accountId:id,
  observation:{rawBody:result.rawBody,source:result.source},requests:runtime.client.requestStats},null,2)+'\n');
 console.log(JSON.stringify({status:result.data.profile?.account_id===id?'observed':'unavailable',accountId:id,
  payloadSha256:result.source.payloadSha256,requests:runtime.client.requestStats,identityWrites:0}));
}catch(error){console.error(JSON.stringify({code:error?.code==='EEXIST'?'output_exists':'profile_capture_failed',
 message:'Профиль не сохранён. Проверьте источник, лимит запросов и путь нового файла.'}));process.exitCode=1;
}finally{await output?.close();await runtime?.close();}
