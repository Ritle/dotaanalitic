import assert from 'node:assert/strict';
import {readFile,writeFile,stat,realpath} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha} from './exposure-ledger-core.mjs';
import {auditCoverageFile,auditValveSeries} from './exposure-coverage-core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const parents={
 archive:{path:'.tools/s304-archive-review-r3.json',sha256:'01e4b85f3658ba912ae28f3b150bfe039bdc44149e1f2861a86f31d44c6437cc'},
 triage:{path:'.tools/s304-archive-triage-r1.json',sha256:'dd201a915ceef2b08f950bbe47f32055484b121baa59589a00128a4a57bcb1c0'},
 namespace:{path:'.tools/s304-namespace-report-r1.json',sha256:'be55c46227c122aaf004e9595c644d5e41ba5e774154f95621efe65ea94b41d9'},
};
const codeFiles=['tools/research/exposure-coverage.mjs','tools/research/exposure-coverage-core.mjs',
 'tools/research/exposure-archive-core.mjs','tools/research/exposure-ledger-core.mjs'];
const forbidden=/(^|[\\/])(private-owner|node_modules|corepack|\.git|pgdata)([\\/]|$)|(?:access|credential|password|cookie|session|secret)\.[^\\/]+$/i;
export function safeCoveragePath(p,output=false){
 assert(typeof p==='string');const full=resolve(root,p),r=relative(root,full).replaceAll('\\','/');
 assert(r&&!r.startsWith('../')&&!isAbsolute(r)&&!forbidden.test(r),'unsafe_path');
 assert((r.startsWith('.tools/')||(!output&&r.startsWith('docs/evidence/')))&&r.endsWith('.json'),'path_scope');return full;
}
async function contained(p){const r=relative(root,await realpath(p));assert(r&&!r.startsWith('..')&&!isAbsolute(r)&&!forbidden.test(r),'unsafe_real_path');}
async function read(p,expected){const f=safeCoveragePath(p);await contained(f);assert((await stat(f)).size<=128*1024**2,'file_limit');
 const b=await readFile(f);if(expected!==undefined)assert.equal(sha(b),expected,'source_sha_changed');return b;}
const parse=b=>JSON.parse(b.toString('utf8'));
const code=async()=>Object.fromEntries(await Promise.all(codeFiles.map(async p=>[p,sha(await readFile(resolve(root,p)))])));
async function compute(){
 const data={};for(const [k,v] of Object.entries(parents))data[k]=parse(await read(v.path,v.sha256));
 assert.equal(data.triage.source.sha256,parents.archive.sha256,'triage_parent');
 const archive=data.archive.result,ns=data.namespace.result,ledger=ns.ledger;
 const selected=archive.entries.filter(e=>e.review.status==='requires_review');assert(selected.length<=1000,'entry_limit');
 const entries=[];let bytes=0;
 for(const s of selected){const b=await read(s.path,s.sha256);bytes+=b.length;assert(bytes<=512*1024**2,'total_limit');
  const review=auditCoverageFile(b,ledger,data.triage,ns);
  entries.push({path:s.path,sha256:s.sha256,previousOpaqueReasons:[...new Set(s.review.opaque.map(o=>o.reason))],review});}
 const statusCounts={},opaqueReasons={};for(const e of entries){statusCounts[e.review.status]=(statusCounts[e.review.status]??0)+1;
  for(const o of e.review.opaque)opaqueReasons[o.reason]=(opaqueReasons[o.reason]??0)+1;}
 return {scope:'131 previously requires_review JSON files only; inherited exclusions and other formats remain out of scope',
  bytes,entries,statusCounts,opaqueReasons,sourceIssues:archive.sourceIssues,inheritedExcluded:archive.excluded,
  valveSeries:auditValveSeries(ns.valveSeriesEvidence,ledger),ledgerSummary:ledger.summary,
  completeGlobalInventory:false,registrationAllowed:false,collectionAllowed:false,deployable:false};
}
export async function captureCoverage(path){
 const f=safeCoveragePath(path,true);await contained(dirname(f));
 // Refuse overwrite before doing the bounded scan.
 try{await stat(f);throw Error('output_exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 const report={format:'exposure-coverage-file-v1',capturedAt:new Date().toISOString(),parents,
  environment:{node:process.version,code:await code()},result:await compute()};
 const bytes=JSON.stringify(report,null,2)+'\n';assert(Buffer.byteLength(bytes)<=128*1024**2,'report_limit');
 await writeFile(f,bytes,{flag:'wx'});return {sha256:sha(bytes),statusCounts:report.result.statusCounts,valve:report.result.valveSeries.counts};
}
export async function verifyCoverage(path,expected){
 assert(typeof expected==='string'&&/^[a-f0-9]{64}$/.test(expected),'external_sha_required');
 const report=parse(await read(path,expected));assert.equal(report.format,'exposure-coverage-file-v1');
 assert.equal(new Date(report.capturedAt).toISOString(),report.capturedAt,'invalid_clock');
 assert.deepEqual(report.parents,parents,'parent_changed');assert.deepEqual(report.environment,{node:process.version,code:await code()},'code_changed');
 assert.deepEqual(report.result,await compute(),'replay_mismatch');return {verified:true,sha256:expected,statusCounts:report.result.statusCounts};
}
async function main(){const [mode,p,h,...rest]=process.argv.slice(2);assert(!rest.length);
 if(mode==='capture'){assert(h===undefined);console.log(JSON.stringify(await captureCoverage(p)));}
 else{assert.equal(mode,'verify');console.log(JSON.stringify(await verifyCoverage(p,h)));}}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
 console.error('Проверка охвата отклонена: проверьте SHA, источники, лимиты и новый путь отчёта.');process.exitCode=1;
});
