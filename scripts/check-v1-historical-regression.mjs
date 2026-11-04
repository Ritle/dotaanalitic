import {open,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {checkV1HistoricalRegression} from './lib/v1-historical-regression.mjs';
import {readV1RuntimeCode} from '../packages/db/dist/v1-runtime-code.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const args=process.argv.slice(2),[mode,source,sourceSha,reference,referenceSha,output]=args;
if(args.length!==6||mode!=='verify'||!source||!reference||!output||![sourceSha,referenceSha].every(s=>/^[a-f0-9]{64}$/.test(s??''))){
  console.error(JSON.stringify({status:'unavailable',code:'USAGE',message:'Использование: verify dataset.json SHA256 reference-features.json SHA256 new-report.json'}));
  process.exit(2);
}
async function bounded(path,expected,code){
  const file=await open(path,'r');
  try{
    const stat=await file.stat();if(!stat.isFile()||stat.size>67108864)throw Error('FILE_LIMIT');
    const bytes=Buffer.alloc(67108865);let n=0;
    while(n<bytes.length){const part=await file.read(bytes,n,bytes.length-n,null);if(!part.bytesRead)break;n+=part.bytesRead;}
    if(n>67108864)throw Error('FILE_LIMIT');const body=bytes.subarray(0,n);
    if(sha(body)!==expected)throw Error(code);
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));
  }finally{await file.close();}
}
try{
  const dataset=await bounded(source,sourceSha,'SOURCE_SHA_MISMATCH');
  const golden=await bounded(reference,referenceSha,'REFERENCE_SHA_MISMATCH');
  const result=checkV1HistoricalRegression(dataset,golden,sourceSha,referenceSha),runtime=await readV1RuntimeCode();
  const toolCode=await Promise.all(['scripts/check-v1-historical-regression.mjs','scripts/lib/v1-historical-regression.mjs'].map(async path=>({path,sha256:sha(await readFile(new URL('../'+path,import.meta.url)))})));
  const report={...result,executor:{code:[...toolCode,...runtime.code],runtime:runtime.runtime}};
  const text=JSON.stringify(report,null,2)+'\n',file=await open(output,'wx');
  try{await file.writeFile(text,'utf8');await file.sync();}finally{await file.close();}
  console.log(JSON.stringify({status:result.status,sha256:sha(text),summary:result.summary,runtimeParityRows:result.runtimeParityRows,
    evaluation:'not_performed',deployable:false,teamAWinProbability:null}));
}catch(error){
  const safe=['INVALID_SHA','REFERENCE_INVALID','REFERENCE_SOURCE_MISMATCH','FEATURE_REPLAY_MISMATCH','RUNTIME_PARITY_MISMATCH',
    'PREDICTION_FORBIDDEN','HISTORY_CUTOFF_VIOLATION','FILE_LIMIT','SOURCE_SHA_MISMATCH','REFERENCE_SHA_MISMATCH'];
  console.error(JSON.stringify({status:'unavailable',code:error?.code==='EEXIST'?'OUTPUT_EXISTS':safe.includes(error?.message)?error.message:'REGRESSION_FAILED',
    message:'Историческая сверка не завершена. Проверьте SHA, исходный датасет, контрольный экспорт и новое имя отчёта.'}));process.exitCode=1;
}
