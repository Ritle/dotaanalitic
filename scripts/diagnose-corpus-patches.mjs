import {open} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {PatchDiagnosticsConfigSchema} from '../packages/contracts/dist/index.js';
import {diagnoseCorpusPatches,PatchDiagnosticsError} from '../packages/ingestion/dist/index.js';

const [input,output,...rest]=process.argv.slice(2);
if(!input||!output||rest.length){
  console.error('Использование: diagnose-corpus-patches.mjs config.json new-report.json');process.exit(2);
}
let totalBytes=0;
async function boundedRead(path,limit){
  const handle=await open(path,'r');
  try{
    const stat=await handle.stat();if(!stat.isFile()||stat.size>limit||totalBytes+stat.size>64*1024*1024)throw new PatchDiagnosticsError('INPUT_SIZE_LIMIT');
    const bytes=Buffer.alloc(stat.size+1);let offset=0;
    while(offset<bytes.length){const r=await handle.read(bytes,offset,bytes.length-offset,offset);if(!r.bytesRead)break;offset+=r.bytesRead;}
    if(offset!==stat.size)throw new PatchDiagnosticsError('INPUT_CHANGED_DURING_READ');
    totalBytes+=offset;return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,offset));
  }finally{await handle.close();}
}
try{
  const config=PatchDiagnosticsConfigSchema.parse(JSON.parse(await boundedRead(input,65536)));
  const references=[...config.mapCaptures.map(ref=>({kind:'maps',...ref})),
    {kind:'provider_patches',...config.providerPatches},{kind:'valve_list',...config.valveList}];
  const snapshots=[];
  for(const ref of references)snapshots.push({kind:ref.kind,sha256:ref.sha256,
    content:await boundedRead(resolve(dirname(resolve(input)),ref.path),8*1024*1024)});
  const report=diagnoseCorpusPatches(config,snapshots);
  const handle=await open(output,'wx');
  try{await handle.writeFile(JSON.stringify(report,null,2)+'\n');}finally{await handle.close();}
  console.log(JSON.stringify({status:report.status,fingerprint:report.fingerprint,...report.summary,
    databaseWrites:0,trainingReady:false,deployable:false}));
}catch(error){
  const code=error?.code==='EEXIST'?'OUTPUT_EXISTS':error instanceof PatchDiagnosticsError?error.code:'INPUT_OR_OUTPUT_INVALID';
  console.error(JSON.stringify({status:'error',code,message:code==='OUTPUT_EXISTS'?
    'Файл отчёта уже существует. Укажите новое имя.':'Диагностика патчей не выполнена. Проверьте конфиг, SHA снимков и временные границы.'}));
  process.exitCode=1;
}
