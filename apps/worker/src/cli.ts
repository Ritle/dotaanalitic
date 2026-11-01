import { parseArgs } from 'node:util';
import { createProviderRuntime, IngestionService, registerHistoryWorker } from '@dota/ingestion';
import { createQueue, enqueue, registerWorker, IMPORT_QUEUE } from './queue.js';

async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{'match-id':{type:'string'},'job-id':{type:'string'}}});
  const command=positionals[0];
  if(!['work','enqueue','once','status'].includes(command??''))throw new Error('invalid_command');
  const runtime=createProviderRuntime(process.env,39);
  const boss=await createQueue(process.env.DATABASE_URL!);
  try{
    if(command==='status'){
      if(!values['job-id']||! /^[a-f0-9-]{36}$/.test(values['job-id']))throw new Error('invalid_job_id');
      const job=await boss.getJobById(IMPORT_QUEUE,values['job-id']);
      console.log(JSON.stringify(job?{jobId:job.id,state:job.state,output:job.output}:{status:'not_found'}));
      return;
    }
    let jobId:string|null=null;
    if(command==='enqueue'||command==='once'){
      jobId=await enqueue(boss,{matchId:values['match-id']??''});
      console.log(JSON.stringify({status:jobId?'queued':'deduplicated',jobId}));
      if(command==='enqueue'||!jobId)return;
    }
    await registerWorker(boss,runtime.db,(id,signal)=>new IngestionService(runtime.db,runtime.clientForJob(signal)).ingest(id));
    if(command==='work')await registerHistoryWorker(boss,runtime.db,signal=>runtime.clientForJob(signal));
    if(command==='once'){
      const deadline=Date.now()+180000;
      while(Date.now()<deadline){
        const job=await boss.getJobById(IMPORT_QUEUE,jobId!);
        if(job && ['completed','failed','cancelled'].includes(job.state)){
          console.log(JSON.stringify({jobId,state:job.state,output:job.output}));
          if(job.state!=='completed')process.exitCode=1;
          return;
        }
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      throw new Error('job_wait_timeout');
    }
    await new Promise<void>(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  }finally{await boss.stop({graceful:true,timeout:30000});await runtime.close();}
}
main().catch(()=>{console.error(JSON.stringify({code:'worker_command_failed',message:'Не удалось выполнить команду импорта. Проверьте конфигурацию, миграции и состояние задания.'}));process.exitCode=1;});
