/** Bounded primary-source audit. No DB writer, inferred effective time or model output. */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ValvePatchClient,ValvePatchError,PatchLabelSchema,comparePatchSources,assessAuditedMapPatches} from '../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
const value=name=>{const at=args.indexOf(name);return at<0?null:args[at+1];};
const labels=(value('--patch')??'7.34c,7.34d,7.34e').split(','),output=value('--out');
const path=output?resolve(root,output):null,rel=path?relative(root,path):null;
if(!path||!rel||isAbsolute(rel)||rel.startsWith('..')||!labels.length||labels.length>3||new Set(labels).size!==labels.length||labels.some(x=>!PatchLabelSchema.safeParse(x).success)||
  args.some((v,i)=>i%2===0&&!['--patch','--out'].includes(v))||args.length%2){
  console.error('Укажите --patch 7.34c,7.34d,7.34e (до3 версий) --out reports/new-capture.json внутри проекта.');process.exit(2);
}
const digest=body=>createHash('sha256').update(body).digest('hex'),client=new ValvePatchClient({maxRequests:20});
const comparisons=[],errors=[],captureEvidence=[],sourceEvidence=[];let mapCoverage=null;
try{
  const list=await client.getPatchList();sourceEvidence.push(list.source);
  const captures=[];
  for(const name of ['recent','ti2021','ti2022','ti2023','ti2024']){
    const file=`reports/s0-08-${name}.json`,body=await readFile(resolve(root,file));captures.push(JSON.parse(body.toString('utf8')));
    captureEvidence.push({file,sha256:digest(body)});
  }
  mapCoverage=assessAuditedMapPatches(captures,list);
  for(const label of labels){
    try{
      const row=list.data.patches.find(p=>p.patch_number===label);if(!row)throw new ValvePatchError('patch_not_in_list');
      const notes=await client.getPatchNotes(label);sourceEvidence.push(notes.source);
      const end=Math.min(Math.floor(Date.now()/1000),row.patch_timestamp+7*86400),news=await client.getAnnouncements(end);sourceEvidence.push(news.source);
      comparisons.push(comparePatchSources(label,list,notes,news));
    }catch(error){errors.push({patchLabel:label,code:error instanceof ValvePatchError?error.code:'source_or_contract_error',status:error instanceof ValvePatchError?error.status:null});}
  }
}catch(error){errors.push({patchLabel:null,code:error instanceof ValvePatchError?error.code:'capture_or_contract_error',status:error instanceof ValvePatchError?error.status:null});}
const files=['scripts/audit-patch-sources.mjs','packages/ingestion/src/valve/patch-client.ts','packages/ingestion/src/valve/patch-audit.ts'];
const code=await Promise.all(files.map(async file=>({file,sha256:digest(await readFile(resolve(root,file)))})));
const report={schemaVersion:1,mode:'live_valve_primary_sources',generatedAt:new Date().toISOString(),
  captureStatus:errors.length?'partial_or_blocked':'complete',status:'requires_manual_review',requestedPatches:labels,
  requests:client.requestStats,code,sourceEvidence,captureEvidence,comparisons,mapCoverage,errors,
  empiricalEvaluation:{status:'unavailable',scoredMaps:0,brier:null,logLoss:null,ece:null,reasons:['VERIFIED_EFFECTIVE_RELEASE_AND_AVAILABILITY_UNPROVEN','HISTORICAL_COHORT_NOT_VERIFIED']},
  databaseWrites:0,autoRegistryEligible:false,deployable:false,
  limitations:['TIMESTAMPS_ARE_DISTINCT_SOURCE_CLAIMS','PUBLICATION_IS_NOT_EFFECTIVE_TIME','HERO_ABSENCE_IS_NOT_UNCHANGED','NO_AUTOMATIC_HERO_IMPACT_CLASSIFICATION','EXISTING_MAP_CAPTURES_ARE_NOT_FROZEN_TRAINING_DATA']};
await mkdir(dirname(path),{recursive:true});
try{await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}catch{console.error('Отчёт не записан: путь недоступен или capture уже существует.');process.exit(1);}
console.log(JSON.stringify({file:rel,captureStatus:report.captureStatus,patches:comparisons.map(p=>({patch:p.patchLabel,spreadSeconds:p.timestampSpreadSeconds,heroRows:p.heroNotes.length})),
  uniqueMaps:mapCoverage?.uniqueMaps??null,verifiedPatchMaps:0,scoredMaps:0,requests:client.requestStats,errors}));
if(errors.length)process.exitCode=1;
