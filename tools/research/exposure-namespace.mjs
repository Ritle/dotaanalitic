import assert from 'node:assert/strict';
import {readFile,writeFile,stat,realpath} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha} from './exposure-ledger-core.mjs';
import {valveProjection,playerDiscoveryProjection,depthProjection,leagueSummaryProjection,pandascoreProjection,reconcileNamespaces} from './exposure-namespace-core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const refs={
 original:'.tools/s304-exposure-ledger-r2.json',archive:'.tools/s304-archive-review-r3.json',queue:'.tools/s304-archive-triage-r1.json',
 valveOld:'.tools/s1-08-bo2-valve-league.json',valveOldReceipt:'docs/evidence/s1-08-bo2-source.json',
 valveE1:'.tools/s3-01-e1-valve-league.json',valveE1Receipt:'.tools/s3-01-e1-valve-source.json',
 player:'.tools/player-history-discovery.json',playerProducer:'.tools/player-history-probe.mjs',
 depth:'docs/evidence/s2-01-player-history-depth.json',depthProducer:'.tools/history-depth-evidence.mjs',
 league:'.tools/essence-review-20261112/league-ids.json',panda:'.tools/s304-namespace-panda-r1.json',
};
const pinned={original:'7727f5671c3ff78dd44ff068fe44fc99fc012198178b7392268c6c535354fca7',
 archive:'01e4b85f3658ba912ae28f3b150bfe039bdc44149e1f2861a86f31d44c6437cc',
 queue:'dd201a915ceef2b08f950bbe47f32055484b121baa59589a00128a4a57bcb1c0'};
const codeFiles=['tools/research/exposure-namespace-core.mjs','tools/research/exposure-namespace.mjs','tools/research/exposure-ledger-core.mjs'];
const forbidden=/(^|[\\/])(private-owner|node_modules|corepack|\.git|pgdata)([\\/]|$)|(?:access|credential|password|cookie|session|secret)\.[^\\/]+$/i;
function local(p,output=false){
 assert(typeof p==='string');const full=resolve(root,p),r=relative(root,full).replaceAll('\\','/');
 assert(r&&!r.startsWith('../')&&!isAbsolute(r)&&!forbidden.test(r),'unsafe_path');
 assert(output?r.startsWith('.tools/')&&r.endsWith('.json'):(r.startsWith('.tools/')||r.startsWith('docs/evidence/'))&&/\.(json|mjs)$/.test(r),'path_scope');
 return full;
}
async function contained(p){const r=relative(root,await realpath(p));assert(r&&!r.startsWith('..')&&!isAbsolute(r)&&!forbidden.test(r),'unsafe_real_path');}
async function read(p,expected){
 const f=local(p);await contained(f);assert((await stat(f)).size<=128*1024**2,'file_limit');
 const b=await readFile(f);if(expected!==undefined){assert(/^[a-f0-9]{64}$/.test(expected));assert.equal(sha(b),expected,'source_sha_changed');}return b;
}
const parse=b=>JSON.parse(b.toString('utf8').replace(/^\uFEFF/,''));
const code=async()=>Object.fromEntries(await Promise.all(codeFiles.map(async p=>[p,sha(await readFile(resolve(root,p)))])));
async function write(p,x){const f=local(p,true);await contained(dirname(f));const b=JSON.stringify(x,null,2)+'\n';
 assert(Buffer.byteLength(b)<=128*1024**2,'report_limit');await writeFile(f,b,{flag:'wx'});return sha(b);}
export async function prepareNamespacePlan(path){
 local(path,true);const sources={};
 for(const [key,p] of Object.entries(refs)){const b=await read(p,pinned[key]);sources[key]={path:p,sha256:sha(b)};}
 const plan={format:'exposure-namespace-plan-v1',capturedAt:new Date().toISOString(),sources,code:await code(),registrationAllowed:false};
 return {sha256:await write(path,plan),sources:Object.keys(sources).length};
}
async function assemble(plan){
 assert.equal(plan.format,'exposure-namespace-plan-v1');assert.deepEqual(Object.keys(plan.sources).sort(),Object.keys(refs).sort());
 assert.deepEqual(plan.code,await code(),'code_changed');const b={},x={};let total=0;
 for(const [key,s] of Object.entries(plan.sources)){b[key]=await read(s.path,s.sha256);total+=b[key].length;assert(total<=256*1024**2,'total_limit');
  x[key]=key.endsWith('Producer')?b[key].toString('utf8'):parse(b[key]);}
 assert.equal(x.queue.source.sha256,plan.sources.archive.sha256,'queue_parent_mismatch');
 assert.equal(x.archive.result.baseline.sha256,plan.sources.original.sha256,'baseline_parent_mismatch');
 const pending=x.queue.decisions.filter(d=>d.status==='unresolved').map(d=>d.matchId);
 const projections=[
  ['valveOld',valveProjection(b.valveOld,x.valveOldReceipt.sources.find(r=>r.file===plan.sources.valveOld.path),plan.sources.valveOld.path)],
  ['valveE1',valveProjection(b.valveE1,x.valveE1Receipt,plan.sources.valveE1.path)],
  ['player',playerDiscoveryProjection(x.player,x.playerProducer)],['depth',depthProjection(x.depth,x.depthProducer)],
  ['league',leagueSummaryProjection(x.league)],
 ];
 const nativeSources=projections.map(([k,p])=>({path:plan.sources[k].path,sha256:plan.sources[k].sha256,adapter:p.basis,rows:p.rows}));
 const baseline={...x.archive.result.extendedLedger,sources:[...x.original.input.sources,...x.archive.result.archiveSources]};
 const result=reconcileNamespaces({pending,baseline,nativeSources,pandaEvidence:pandascoreProjection(x.panda),capturedAt:plan.capturedAt});
 return {...result,capturedAt:plan.capturedAt,sourceSummary:projections.map(([k,p])=>({key:k,basis:p.basis,rows:p.rows.length})),
  valveSeriesEvidence:projections.flatMap(([k,p])=>(p.valveSeries??[]).map(v=>({source:plan.sources[k],...v})))};
}
export async function captureNamespaces(planPath,path){
 await contained(dirname(local(path,true)));const b=await read(planPath),result=await assemble(parse(b));
 const report={format:'exposure-namespace-file-v1',sourcePlan:{path:planPath,sha256:sha(b)},environment:{node:process.version,code:await code()},result};
 return {sha256:await write(path,report),counts:result.counts,ledger:result.ledger.summary,referenceNamespaceComplete:result.referenceNamespaceComplete};
}
export async function verifyNamespaces(path,expected){
 assert(typeof expected==='string'&&/^[a-f0-9]{64}$/.test(expected),'external_sha_required');
 const report=parse(await read(path,expected));assert.equal(report.format,'exposure-namespace-file-v1');
 assert.deepEqual(report.environment,{node:process.version,code:await code()},'environment_changed');
 const plan=parse(await read(report.sourcePlan.path,report.sourcePlan.sha256));
 const result=await assemble(plan);assert.deepEqual(report.result,result,'replay_mismatch');
 return {verified:true,sha256:expected,counts:result.counts,ledger:result.ledger.summary};
}
async function main(){
 const [mode,a,b,...extra]=process.argv.slice(2);assert(!extra.length);let r;
 if(mode==='plan'){assert(b===undefined);r=await prepareNamespacePlan(a);}
 else if(mode==='capture')r=await captureNamespaces(a,b);else{assert.equal(mode,'verify');r=await verifyNamespaces(a,b);}
 console.log(JSON.stringify(r));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
 console.error('Разрешение пространств ID отклонено: проверьте источники, SHA, связи и новый путь результата.');process.exitCode=1;
});
