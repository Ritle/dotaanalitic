import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {id,sha} from './exposure-ledger-core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export function rankedArchiveIds(x){
 assert(x?.observation?.provider==='opendota'&&x.observation.filters?.lobbyTypeId===7,'ranked_filter');
 assert(Array.isArray(x.rawBodies)&&Array.isArray(x.observation.receipts)&&x.rawBodies.length===x.observation.receipts.length,'ranked_receipts');
 const ids=new Set();
 for(const [i,b] of x.rawBodies.entries()){
  assert(typeof b==='string'&&sha(b)===x.observation.receipts[i].payloadSha256,'ranked_sha');
  const rows=JSON.parse(b);assert(Array.isArray(rows)&&rows.length<=10000,'ranked_rows');
  for(const row of rows){assert.equal(row.lobby_type,7,'raw_lobby_type');
   assert(typeof row.match_id==='string'||Number.isSafeInteger(row.match_id),'unsafe_ranked_id');ids.add(id(String(row.match_id)));}
 }
 return [...ids].sort();
}
export function syntheticArchive(x){
 const valid=v=>v?.capture?.syntheticOnly===true&&v?.history?.syntheticOnly===true;
 return Array.isArray(x)?x.length>0&&x.every(row=>valid(row.input)):x?.format==='player-hero-prospective-features-input-v1'&&valid(x);
}
const reportPath='.tools/s304-archive-review-r3.json';
const reportSha='01e4b85f3658ba912ae28f3b150bfe039bdc44149e1f2861a86f31d44c6437cc';
const recipes=[
 ['.tools/s2-07-coverage-fixed-20261106-opendota.json','ranked'],
 ['.tools/s2-07-coverage-primary-20261106-opendota-70388657.json','ranked'],
 ['.tools/s304-prospective-feature-parity-cases.json','synthetic'],
 ['.tools/s304-prospective-feature-input-r1.json','synthetic'],
];
async function compute(){
 const b=await readFile(resolve(root,reportPath));assert.equal(sha(b),reportSha,'archive_report_sha');
 const report=JSON.parse(b).result,entries=new Map(report.entries.map(e=>[e.path,e]));
 const ranked=new Set(),syntheticFiles=new Set(),evidence=[];
 for(const [path,kind] of recipes){
  const bytes=await readFile(resolve(root,path));assert.equal(sha(bytes),entries.get(path)?.sha256,'evidence_changed');
  const x=JSON.parse(bytes);
  if(kind==='ranked'){const ids=rankedArchiveIds(x);ids.forEach(i=>ranked.add(i));evidence.push({path,sha256:sha(bytes),kind,nativeMapIds:ids});}
  else{assert(syntheticArchive(x),'synthetic_flags');syntheticFiles.add(path);evidence.push({path,sha256:sha(bytes),kind});}
 }
 const decisions=report.summary.novelMapIds.map(matchId=>{
  const occurrences=report.entries.flatMap(e=>e.review.references
   .filter(r=>r.kind==='map'&&r.value===matchId&&r.status.startsWith('novel_'))
   .map(r=>({path:e.path,pointer:r.path,provider:r.provider})));
  const status=ranked.has(matchId)?'native_ranked_evidence':
   occurrences.length&&occurrences.every(o=>syntheticFiles.has(o.path))?'only_verified_synthetic_sources':'unresolved';
  return {matchId,status,occurrences};
 });
 const counts={};decisions.forEach(d=>counts[d.status]=(counts[d.status]??0)+1);
 return {format:'exposure-archive-triage-v1',source:{path:reportPath,sha256:reportSha},
  codeSha256:sha(await readFile(fileURLToPath(import.meta.url))),evidence,decisions,counts,
  automaticLedgerWrites:0,trainingEligibilityEstablished:false,completeGlobalInventory:false,registrationAllowed:false};
}
async function main(){
 const [mode,...extra]=process.argv.slice(2);assert(!extra.length&&['capture','verify'].includes(mode));
 const result=await compute(),path=resolve(root,'.tools/s304-archive-triage-r1.json'),bytes=JSON.stringify(result,null,2)+'\n';
 if(mode==='capture')await writeFile(path,bytes,{flag:'wx'});else assert.equal(await readFile(path,'utf8'),bytes,'triage_replay');
 console.log(JSON.stringify({sha256:sha(bytes),counts:result.counts,verified:mode==='verify'}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
 console.error('Разбор ссылок отклонён: проверьте исходный отчёт, SHA и признаки ranked/synthetic.');process.exitCode=1;
});
