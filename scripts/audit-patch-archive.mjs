/** A bounded archival content proof, not a deployment/feature/dataset verifier. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ArchiveEvidenceClient,ValvePatchClient,ValvePatchError,verifyArchivedAnnouncement,archivedBodyCoverage} from '../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const eventId=value('--event')??'3735230544064408127',output=value('--out'),path=output?resolve(root,output):null,rel=path?relative(root,path):null;
if(!/^[1-9]\d{0,19}$/.test(eventId)||!rel||isAbsolute(rel)||rel.startsWith('..')||!rel.endsWith('.json')||args.length%2||args.some((v,i)=>i%2===0&&!['--event','--out'].includes(v))){
  console.error('Укажите --event decimalEventId --out docs/evidence/new-capture.json внутри проекта.');process.exit(2);
}
const hash=b=>createHash('sha256').update(b).digest('hex'),archive=new ArchiveEvidenceClient(),valve=new ValvePatchClient({maxRequests:2});
const cohortFile='reports/s0-08-ti2023.json',body=await readFile(resolve(root,cohortFile)),cohort=JSON.parse(body);
if(cohort.mode!=='live_opendota'||cohort.schema_version!==3||!Array.isArray(cohort.observations)||!cohort.observations.length||cohort.observations.some(m=>typeof m.started_at!=='string')){
  console.error('Нужен исходный live S0-08 TI2023 capture.');process.exit(2);
}
const beforeAt=cohort.observations.map(m=>m.started_at).sort()[0],sources=[],errors=[];let indexRecords=[],proof=null,coverage=null;
try{
  const current=await valve.getSteamEvent(eventId);sources.push(current.source);
  const index=await archive.findBefore(eventId,beforeAt);sources.push(index.source);indexRecords=index.records;
  if(indexRecords.length){
    // Fixed earliest indexed candidate; never select a snapshot by prediction quality.
    const selected=indexRecords[0],snapshot=await archive.getSnapshot(eventId,selected.timestamp);sources.push(snapshot.source);
    proof=verifyArchivedAnnouncement({...snapshot,digest:selected.digest},eventId,current.data.event);
    coverage=archivedBodyCoverage(proof,cohort.observations);
  }
}catch(e){errors.push({code:e instanceof ValvePatchError?e.code:'archive_verification_failed',status:e instanceof ValvePatchError?e.status:null});}
const files=['scripts/audit-patch-archive.mjs','packages/ingestion/src/valve/archive-client.ts','packages/ingestion/src/valve/archive-evidence.ts','packages/ingestion/src/valve/steam-event.ts','packages/ingestion/src/valve/patch-client.ts'];
const code=await Promise.all(files.map(async file=>({file,sha256:hash(await readFile(resolve(root,file)))})));
const report={schemaVersion:1,mode:'live_archived_steam_announcement',generatedAt:new Date().toISOString(),captureStatus:errors.length?'partial_or_blocked':'complete',
  eventId,beforeAt,cohort:{file:cohortFile,sha256:hash(body)},requests:{valve:valve.requestStats,archive:archive.requestStats},
  sources,indexRecords,code,proof,coverage,errors,scope:'announcement_body_only',databaseWrites:0,verifiedPatchMaps:0,trainingExamples:0,
  empiricalEvaluation:{status:'unavailable',brier:null,logLoss:null,ece:null},autoRegistryEligible:false,deployable:false};
await mkdir(dirname(path),{recursive:true});
const reportBody=JSON.stringify(report,null,2)+'\n',manifest={schemaVersion:1,file:rel.replaceAll('\\','/'),sha256:hash(reportBody),eventId,beforeAt,
  bodyKnownByAt:proof?.bodyKnownByAt??null,sourceBodyVerifiedMaps:coverage?.sourceBodyVerifiedMaps??0,scope:'announcement_body_only',autoRegistryEligible:false,deployable:false};
try{await writeFile(path,reportBody,{flag:'wx'});await writeFile(path.replace(/\.json$/,'.manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});}
catch{console.error('Не удалось записать новый capture/manifest: проверьте путь и существующие файлы.');process.exit(1);}
console.log(JSON.stringify({file:rel,captureStatus:report.captureStatus,proofStatus:proof?.status??'unavailable',knownBy:proof?.bodyKnownByAt??null,
  sourceBodyVerifiedMaps:coverage?.sourceBodyVerifiedMaps??0,verifiedPatchMaps:0,requests:report.requests,errors}));
if(errors.length)process.exitCode=1;
