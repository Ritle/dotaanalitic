/** Fixed TI12 archival metadata audit. No DB writes, account merges or readiness promotion. */
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ArchiveEvidenceClient,ValvePatchError,verifyArchivedTi12Metadata,ti12EvidenceCoverage} from '../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
const path=args.length===2&&args[0]==='--out'?resolve(root,args[1]):null,rel=path?relative(root,path):null;
if(!rel||isAbsolute(rel)||rel.startsWith('..')||!rel.endsWith('.json')){
  console.error('Использование: audit-cohort-evidence.mjs --out reports/new-ti12-evidence.json внутри проекта.');process.exit(2);
}
const hash=b=>createHash('sha256').update(b).digest('hex');
try{
  try{await stat(path);console.error('Файл отчёта уже существует. Укажите новое имя.');process.exit(2);}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const cohortFile='docs/evidence/s0-08-live-ti2023.json',bytes=await readFile(resolve(root,cohortFile));
  const cohort=JSON.parse(bytes),starts=cohort.observations?.map(m=>m.started_at);
  if(cohort.mode!=='live_opendota'||cohort.schema_version!==3||!starts?.length||starts.length>50||
    starts.some(v=>typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)))
    throw new Error('cohort_invalid');
  const beforeAt=[...starts].sort()[0],archive=new ArchiveEvidenceClient(),sources=[],errors=[];
  let indexRecords=[],proof=null,coverage=null;
  try{
    const index=await archive.findTi12Before(beforeAt);sources.push(index.source);indexRecords=index.records;
    if(indexRecords.length){
      // Earliest returned October capture; never select by outcomes or predictive performance.
      const selected=indexRecords[0],snapshot=await archive.getTi12Snapshot(selected.timestamp);sources.push(snapshot.source);
      proof=verifyArchivedTi12Metadata({...snapshot,digest:selected.digest,fetchedAt:snapshot.source.fetchedAt});
      coverage=ti12EvidenceCoverage(proof,cohort);
    }
  }catch(error){errors.push({code:error instanceof ValvePatchError?error.code:'archive_verification_failed',
    status:error instanceof ValvePatchError?error.status:null});}
  const files=['scripts/audit-cohort-evidence.mjs','packages/ingestion/src/valve/tournament-evidence.ts',
    'packages/ingestion/src/valve/archive-client.ts','packages/ingestion/src/valve/archive-evidence.ts',
    'packages/ingestion/dist/valve/tournament-evidence.js','packages/ingestion/dist/valve/archive-client.js'];
  const code=await Promise.all(files.map(async file=>({file,sha256:hash(await readFile(resolve(root,file)))})));
  const report={schemaVersion:1,mode:'live_archived_ti12_metadata',generatedAt:new Date().toISOString(),
    captureStatus:errors.length?'partial_or_blocked':proof?'complete':'no_indexed_snapshot',beforeAt,
    selectionPolicy:'earliest_returned_capture_from_2023_10_01_before_first_cohort_start_limit_5',
    cohort:{file:cohortFile,sha256:hash(bytes)},requests:archive.requestStats,sources,indexRecords,code,proof,coverage,errors,
    scope:'event_league_registration_metadata_only',strictDatasetStatus:'unavailable',
    databaseWrites:0,trainingExamples:0,autoRegistryEligible:false,trainingReady:false,deployable:false};
  await mkdir(dirname(path),{recursive:true});const content=JSON.stringify(report,null,2)+'\n';
  await writeFile(path,content,{flag:'wx'});
  console.log(JSON.stringify({file:rel.replaceAll('\\','/'),sha256:hash(content),captureStatus:report.captureStatus,
    knownByAt:proof?.knownByAt??null,mapsWithMatchingLeagueReference:coverage?.mapsWithMatchingLeagueReference??null,
    strictDatasetStatus:'unavailable',trainingExamples:0,requests:report.requests,errors}));
  if(errors.length||!proof)process.exitCode=3;
}catch{
  console.error('Аудит cohort evidence не выполнен. Проверьте исходный capture, сборку и новый путь отчёта.');process.exitCode=1;
}
