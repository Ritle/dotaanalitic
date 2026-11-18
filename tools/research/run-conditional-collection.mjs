import {readFile,stat} from 'node:fs/promises';
import {createDatabase} from '../../packages/db/dist/index.js';
import {CollectionRuntimeRequest,LocalConditionalCollectionRuntime} from './conditional-collection-runtime.mjs';

let db;
const controller=new AbortController(),cancel=()=>controller.abort();
process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
try{
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=='--request')throw Error('invalid_arguments');
 if((await stat(args[1])).size>16384)throw Error('request_too_large');
 const request=CollectionRuntimeRequest.parse(JSON.parse(await readFile(args[1],'utf8')));
 // This release is a local test runner. It cannot initialize experiments in the owner's working DB.
 const url=new URL(process.env.DATABASE_URL??'');
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)
  ||!/^\/codex_ingest_[a-f0-9]{12}$/.test(url.pathname))throw Error('temporary_local_database_required');
 db=createDatabase(url.toString());
 const report=await new LocalConditionalCollectionRuntime(db).run(request,{signal:controller.signal});
 console.log(JSON.stringify(report));process.exitCode=report.status==='blocked'?2:0;
}catch{
 console.error(JSON.stringify({status:'error',code:'conditional_collection_runtime_failed',
  message:'Сбор не запущен или остановлен: проверьте локальный запрос, временную БД и закреплённую регистрацию.'}));process.exitCode=1;
}finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);await db?.destroy();}
