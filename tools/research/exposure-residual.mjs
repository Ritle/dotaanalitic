import assert from 'node:assert/strict';
import {readFile,writeFile,stat,realpath} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha} from './exposure-ledger-core.mjs';
import {verifySeries,seriesArtifactPath} from './exposure-series.mjs';
import {classifyResidual} from './exposure-residual-core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const parents={
 series:{path:'.tools/s304-series-reconciliation-r1.json',sha256:'ddffc46af97c411bba20e5d3c407a30584f8be076e8511f866df3eb73173c9e3'},
 coverage:{path:'.tools/s304-coverage-report-r1.json',sha256:'1ebee3f0061fde43abc0e74eef990b56c082aee3c03f7051282727482cceada7'},
 namespace:{path:'.tools/s304-namespace-report-r1.json',sha256:'be55c46227c122aaf004e9595c644d5e41ba5e774154f95621efe65ea94b41d9'},
};
const codeFiles=['tools/research/exposure-residual.mjs','tools/research/exposure-residual-core.mjs',
 'tools/research/exposure-series.mjs','tools/research/exposure-archive-triage.mjs','tools/research/exposure-ledger-core.mjs'];
async function contained(p){const r=relative(root,await realpath(p));assert(r&&!r.startsWith('..')&&!isAbsolute(r)&&!/(^|[\\/])(private-owner|node_modules|\.git|pgdata)([\\/]|$)/i.test(r),'unsafe_real_path');}
async function read(p,h){const f=seriesArtifactPath(p);await contained(f);assert((await stat(f)).size<=128*1024**2,'file_limit');
 const b=await readFile(f);if(h!==undefined)assert.equal(sha(b),h,'source_sha_changed');return b;}
const parse=b=>JSON.parse(b.toString('utf8'));
const code=async()=>Object.fromEntries(await Promise.all(codeFiles.map(async p=>[p,sha(await readFile(resolve(root,p)))])));
async function compute(){
 const x={};for(const [k,p] of Object.entries(parents))x[k]=parse(await read(p.path,p.sha256));
 assert.deepEqual(x.series.parents.coverage,parents.coverage);assert.deepEqual(x.series.parents.namespace,parents.namespace);
 await verifySeries(parents.series.path,parents.series.sha256);
 const ledger=x.series.result.ledger,keys=new Set(ledger.canonicalSeriesKeys),entries=[];let bytes=0;
 for(const e of x.coverage.result.entries.filter(e=>e.review.status==='requires_review')){
  const unresolvedReferences=e.review.unresolvedReferences.filter(r=>!(r.kind==='series'&&r.provider!=='stratz'&&keys.has(JSON.stringify(['opendota',r.value]))));
  if(!unresolvedReferences.length&&!e.review.opaque.length)continue;
  const b=await read(e.path,e.sha256);bytes+=b.length;assert(bytes<=256*1024**2,'total_limit');
  entries.push({path:e.path,sha256:e.sha256,disposition:classifyResidual(e.path,parse(b),{...e.review,unresolvedReferences},ledger,x.namespace.result.valveSeriesEvidence)});
 }
 assert.equal(entries.length,19,'residual_scope_changed');
 const kinds={},categories={};for(const e of entries){const d=e.disposition;kinds[d.kind]=(kinds[d.kind]??0)+1;
  for(const f of d.fields)categories[f.category]=(categories[f.category]??0)+1;}
 return {entries,bytes,kinds,categories,residualDispositionComplete:entries.every(e=>e.disposition.complete),
  ledgerSummary:ledger.summary,newNativeMaps:0,newCanonicalAliases:0,
  scopeDecision:{scope:'fixed archived JSON artifacts and explicit native references only',
   narrativeTextIncludedInMachineInventory:false,excludedArchiveEntries:x.coverage.result.inheritedExcluded.length,
   inheritedSourceIssues:x.coverage.result.sourceIssues,unknownSeriesMaps:ledger.summary.unresolvedMaps,
   futureCandidateNeedsOwnMapSeriesAndTemporalEvidence:true,
   note:'Resolved field meaning is not proof of whole-project exposure absence. Source text, logs, other formats and later files are outside this certification.'},
  completeGlobalInventory:false,registrationAllowed:false,collectionAllowed:false,deployable:false};
}
export async function captureResidual(path){
 const f=seriesArtifactPath(path,true);await contained(dirname(f));
 try{await stat(f);throw Error('output_exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 const report={format:'exposure-residual-disposition-file-v1',capturedAt:new Date().toISOString(),parents,
  environment:{node:process.version,code:await code()},result:await compute()};
 const b=JSON.stringify(report,null,2)+'\n';assert(Buffer.byteLength(b)<=128*1024**2,'report_limit');await writeFile(f,b,{flag:'wx'});
 return {sha256:sha(b),kinds:report.result.kinds,categories:report.result.categories,residualDispositionComplete:report.result.residualDispositionComplete};
}
export async function verifyResidual(path,expected){
 assert(typeof expected==='string'&&/^[a-f0-9]{64}$/.test(expected),'external_sha_required');
 const report=parse(await read(path,expected));assert.equal(report.format,'exposure-residual-disposition-file-v1');
 assert.equal(new Date(report.capturedAt).toISOString(),report.capturedAt,'clock');assert.deepEqual(report.parents,parents,'parent_changed');
 assert.deepEqual(report.environment,{node:process.version,code:await code()},'code_changed');assert.deepEqual(report.result,await compute(),'replay_mismatch');
 return {verified:true,sha256:expected,residualDispositionComplete:report.result.residualDispositionComplete};
}
async function main(){const [mode,p,h,...rest]=process.argv.slice(2);assert(!rest.length);
 if(mode==='capture'){assert(h===undefined);console.log(JSON.stringify(await captureResidual(p)));}
 else{assert.equal(mode,'verify');console.log(JSON.stringify(await verifyResidual(p,h)));}}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
 console.error('Классификация остатка отклонена: проверьте источники, контрольные суммы и границы охвата.');process.exitCode=1;
});
