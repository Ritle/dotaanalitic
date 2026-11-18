import assert from 'node:assert/strict';
import {readFile,writeFile,stat,realpath} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha} from './exposure-ledger-core.mjs';
import {verifyNamespaces} from './exposure-namespace.mjs';
import {detailSeriesProjection,leagueLastSeriesProjection,restoreBaselineSources,extendSeries} from './exposure-series-core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const parents={
 original:{path:'.tools/s304-exposure-ledger-r2.json',sha256:'7727f5671c3ff78dd44ff068fe44fc99fc012198178b7392268c6c535354fca7'},
 archive:{path:'.tools/s304-archive-review-r3.json',sha256:'01e4b85f3658ba912ae28f3b150bfe039bdc44149e1f2861a86f31d44c6437cc'},
 namespace:{path:'.tools/s304-namespace-report-r1.json',sha256:'be55c46227c122aaf004e9595c644d5e41ba5e774154f95621efe65ea94b41d9'},
 coverage:{path:'.tools/s304-coverage-report-r1.json',sha256:'1ebee3f0061fde43abc0e74eef990b56c082aee3c03f7051282727482cceada7'},
};
const codeFiles=['tools/research/exposure-series.mjs','tools/research/exposure-series-core.mjs','tools/research/exposure-ledger-core.mjs'];
const forbidden=/(^|[\\/])(private-owner|node_modules|corepack|\.git|pgdata)([\\/]|$)|(?:access|credential|password|cookie|session|secret)\.[^\\/]+$/i;
export function seriesArtifactPath(p,output=false){
 assert(typeof p==='string');const f=resolve(root,p),r=relative(root,f).replaceAll('\\','/');
 assert(r&&!r.startsWith('../')&&!isAbsolute(r)&&!forbidden.test(r),'unsafe_path');
 assert((r.startsWith('.tools/')||(!output&&r.startsWith('docs/evidence/')))&&r.endsWith('.json'),'path_scope');return f;
}
async function contained(f){const r=relative(root,await realpath(f));assert(r&&!r.startsWith('..')&&!isAbsolute(r)&&!forbidden.test(r),'unsafe_real_path');}
async function read(p,h){const f=seriesArtifactPath(p);await contained(f);assert((await stat(f)).size<=128*1024**2,'file_limit');
 const b=await readFile(f);if(h!==undefined)assert.equal(sha(b),h,'source_sha_changed');return b;}
const parse=b=>JSON.parse(b.toString('utf8'));
const code=async()=>Object.fromEntries(await Promise.all(codeFiles.map(async p=>[p,sha(await readFile(resolve(root,p)))])));
async function compute(capturedAt){
 const x={};for(const [k,s] of Object.entries(parents))x[k]=parse(await read(s.path,s.sha256));
 assert.deepEqual(x.coverage.parents.namespace,parents.namespace,'coverage_parent');
 await verifyNamespaces(parents.namespace.path,parents.namespace.sha256);
 const ledger=x.namespace.result.ledger;
 const sources=restoreBaselineSources(ledger,[...x.original.input.sources,...x.archive.result.archiveSources]);
 const entries=x.coverage.result.entries.filter(e=>e.review.unresolvedReferences.some(r=>r.kind==='series'&&r.provider==='opendota'));
 const expected=[...new Set(entries.flatMap(e=>e.review.unresolvedReferences.filter(r=>r.kind==='series'&&r.provider==='opendota').map(r=>r.value)))].sort();
 assert.equal(expected.length,24,'queue_size');
 const archived=new Map(x.archive.result.entries.map(e=>[e.path,e])),observations=[],traces=[];
 const bundles=new Map();
 const producer='tools/research/post-draft-history-details.mjs',producerSha=sha(await readFile(resolve(root,producer)));
 const fileEntries=entries.filter(e=>/\/map-[1-9]\d*\.json$/.test(e.path));assert.equal(fileEntries.length,30,'detail_scope');
 for(const e of fileEntries){
  const input=parse(await read(e.path,e.sha256)),dir=e.path.slice(0,e.path.lastIndexOf('/'));
  if(!bundles.has(dir)){
   const mp=dir+'/manifest.json',rp=dir+'/report.json',mh=archived.get(mp)?.sha256,rh=archived.get(rp)?.sha256;
   assert(mh&&rh,'unbound_bundle');const manifest=parse(await read(mp,mh)),report=parse(await read(rp,rh));
   assert.equal(report.manifestSha256,mh,'manifest_binding');
   assert.equal(manifest.code.find(c=>c.path===producer)?.sha256,producerSha,'producer_changed');
   assert(Array.isArray(report.rows)&&report.rows.length<=100000,'report_rows');
   bundles.set(dir,{manifest,report,trace:{manifest:{path:mp,sha256:mh},report:{path:rp,sha256:rh},producer:{path:producer,sha256:producerSha}}});
  }
  const bundle=bundles.get(dir),matches=bundle.report.rows.filter(r=>r.matchId===input.matchId);
  assert.equal(matches.length,1,'report_map_binding');assert.equal(matches[0].status,input.status);
  assert.deepEqual(matches[0].receipt,input.receipt,'report_receipt_binding');
  assert.equal(e.path.split('/').at(-1),'map-'+input.matchId+'.json','filename_binding');
  const p=detailSeriesProjection(input);
  if(input.receipt.basis==='validated_http_projected')assert(Date.parse(p.provenance.source.fetchedAt)>=Date.parse(bundle.manifest.registeredAt),'registration_clock');
  observations.push({...p,path:e.path,sha256:e.sha256});traces.push({path:e.path,...bundle.trace});
 }
 const league=entries.find(e=>e.path==='.tools/essence-review-20261112/league-ids.json');assert(league,'league_missing');
 observations.push({...leagueLastSeriesProjection(parse(await read(league.path,league.sha256))),path:league.path,sha256:league.sha256});
 return {...extendSeries(ledger,sources,observations,expected,capturedAt),expectedSeriesIds:expected,provenanceTraces:traces,
  baselineSummary:ledger.summary,providerRequests:0,businessWrites:0};
}
export async function captureSeries(path){
 const f=seriesArtifactPath(path,true);await contained(dirname(f));
 try{await stat(f);throw Error('output_exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 const capturedAt=new Date().toISOString(),report={format:'exposure-series-reconciliation-file-v1',capturedAt,parents,
  environment:{node:process.version,code:await code()},result:await compute(capturedAt)};
 const b=JSON.stringify(report,null,2)+'\n';assert(Buffer.byteLength(b)<=128*1024**2,'report_limit');await writeFile(f,b,{flag:'wx'});
 return {sha256:sha(b),ledger:report.result.ledger.summary,queueComplete:report.result.queueComplete};
}
export async function verifySeries(path,expected){
 assert(typeof expected==='string'&&/^[a-f0-9]{64}$/.test(expected),'external_sha_required');
 const report=parse(await read(path,expected));assert.equal(report.format,'exposure-series-reconciliation-file-v1');
 assert.equal(new Date(report.capturedAt).toISOString(),report.capturedAt,'clock');assert.deepEqual(report.parents,parents,'parent_changed');
 assert.deepEqual(report.environment,{node:process.version,code:await code()},'code_changed');
 assert.deepEqual(report.result,await compute(report.capturedAt),'replay_mismatch');return {verified:true,sha256:expected,ledger:report.result.ledger.summary};
}
async function main(){const [mode,p,h,...rest]=process.argv.slice(2);assert(!rest.length);
 if(mode==='capture'){assert(h===undefined);console.log(JSON.stringify(await captureSeries(p)));}
 else{assert.equal(mode,'verify');console.log(JSON.stringify(await verifySeries(p,h)));}}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
 console.error('Сверка серий отклонена: проверьте контрольные суммы, происхождение и новый путь отчёта.');process.exitCode=1;
});
