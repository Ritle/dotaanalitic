import {readFile,stat} from 'node:fs/promises';
import {createDatabase} from '../../packages/db/dist/index.js';
import {temporaryCollectionV2Database} from './conditional-collection-v2-runtime.mjs';
import {CollectionV2RefreshRequest,LocalConditionalCollectionV2RefreshRuntime} from './conditional-collection-v2-refresh.mjs';
import {parseBindingEvidenceJson} from './conditional-tournament-binding-v2.mjs';
let db;const controller=new AbortController(),cancel=()=>controller.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
try{
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--request')throw Error('invalid_arguments');
 if((await stat(args[1])).size>16384)throw Error('request_too_large');
 const request=CollectionV2RefreshRequest.parse(parseBindingEvidenceJson(await readFile(args[1],'utf8')));
 db=createDatabase(temporaryCollectionV2Database(process.env.DATABASE_URL??'').toString());
 const report=await new LocalConditionalCollectionV2RefreshRuntime(db).run(request,{signal:controller.signal});
 console.log(JSON.stringify(report));process.exitCode=report.status==='blocked'?2:0;
}catch{
 console.error(JSON.stringify({status:'error',code:'conditional_collection_v2_refresh_failed',
  message:'Обход не запущен или остановлен: проверьте запрос, временную БД, регистрацию и идентификатор прохода.'}));process.exitCode=1;
}finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);await db?.destroy();}
