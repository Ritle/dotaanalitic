import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,relative,join,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {prepareV1PerMapFeatureHistory} from '../../packages/db/dist/index.js';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
import {preparePlayerHeroAudit,bindHeroHistory} from './post-draft-player-hero-audit.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const local=p=>relative(root,p).split(sep).join('/');
const index=rows=>{const m=new Map(rows.map(r=>[r.matchId,r]));assert.equal(m.size,rows.length);return m;};
const us=t=>(BigInt(Date.parse(t))*1000n).toString();
const immutable=(path,value)=>writeFile(path,JSON.stringify(value)+'\n',{flag:'wx'});
const paths={audit:'.tools/s304-player-hero-audit-r1.json',evidence:'docs/evidence/s3-04-player-hero-feature-audit.json',
 dataset:'.tools/s304-r2-dataset-r1.json',source:'.tools/s304-history-coverage-source-r1.json',
 capture:'.tools/s304-dataset-capture-final.json',importPlan:'.tools/s304-history-import-plan.json',inventory:'.tools/s304-final.json'};
const codePaths=['tools/research/player-hero-feature.mts','tools/research/player-hero-feature-contract.mjs','tests/node/player-hero-feature.test.mjs',
 'node_modules/typescript/lib/typescript.js','node_modules/typescript/lib/_tsc.js','package.json','pnpm-lock.yaml'];
async function load(){
 const loaded=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([k,p])=>[k,await boundedJson(join(root,p))])));
 assert.equal(loaded.audit.sha256,loaded.evidence.value.artifactSha256);
 for(const key of ['dataset','source','capture','importPlan','inventory'])assert.equal(loaded[key].sha256,loaded.audit.value.sourceHashes[key]);
 for(const [p,hash] of Object.entries(loaded.audit.value.code))assert.equal(sha(await readFile(join(root,p))),hash,'audit_code_changed');
 assert.equal(loaded.source.value.source.syntheticOnly,false);assert.equal(loaded.dataset.value.syntheticOnly,false);
 const code={};for(const p of codePaths)code[p]=sha(await readFile(join(root,p)));
 return {loaded,hashes:Object.fromEntries(Object.entries(loaded).map(([k,v])=>[k,v.sha256])),code};
}
async function register(directory){
 const s=await load();
 const args=['node_modules/typescript/bin/tsc','tools/research/player-hero-feature.mts','--strict','--noUncheckedIndexedAccess','--skipLibCheck',
  '--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--outDir','.tools/s304-hero-feature-runtime'];
 const compiled=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',maxBuffer:1024*1024});assert.equal(compiled.status,0,'strict_compile_failed');
 const bytes=await readFile(join(root,'.tools/s304-hero-feature-runtime/player-hero-feature.mjs'));
 const runtime=await import(pathToFileURL(join(root,'.tools/s304-hero-feature-runtime/player-hero-feature.mjs')).href);
 await mkdir(directory);await writeFile(join(directory,'runtime.mjs'),bytes,{flag:'wx'});
 const manifest={format:'player-hero-feature-contract-v1',registeredAt:new Date().toISOString(),directory:local(directory),node:process.version,
  inputs:s.hashes,code:s.code,compiledSha256:sha(bytes),compilerArgs:args,policy:runtime.FEATURE_POLICY,
  partitions:['train','validation'],targetSelection:'unchanged_R2_paired_eligible_no_outcome_or_metric_selection',
  calibrationAndTest:'not_computed',labelAccess:'no_labels_in_feature_input_or_output',
  trainingPerformed:false,scoringPerformed:false,deployable:false};
 await immutable(join(directory,'manifest.json'),manifest);
 return {status:'registered_before_feature_computation',manifestSha256:sha(await readFile(join(directory,'manifest.json'))),policy:manifest.policy};
}
async function checked(directory){
 const s=await load(),manifest=await boundedJson(join(directory,'manifest.json')),m=manifest.value;
 assert.equal(m.format,'player-hero-feature-contract-v1');assert.equal(m.directory,local(directory));assert.equal(m.node,process.version);
 assert.deepEqual(m.inputs,s.hashes);assert.deepEqual(m.code,s.code);assert(m.registeredAt<=new Date().toISOString());
 assert.deepEqual(m.partitions,['train','validation']);assert.equal(m.deployable,false);
 assert.equal(sha(await readFile(join(directory,'runtime.mjs'))),m.compiledSha256);
 const runtime=await import(pathToFileURL(join(directory,'runtime.mjs')).href);assert.deepEqual(m.policy,runtime.FEATURE_POLICY);
 return {...s,manifest,runtime};
}
async function compute(s){
 const l=s.loaded;assert.equal(digest(await preparePlayerHeroAudit()),digest(l.audit.value),'upstream_audit_replay');
 const source=l.source.value.source,prepared=prepareV1PerMapFeatureHistory(source),candidates=index(source.candidates);
 const heroes=structuredClone(l.capture.value.heroes);
 for(const id of l.dataset.value.targetLedger.addedHistoryOnlyIds){
  const p=l.importPlan.value.plan.maps.find(m=>m.matchId===id),m=candidates.get(id);assert(p&&!p.reasons.length&&m);
  heroes.push({matchId:id,dataRevision:m.dataRevision,receiptId:m.outcome.outcomeReceiptId,sourceSha256:p.projectionSha256,
   players:p.members.map(p=>({player_slot:p.slot,hero_id:p.heroId,player_id:p.playerId})),
   receiptPlayers:p.members.map(p=>({player_slot:p.slot,hero_id:p.heroId,account_id:Number(p.accountId)}))});
 }
 const bound=index(bindHeroHistory(prepared,source,heroes,l.inventory.value.maps).maps);
 const history={format:'verified-player-hero-history-v1',syntheticOnly:false,sourceSha256:l.source.sha256,
  fromAtUs:us(source.request.fromAt),toAtUs:us(source.request.toAt),snapshotAtUs:us(source.request.snapshotAt),maps:prepared.maps.map(m=>{
   const h=bound.get(m.matchId);
   return {matchId:m.matchId,startedAtUs:m.startedAtUs,completedAtUs:m.completedAtUs,fetchedAtUs:m.fetchedAtUs,knownAtUs:null,
    isPro:true,receiptSha256:m.payloadSha256,canonicalPatchId:h?.canonicalPatchId??null,
    players:[...m.teamA,...m.teamB].map(p=>({...p,heroId:h?.players.find(x=>x.playerId===p.playerId&&x.accountId===p.accountId)?.heroId??null}))};
  })};
 const builder=s.runtime.createPlayerHeroFeatureBuilder(history),audit=index(l.audit.value.rows);
 const rows=l.dataset.value.rows.map(r=>{
  const base={matchId:r.matchId,seriesKey:r.seriesKey,nominalWindow:r.nominalWindow,originalPairedEligible:r.pairedEligible,originalReasons:r.reasons,feature:null};
  if(!s.manifest.value.partitions.includes(r.nominalWindow))return {...base,status:'not_requested'};
  if(!r.pairedEligible)return {...base,status:'originally_ineligible'};
  const a=audit.get(r.matchId),old=r.featureSnapshot.elo.scenario;assert(a?.players);
  const members=new Map(a.players.map(p=>[`${p.playerId}:${p.accountId}`,p]));
  const side=players=>players.map(p=>{const member=members.get(`${p.playerId}:${p.accountId}`);assert(member);return {...p,heroId:member.heroId};});
  const scenario={targetMatchId:r.matchId,cutoffAtUs:old.cutoffAtUs,teamA:side(old.teamA),teamB:side(old.teamB),
   canonicalPatchId:a.canonicalPatchId,heroBasis:'reconstructed_final_receipt',selectedAtUs:old.lineup.selectedAtUs,sourceSha256:r.featureSnapshot.sourceSha256};
  const result=builder(scenario);
  for(const p of [...result.teamA,...result.teamB]){const prior=members.get(`${p.playerId}:${p.accountId}`);assert.equal(p.nRaw,prior.nRecent90Days);assert.deepEqual(p.matchIds,prior.recentMatchIds);}
  const expected=new Map(r.inputs.signedHeroes.map(h=>[h.heroId,h.value]));
  for(const [players,sign] of [[scenario.teamA,1],[scenario.teamB,-1]])for(const p of players)assert.equal(expected.get(p.heroId),sign,'A_B_orientation');
  return {...base,status:result.status,feature:result};
 });
 const summary=Object.fromEntries(['train','validation','calibration','development_test','warmup',null].map(partition=>{
  const rs=rows.filter(r=>r.nominalWindow===partition);
  return [partition??'outside_window',{targetRows:rs.length,computed:rs.filter(r=>r.status==='computed_research_only').length,
   unavailable:rs.filter(r=>r.status==='unavailable').length,notRequested:rs.filter(r=>r.status==='not_requested').length,
   originallyIneligible:rs.filter(r=>r.status==='originally_ineligible').length}];
 }));
 const body={format:'player-hero-development-features-v1',manifestSha256:s.manifest.sha256,policy:s.manifest.value.policy,sourceHashes:s.hashes,
  summary,rows,trainingPerformed:false,scoringPerformed:false,independentTest:false,deployable:false};
 return {...body,fingerprint:digest(body)};
}
async function main(){
 const [mode,path,...extra]=process.argv.slice(2);assert(['register','create','verify'].includes(mode)&&path&&!extra.length);
 const directory=resolve(root,path),rel=relative(join(root,'.tools'),directory);assert(rel&&!rel.startsWith('..')&&!rel.includes(':'));
 if(mode==='register'){console.log(JSON.stringify(await register(directory)));return;}
 const s=await checked(directory);
 if(mode==='create')await immutable(join(directory,'started.json'),{manifestSha256:s.manifest.sha256,startedAt:new Date().toISOString()});
 const started=(await boundedJson(join(directory,'started.json'))).value;assert.equal(started.manifestSha256,s.manifest.sha256);assert(started.startedAt>=s.manifest.value.registeredAt);
 const result=await compute(s);
 if(mode==='create')await immutable(join(directory,'features.json'),result);
 else assert.equal(digest((await boundedJson(join(directory,'features.json'))).value),digest(result),'feature_replay');
 console.log(JSON.stringify({status:mode==='create'?'created_research_features':'verified_research_features',fingerprint:result.fingerprint,summary:result.summary,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{
 console.error(e.code==='EEXIST'?'Контракт или результат уже существует; нужна отдельная версия.':'Расчёт признака отклонён: проверьте контракт, SHA, временные границы и входные данные.');process.exitCode=1;
});
