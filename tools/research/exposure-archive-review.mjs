import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,stat,realpath} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha,buildExposureLedger} from './exposure-ledger-core.mjs';
import {reviewArchive,compactReview,summarizeArchiveReviews} from './exposure-archive-core.mjs';
import {archiveSourceProjections} from './exposure-archive-sources.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const baselinePath='.tools/s304-exposure-ledger-r2.json';
const baselineSha='7727f5671c3ff78dd44ff068fe44fc99fc012198178b7392268c6c535354fca7';
const surveyPath='.tools/s304-exposure-native-survey-r1.json';
const surveySha='c1ef779f4e5c0f7e4c27db291b03609677dac04d9f2c86975b6b27ecec6a8052';
const codePaths=['tools/research/exposure-archive-core.mjs','tools/research/exposure-archive-review.mjs','tools/research/exposure-archive-sources.mjs','tools/research/exposure-ledger-core.mjs'];
const MAX=128*1024**2;
const denied=/(^|[\\/])(?:private-owner|node_modules|corepack|pgsql|pgdata|uv-cache|pdf-read-deps|\.git|\.venv)(?:[\\/]|$)/i;
const sensitive=/(credential|password|secret|cookie|session|access|auth|login)/i;
function safe(path,output=false){
 assert(typeof path==='string','path_required');const full=resolve(root,path),rel=relative(root,full).replaceAll('\\','/');
 assert(rel&&!rel.startsWith('../')&&!isAbsolute(rel)&&rel.endsWith('.json'),'local_json_required');
 assert(output?rel.startsWith('.tools/'):(rel.startsWith('.tools/')||rel.startsWith('docs/evidence/')),'path_scope');
 assert(!denied.test(rel)&&!sensitive.test(rel.split('/').at(-1)),'sensitive_or_dependency_path');return full;
}
async function contained(path){
 const real=await realpath(path),rel=relative(root,real).replaceAll('\\','/');
 assert(rel&&!rel.startsWith('../')&&!isAbsolute(rel)&&!denied.test(rel),'real_path_scope');
 assert(!sensitive.test(rel.split('/').at(-1)),'sensitive_real_path');
}
async function bytes(path,expected){
 const full=safe(path);await contained(full);assert((await stat(full)).size<=MAX,'file_limit');
 const b=await readFile(full);assert(b.length<=MAX,'file_limit');
 if(expected!==undefined){assert(/^[a-f0-9]{64}$/.test(expected),'invalid_sha');assert.equal(sha(b),expected,'source_changed');}return b;
}
const parse=b=>JSON.parse(b.toString('utf8').replace(/^\uFEFF/,''));
async function write(path,value){
 const full=safe(path,true);await contained(dirname(full));const b=JSON.stringify(value,null,2)+'\n';
 assert(Buffer.byteLength(b)<=MAX,'report_limit');await writeFile(full,b,{flag:'wx'});return sha(b);
}
async function code(){return Object.fromEntries(await Promise.all(codePaths.map(async p=>[p,sha(await readFile(resolve(root,p)))])));}
const qa=/(^|[-_/])(runtime|tamper|rehearsal|browser|backup|test|tests|e2e|oracle|synthetic|demo|isolated)([-_/]|$)/i;
export async function prepareArchivePlan(output){
 await contained(dirname(safe(output,true)));
 const prior=parse(await bytes(surveyPath,surveySha));await bytes(baselinePath,baselineSha);
 const selected=new Map(),excluded=[];
 for(const e of prior.entries.filter(e=>e.status==='not_supported_source_wrapper')){
  if(sensitive.test(e.path.split('/').at(-1))){excluded.push({path:e.path,reason:'sensitive_filename'});continue;}
  selected.set(e.path,{origin:'prior_non_wrapper',previousSha256:e.sha256});
 }
 async function walk(path){
  const full=resolve(root,path);
  for(const e of await readdir(full,{withFileTypes:true})){
   const p=path+'/'+e.name;
   if(e.isSymbolicLink()||denied.test(p)||qa.test(e.name)||sensitive.test(e.name)||/exposure/i.test(e.name)){
    excluded.push({path:p,reason:'private_dependency_qa_or_self_output'});continue;
   }
   if(e.isDirectory())await walk(p);
   else if(e.isFile()&&e.name.endsWith('.json'))selected.set(p,{origin:path.startsWith('docs/')?'document_evidence':'outside_prior_families'});
   assert(selected.size<=20000,'file_count_limit');
  }
 }
 for(const e of await readdir(resolve(root,'.tools'),{withFileTypes:true})){
  if(/^(s30|s3-|v1|evaluation|research|elo)/.test(e.name))continue;
  const p='.tools/'+e.name;
  if(e.isSymbolicLink()||denied.test(p)||qa.test(e.name)||sensitive.test(e.name)||/exposure|^bin$/.test(e.name)){
   excluded.push({path:p,reason:'private_dependency_qa_or_self_output'});continue;
  }
  if(e.isDirectory())await walk(p);else if(e.isFile()&&e.name.endsWith('.json'))selected.set(p,{origin:'outside_prior_families'});
 }
 await walk('docs/evidence');
 const sources=[];let total=0;
 for(const [path,origin] of [...selected].sort(([a],[b])=>a.localeCompare(b))){
  const b=await bytes(path);total+=b.length;assert(total<=4*1024**3,'total_bytes_limit');
  sources.push({path,sha256:sha(b),size:b.length,...origin,changedSincePriorSurvey:origin.previousSha256?origin.previousSha256!==sha(b):null});
 }
 const plan={format:'exposure-archive-plan-v1',createdAt:new Date().toISOString(),
 baseline:{path:baselinePath,sha256:baselineSha},priorSurvey:{path:surveyPath,sha256:surveySha},
 scope:'previous non-wrapper JSON; other local tool families; docs/evidence JSON; declared exclusions recorded',
 sources,excluded:excluded.sort((a,b)=>a.path.localeCompare(b.path)),totalBytes:total,
 code:await code(),completeGlobalInventory:false,registrationAllowed:false};
 return {sha256:await write(output,plan),files:sources.length,totalBytes:total,excluded:excluded.length};
}
async function assemble(plan){
 assert.equal(plan.format,'exposure-archive-plan-v1');assert(Array.isArray(plan.sources)&&plan.sources.length<=20000,'source_limit');
 assert.equal(new Set(plan.sources.map(s=>s.path)).size,plan.sources.length,'duplicate_path');
 const baselineFile=parse(await bytes(plan.baseline.path,plan.baseline.sha256)),baseline=baselineFile.result;
 await bytes(plan.priorSurvey.path,plan.priorSurvey.sha256);
 assert.deepEqual(plan.code,await code(),'code_changed');
 const entries=[],archiveSources=[],sourceIssues=[],bindings=new Map();let total=0;
 const planned=new Map(plan.sources.map(s=>[s.path,s]));
 for(const s of plan.sources.filter(s=>s.path.endsWith('/manifest.json'))){
  const raw=await bytes(s.path,s.sha256);let m;
  try{m=parse(raw);}catch(e){if(e instanceof SyntaxError)continue;throw e;}
  if(m.format!=='evaluation-discovery-run-v1')continue;
  for(const r of m.receipts??[]){
   assert(/^receipt-\d+\.json$/.test(r.path),'legacy_receipt_path');
   const p=s.path.slice(0,s.path.lastIndexOf('/')+1)+r.path;
   if(planned.get(p)?.sha256===r.sha256)bindings.set(p,{path:s.path,sha256:s.sha256});
  }
 }
 for(const s of plan.sources){
  const b=await bytes(s.path,s.sha256);total+=b.length;assert(total<=4*1024**3,'total_bytes_limit');
  let review;
  try{
   const value=parse(b);review=compactReview(reviewArchive(value,baseline));
   const additions=archiveSourceProjections(value,{legacyDiscoveryBound:bindings.has(s.path)});
   for(const item of additions.sources)archiveSources.push({path:s.path+'#'+item.pointer,filePath:s.path,sha256:s.sha256,
    adapter:item.basis,pointer:item.pointer,manifestBinding:bindings.get(s.path)??null,rows:item.rows,standaloneSeriesKeys:[]});
   sourceIssues.push(...additions.issues.map(i=>({path:s.path,...i})));
  }
  catch(e){
   if(!(e instanceof SyntaxError)&&!['archive_node_limit','archive_depth_limit','embedded_byte_limit','source_walk_limit'].some(k=>e.message.includes(k)))throw e;
   review={status:'requires_review',references:[],opaque:[{path:'',reason:e instanceof SyntaxError?'invalid_json':'resource_limit'}],
    novelMapIds:[],novelNativeSeriesKeys:[],completeGlobalInventory:false,admissionAllowed:false};
  }
  entries.push({path:s.path,sha256:s.sha256,origin:s.origin,changedSincePriorSurvey:s.changedSincePriorSurvey,review});
 }
 const inherited=baselineFile.input?.sources??[{path:plan.baseline.path+'#baseline',sha256:plan.baseline.sha256,adapter:'baseline_inventory',
  rows:baseline.mapIds.map(matchId=>({matchId,seriesKey:null,localSeriesId:null})),standaloneSeriesKeys:baseline.canonicalSeriesKeys}];
 const extendedLedger=buildExposureLedger({format:'exposure-ledger-input-v1',capturedAt:plan.createdAt,
  sources:[...inherited,...archiveSources],pendingReview:['Unresolved archive references, unknown local aliases and excluded formats remain; global completeness is not certified']});
 const allMaps=new Set(extendedLedger.mapIds),allSeries=new Set(extendedLedger.canonicalSeriesKeys);
 for(const e of entries){
  const r=e.review;let resolved=0;
  for(const ref of r.references){
   if((ref.kind==='map'&&allMaps.has(ref.value))||(ref.kind==='series_key'&&allSeries.has(ref.value))||
      (ref.kind==='series'&&ref.provider==='opendota'&&allSeries.has(JSON.stringify(['opendota',ref.value])))){
    ref.status='covered_by_archive_source';resolved++;
   }
  }
  const remaining=r.references.filter(ref=>ref.status.startsWith('novel_'));
  r.novelMapIds=[...new Set(remaining.filter(ref=>ref.kind==='map').map(ref=>ref.value))].sort();
  r.novelNativeSeriesKeys=[...new Set(remaining.filter(ref=>ref.kind==='series_key').map(ref=>ref.value))].sort();
  if(r.summary){r.summary.novelReferences=remaining.length;r.summary.coveredReferences+=resolved;}
  r.resolvedByNewSources=resolved;
  if(!remaining.length&&!r.opaque.length&&r.status==='requires_review')r.status='references_covered_or_foreign';
 }
 return {format:'exposure-archive-review-v1',createdAt:plan.createdAt,baseline:plan.baseline,
  entries,summary:summarizeArchiveReviews(entries),excluded:plan.excluded,
  archiveSources,sourceIssues,extendedLedger,
  completeGlobalInventory:false,registrationAllowed:false,collectionAllowed:false,deployable:false};
}
export async function captureArchiveReview(planPath,output){
 await contained(dirname(safe(output,true)));
 const b=await bytes(planPath),plan=parse(b),result=await assemble(plan);
 const report={format:'exposure-archive-file-v1',sourcePlan:{path:planPath,sha256:sha(b)},environment:{node:process.version,code:await code()},result};
 return {sha256:await write(output,report),summary:{files:result.summary.files,statusCounts:result.summary.statusCounts,
 novelMapIds:result.summary.novelMapIds.length,novelSeries:result.summary.novelNativeSeriesKeys.length,ledger:result.extendedLedger.summary}};
}
export async function verifyArchiveReview(path,expected){
 assert(typeof expected==='string'&&/^[a-f0-9]{64}$/.test(expected),'external_sha_required');
 const report=parse(await bytes(path,expected));assert.equal(report.format,'exposure-archive-file-v1');
 assert.deepEqual(report.environment,{node:process.version,code:await code()},'environment_changed');
 const plan=parse(await bytes(report.sourcePlan.path,report.sourcePlan.sha256));
 assert.deepEqual(report.result,await assemble(plan),'replay_mismatch');return {verified:true,sha256:expected,files:report.result.summary.files};
}
async function main(){
 const [mode,a,b,...extra]=process.argv.slice(2);assert(!extra.length,'arguments');
 let r;if(mode==='plan'){assert(b===undefined);r=await prepareArchivePlan(a);}
 else if(mode==='capture')r=await captureArchiveReview(a,b);
 else{assert.equal(mode,'verify');r=await verifyArchiveReview(a,b);}
 console.log(JSON.stringify(r));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
 console.error('Проверка архивов отклонена: проверьте пути, SHA, лимиты и новый файл результата.');process.exitCode=1;
});
