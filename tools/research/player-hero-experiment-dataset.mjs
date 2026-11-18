import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,relative,join,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {prepareV1PerMapFeatureHistory} from '../../packages/db/dist/index.js';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
import {preparePlayerHeroAudit,bindHeroHistory} from './post-draft-player-hero-audit.mjs';
import {buildPlayerHeroExperimentPlan,experimentPolicy} from './player-hero-experiment-plan.mjs';

const {z}=createRequire(new URL('../../packages/contracts/package.json',import.meta.url))('zod');
const root=fileURLToPath(new URL('../../',import.meta.url));
const policy=experimentPolicy();
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(x=>BigInt(x)<=9223372036854775807n);
const Time=z.string().datetime({precision:3});
const Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Window=z.enum(['warmup','train','validation','calibration','development_test']).nullable();
const Target=z.object({matchId:Id,seriesKey:z.string().nullable(),nominalWindow:Window,
 originalPairedEligible:z.boolean(),baselineEligible:z.boolean(),reasons:z.array(z.string()),eloLogit:z.number().finite().nullable(),
 eloSnapshotSha256:Sha.nullable(),teamAId:Id.nullable(),teamBId:Id.nullable(),teamASide:z.enum(['radiant','dire']).nullable()}).strict();
const Feature=z.object({matchId:Id,status:z.enum(['computed_research_only','unavailable','originally_ineligible','not_requested']),
 value:z.number().finite().nullable(),snapshotSha256:Sha.nullable(),reasons:z.array(z.string())}).strict();
const Metadata=z.object({matchId:Id,seriesKey:z.string().nullable(),startedAt:Time,completedAt:Time.nullable()}).strict();
const Label=z.object({matchId:Id,teamAWon:z.boolean(),completedAt:Time,verifiedAt:Time,receiptId:Id,
 sourceEvidence:z.object({receiptId:Id,payloadSha256:Sha,adapterVersion:z.string(),normalizerVersion:z.string(),receiptFetchedAt:Time}).strict()}).strict();
const Fact=z.object({matchId:Id,isPro:z.boolean().nullable(),verified:z.boolean(),radiantWin:z.boolean().nullable(),radiantTeamId:Id.nullable(),direTeamId:Id.nullable(),
 startedAt:Time,completedAt:Time.nullable(),label:Label.nullable()}).strict();
const numeric=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const sorted=ids=>[...ids].sort(numeric);
const index=rows=>{const m=new Map(rows.map(r=>[r.matchId,r]));assert.equal(m.size,rows.length,'duplicate_map');return m;};
const us=t=>(BigInt(Date.parse(t))*1000n).toString();
const local=p=>relative(root,p).split(sep).join('/');
const immutable=(path,value)=>writeFile(path,JSON.stringify(value)+'\n',{flag:'wx'});
const activeWindows=['train','validation','calibration','development_test'];

/** Labels are checked against frozen verified map facts, independently of feature computation. */
export function verifyPlayerHeroLabels(rawLabels,rawFacts){
 const labels=z.array(Label).max(5000).parse(rawLabels),facts=index(z.array(Fact).max(5000).parse(rawFacts));index(labels);
 for(const l of labels){
  const f=facts.get(l.matchId);assert(f?.verified&&f.isPro===true&&f.radiantWin!==null,'label_not_verified_pro');
  assert(f.radiantTeamId&&f.direTeamId&&f.radiantTeamId!==f.direTeamId,'label_sides_unknown');
  assert.deepEqual(l,f.label,'label_receipt_or_revision_changed');
  assert.equal(l.completedAt,f.completedAt);assert(l.completedAt>f.startedAt&&l.verifiedAt>=l.completedAt,'invalid_label_clock');
  assert(l.sourceEvidence.receiptFetchedAt>=l.completedAt&&l.sourceEvidence.receiptFetchedAt<=l.verifiedAt,'invalid_receipt_clock');
  assert.equal(l.receiptId,l.sourceEvidence.receiptId);
  assert.equal(l.teamAWon,BigInt(f.radiantTeamId)<BigInt(f.direTeamId)?f.radiantWin:!f.radiantWin,'label_A_B_orientation');
 }
 return labels;
}

/** Minimal strict DTOs keep target outcomes out of feature rows. Series exclusions preserve all denominators. */
export function assemblePlayerHeroDataset(raw){
 const input=z.object({targets:z.array(Target).max(5000),features:z.array(Feature).max(5000),labels:z.array(Label).max(5000),
 metadata:z.array(Metadata).max(5000),addedHistoryIds:z.array(Id).max(5000)}).strict().parse(raw);
 const t=index(input.targets),f=index(input.features),m=index(input.metadata),l=index(input.labels),added=new Set(input.addedHistoryIds),groups=new Map();
 assert.equal(added.size,input.addedHistoryIds.length);assert([...added].every(id=>!t.has(id)),'history_became_target');
 assert.deepEqual(sorted(f.keys()),sorted(t.keys()),'feature_denominator_drift');
 assert.deepEqual(sorted(m.keys()),sorted([...t.keys(),...added]),'metadata_denominator_drift');
 assert([...l.keys()].every(id=>t.has(id)),'foreign_label');
 for(const meta of input.metadata)if(meta.seriesKey){const g=groups.get(meta.seriesKey)??[];g.push(meta);groups.set(meta.seriesKey,g);}
 const rows=input.targets.map(r=>{
  const meta=m.get(r.matchId),feature=f.get(r.matchId),w=policy.windows.find(w=>meta.startedAt>=w.from&&meta.startedAt<w.until);
  assert.equal(r.nominalWindow,w?.name??null,'window_changed');
  const requested=activeWindows.includes(r.nominalWindow),reasons=[...r.reasons];
  if(r.originalPairedEligible){
   assert(requested&&r.baselineEligible&&r.eloLogit!==null&&r.eloSnapshotSha256,'invalid_original_eligibility');
   assert(r.teamAId&&r.teamBId&&BigInt(r.teamAId)<BigInt(r.teamBId)&&r.teamASide,'invalid_canonical_sides');
   assert(r.seriesKey&&r.seriesKey===meta.seriesKey,'eligible_series_unverified');
   for(const sibling of groups.get(r.seriesKey)){
    assert(sibling.startedAt>=w.from&&sibling.startedAt<w.until&&sibling.completedAt&&sibling.completedAt<w.until&&sibling.completedAt>sibling.startedAt,'series_crosses_window');
    const other=t.get(sibling.matchId);assert(!other||other.originalPairedEligible,'original_partial_series');
   }
   assert(['computed_research_only','unavailable'].includes(feature.status),'missing_requested_feature');
   assert(feature.snapshotSha256,'missing_feature_snapshot');
   assert.equal(feature.status==='computed_research_only',feature.value!==null,'feature_status_mismatch');
   if(feature.value===null)reasons.push('PLAYER_HERO_FEATURE_UNAVAILABLE',...feature.reasons);
   assert(l.has(r.matchId),'eligible_label_missing');
  }else{
   assert.equal(feature.value,null,'ineligible_feature_computed');
   assert.equal(feature.status,requested?'originally_ineligible':'not_requested');
  }
  return {...r,startedAt:meta.startedAt,pairedEligible:r.originalPairedEligible&&feature.value!==null,
   reasons:[...new Set(reasons)].sort(),inputs:r.originalPairedEligible&&feature.value!==null?{eloLogit:r.eloLogit,observedHeroPracticeLog90Delta:feature.value}:null,
   practiceSnapshotSha256:feature.snapshotSha256};
 });
 const bad=new Set(rows.filter(r=>r.originalPairedEligible&&!r.pairedEligible).map(r=>r.seriesKey));
 for(const r of rows)if(r.originalPairedEligible&&bad.has(r.seriesKey)){
  r.pairedEligible=false;r.inputs=null;r.reasons=[...new Set([...r.reasons,'SERIES_HAS_UNAVAILABLE_PRACTICE'])].sort();
 }
 const partitions=Object.fromEntries(policy.windows.map(w=>{
  const rs=rows.filter(r=>r.nominalWindow===w.name),selected=rs.filter(r=>r.pairedEligible);
  return [w.name,{plannedDenominator:rs.length,originalPairedMaps:rs.filter(r=>r.originalPairedEligible).length,pairedMaps:selected.length,
   pairedSeries:new Set(selected.map(r=>r.seriesKey)).size,pairedCoverage:rs.length?selected.length/rs.length:null,
   baselineOnlyMaps:rs.filter(r=>r.baselineEligible&&!r.pairedEligible).length,unavailableMaps:rs.filter(r=>!r.baselineEligible).length,
   labels:{teamAWins:selected.filter(r=>l.get(r.matchId).teamAWon).length,teamBWins:selected.filter(r=>!l.get(r.matchId).teamAWon).length}}];
 }));
 return {format:'player-hero-experiment-dataset-v1',featureSchemaVersion:'conditional-elo-player-hero-practice-v1',
  featureOrder:policy.models.H2.features,evaluationBasis:policy.basis,syntheticOnly:false,partitions,
  targetLedger:{count:rows.length,mapIds:sorted(t.keys()),addedHistoryOnlyIds:sorted(added),outsideWindows:rows.filter(r=>r.nominalWindow===null).length,
   knownSeriesMembershipChecked:true,remoteSeriesCompleteness:'unknown_not_inferred'},
  rows:rows.sort((a,b)=>numeric(a.matchId,b.matchId)),labelCount:input.labels.length,
  trainingPerformed:false,scoringPerformed:false,independentTest:false,deployable:false};
}

const refs={plan:'docs/evidence/s3-04-player-hero-experiment-plan.json',manifest:'.tools/s304-hero-contract-r1/manifest.json',
 priorFeatures:'.tools/s304-hero-contract-r1/features.json',audit:'.tools/s304-player-hero-audit-r1.json',
 dataset:'.tools/s304-r2-dataset-r1.json',metadata:'.tools/s304-r2-metadata-r1.json',source:'.tools/s304-history-coverage-source-r1.json',
 capture:'.tools/s304-dataset-capture-final.json',importPlan:'.tools/s304-history-import-plan.json',inventory:'.tools/s304-final.json'};
const implementation=['tools/research/player-hero-experiment-dataset.mjs','tests/node/player-hero-experiment-dataset.test.mjs'];
async function load(){
 const loaded={};for(const [k,p] of Object.entries(refs))loaded[k]=await boundedJson(join(root,p));
 const plan=loaded.plan.value,manifest=loaded.manifest.value,d=loaded.dataset.value,prior=loaded.priorFeatures.value;
 const {fingerprint,...body}=plan;assert.equal(digest(body),fingerprint);assert.deepEqual(plan.policy,policy);
 for(const ref of Object.values(plan.inputs))assert.equal(sha(await readFile(join(root,ref.path))),ref.sha256,'registered_input_changed');
 for(const [p,h] of Object.entries({...plan.code,...manifest.code,...loaded.audit.value.code}))assert.equal(sha(await readFile(join(root,p))),h,'frozen_code_changed');
 for(const k of ['dataset','source','capture','importPlan','inventory'])assert.equal(loaded[k].sha256,loaded.audit.value.sourceHashes[k]);
 assert.equal(loaded.audit.sha256,manifest.inputs.audit);assert.equal(loaded.manifest.sha256,prior.manifestSha256);
 const check=buildPlayerHeroExperimentPlan({registeredAt:plan.registeredAt,featurePolicy:manifest.policy,
  targets:d.rows.map(r=>({matchId:r.matchId,seriesKey:r.seriesKey,nominalWindow:r.nominalWindow,pairedEligible:r.pairedEligible})),
  features:prior.rows.map(r=>({matchId:r.matchId,nominalWindow:r.nominalWindow,originalPairedEligible:r.originalPairedEligible,status:r.status,feature:r.feature?.feature??null})),
  metadata:loaded.metadata.value,addedHistoryIds:d.targetLedger.addedHistoryOnlyIds});
 for(const [k,v] of Object.entries(check))assert.deepEqual(plan[k],v,'registered_plan_replay');
 for(const artifact of [prior,d,loaded.audit.value]){const {fingerprint,...body}=artifact;assert.equal(digest(body),fingerprint);assert.equal(artifact.deployable,false);}
 assert.equal(d.syntheticOnly,false);assert.equal(loaded.source.value.source.syntheticOnly,false);
 const runtimePath='.tools/s304-hero-contract-r1/runtime.mjs',runtimeSha=sha(await readFile(join(root,runtimePath)));assert.equal(runtimeSha,manifest.compiledSha256);
 const runtime=await import(pathToFileURL(join(root,runtimePath)).href);assert.deepEqual(runtime.FEATURE_POLICY,policy.featureContract);
 const code={};for(const p of implementation)code[p]=sha(await readFile(join(root,p)));
 return {loaded,runtime,inputs:Object.fromEntries(Object.entries(loaded).map(([k,v])=>[k,{path:refs[k],sha256:v.sha256}])),code,runtimeSha};
}

async function compute(s){
 const l=s.loaded,d=l.dataset.value;assert.equal(digest(await preparePlayerHeroAudit()),digest(l.audit.value),'audit_replay');
 const source=l.source.value.source,prepared=prepareV1PerMapFeatureHistory(source),candidates=index(source.candidates),heroes=structuredClone(l.capture.value.heroes);
 for(const id of d.targetLedger.addedHistoryOnlyIds){
  const p=l.importPlan.value.plan.maps.find(m=>m.matchId===id),m=candidates.get(id);assert(p&&!p.reasons.length&&m);
  heroes.push({matchId:id,dataRevision:m.dataRevision,receiptId:m.outcome.outcomeReceiptId,sourceSha256:p.projectionSha256,
   players:p.members.map(p=>({player_slot:p.slot,hero_id:p.heroId,player_id:p.playerId})),
   receiptPlayers:p.members.map(p=>({player_slot:p.slot,hero_id:p.heroId,account_id:Number(p.accountId)}))});
 }
 const bound=index(bindHeroHistory(prepared,source,heroes,l.inventory.value.maps).maps);
 const history={format:'verified-player-hero-history-v1',syntheticOnly:false,sourceSha256:l.source.sha256,
  fromAtUs:us(source.request.fromAt),toAtUs:us(source.request.toAt),snapshotAtUs:us(source.request.snapshotAt),maps:prepared.maps.map(m=>{
   const h=bound.get(m.matchId);
   return {matchId:m.matchId,startedAtUs:m.startedAtUs,completedAtUs:m.completedAtUs,fetchedAtUs:m.fetchedAtUs,knownAtUs:null,isPro:true,
    receiptSha256:m.payloadSha256,canonicalPatchId:h?.canonicalPatchId??null,
    players:[...m.teamA,...m.teamB].map(p=>({...p,heroId:h?.players.find(x=>x.playerId===p.playerId&&x.accountId===p.accountId)?.heroId??null}))};
  })};
 const builder=s.runtime.createPlayerHeroFeatureBuilder(history),audit=index(l.audit.value.rows);
 const features=d.rows.map(r=>{
  const base={matchId:r.matchId,seriesKey:r.seriesKey,nominalWindow:r.nominalWindow,originalPairedEligible:r.pairedEligible,originalReasons:r.reasons,feature:null};
  if(!activeWindows.includes(r.nominalWindow))return {...base,status:'not_requested'};
  if(!r.pairedEligible)return {...base,status:'originally_ineligible'};
  const a=audit.get(r.matchId),old=r.featureSnapshot.elo.scenario;assert(a?.players);
  const members=new Map(a.players.map(p=>[`${p.playerId}:${p.accountId}`,p]));
  const side=players=>players.map(p=>{const member=members.get(`${p.playerId}:${p.accountId}`);assert(member);return {...p,heroId:member.heroId};});
  const scenario={targetMatchId:r.matchId,cutoffAtUs:old.cutoffAtUs,teamA:side(old.teamA),teamB:side(old.teamB),canonicalPatchId:a.canonicalPatchId,
   heroBasis:'reconstructed_final_receipt',selectedAtUs:old.lineup.selectedAtUs,sourceSha256:r.featureSnapshot.sourceSha256};
  const result=builder(scenario);
  for(const p of [...result.teamA,...result.teamB]){const prior=members.get(`${p.playerId}:${p.accountId}`);assert.equal(p.nRaw,prior.nRecent90Days);assert.deepEqual(p.matchIds,prior.recentMatchIds);}
  const expected=new Map(r.inputs.signedHeroes.map(h=>[h.heroId,h.value]));
  for(const [players,sign] of [[scenario.teamA,1],[scenario.teamB,-1]])for(const p of players)assert.equal(expected.get(p.heroId),sign,'A_B_orientation');
  assert.equal(scenario.cutoffAtUs,us(l.metadata.value.find(m=>m.matchId===r.matchId).startedAt));
  return {...base,status:result.status,feature:result};
 });
 const prior=index(l.priorFeatures.value.rows),earlyParity={};
 for(const name of ['train','validation']){
  const rows=features.filter(r=>r.nominalWindow===name);for(const r of rows)assert.deepEqual(r,prior.get(r.matchId),'early_feature_drift');
  earlyParity[name]={targetRows:rows.length,computed:rows.filter(r=>r.status==='computed_research_only').length,rowsSha256:digest(rows),status:'exact'};
 }
 // Original target receipts keep their original verification times; newer capture re-verification does not rewrite labels.
 const facts=l.capture.value.source.candidates.map(m=>{
  const o=m.outcome,verified=o.status==='verified';
  return {matchId:m.matchId,isPro:m.isPro,verified,radiantWin:m.radiantWin,radiantTeamId:m.radiantTeamId,direTeamId:m.direTeamId,
   startedAt:new Date(Number(BigInt(m.startedAtUs)/1000n)).toISOString(),completedAt:m.endedAtUs?new Date(Number(BigInt(m.endedAtUs)/1000n)).toISOString():null,
   label:verified?{matchId:m.matchId,teamAWon:BigInt(o.teamAId)<BigInt(o.teamBId)?o.teamAWon:!o.teamAWon,completedAt:o.completedAt,
    verifiedAt:o.labelVerifiedAt,receiptId:o.outcomeReceiptId,sourceEvidence:o.sourceEvidence}:null};
 });
 const labels=verifyPlayerHeroLabels(d.labels,facts);
 for(const r of d.rows.filter(r=>r.pairedEligible)){
  const c=candidates.get(r.matchId),a=r.featureSnapshot;assert.equal(c.isPro,true);assert.equal(c.outcome.status,'verified');
  assert.equal(a.teamAId,a.teamASide==='radiant'?c.radiantTeamId:c.direTeamId);
  assert.equal(a.teamBId,a.teamASide==='radiant'?c.direTeamId:c.radiantTeamId);
 }
 const targets=d.rows.map(r=>({matchId:r.matchId,seriesKey:r.seriesKey,nominalWindow:r.nominalWindow,originalPairedEligible:r.pairedEligible,
  baselineEligible:r.baselineEligible,reasons:r.reasons,eloLogit:r.inputs?.eloLogit??null,eloSnapshotSha256:r.featureSnapshot?digest(r.featureSnapshot.elo):null,
  teamAId:r.featureSnapshot?.teamAId??null,teamBId:r.featureSnapshot?.teamBId??null,teamASide:r.featureSnapshot?.teamASide??null}));
 const dataset=assemblePlayerHeroDataset({targets,features:features.map(r=>({matchId:r.matchId,status:r.status,value:r.feature?.feature??null,
  snapshotSha256:r.feature?digest(r.feature):null,reasons:r.feature?.reasons??[]})),labels,
  metadata:l.metadata.value.map(m=>({matchId:m.matchId,seriesKey:m.seriesId&&m.seriesProvider==='opendota'&&/^[1-9]\d*$/.test(m.sourceSeriesId??'')?JSON.stringify(['opendota',m.sourceSeriesId]):null,
   startedAt:m.startedAt,completedAt:m.completedAt})),addedHistoryIds:d.targetLedger.addedHistoryOnlyIds});
 const featureArtifact={format:'player-hero-experiment-features-v1',policy:policy.featureContract,rows:features,earlyParity,deployable:false};
 const labelArtifact={format:'player-hero-experiment-labels-v1',basis:'verified_original_professional_map_receipts_canonical_A_B',rows:labels,deployable:false};
 return {dataset,features:featureArtifact,labels:labelArtifact};
}

async function main(){
 const [mode,path,...extra]=process.argv.slice(2);assert(['register','create','verify'].includes(mode)&&path&&!extra.length);
 const directory=resolve(root,path),rel=relative(join(root,'.tools'),directory);assert(rel&&!rel.startsWith('..')&&!rel.includes(':'));
 const s=await load();
 const definition={format:'player-hero-experiment-dataset-manifest-v1',directory:local(directory),node:process.version,inputs:s.inputs,code:s.code,
  runtimeSha256:s.runtimeSha,partitions:activeWindows,policy,trainingPerformed:false,scoringPerformed:false,deployable:false};
 if(mode==='register'){
  const registeredAt=new Date().toISOString();assert(registeredAt>=s.loaded.plan.value.registeredAt);
  await mkdir(directory);await immutable(join(directory,'manifest.json'),{...definition,registeredAt});
  console.log(JSON.stringify({status:'registered_before_dataset_computation',directory:local(directory),deployable:false}));return;
 }
 const manifest=await boundedJson(join(directory,'manifest.json')),{registeredAt,...saved}=manifest.value;assert.deepEqual(saved,definition);
 assert(registeredAt>=s.loaded.plan.value.registeredAt&&registeredAt<=new Date().toISOString());
 if(mode==='create')await immutable(join(directory,'started.json'),{manifestSha256:manifest.sha256,startedAt:new Date().toISOString()});
 const started=(await boundedJson(join(directory,'started.json'))).value;assert.equal(started.manifestSha256,manifest.sha256);assert(started.startedAt>=registeredAt&&started.startedAt<=new Date().toISOString());
 const result=await compute(s),artifacts={};
 for(const name of ['features','labels']){
  const body={...result[name],manifestSha256:manifest.sha256},artifact={...body,fingerprint:digest(body)};
  const path=join(directory,name+'.json');if(mode==='create')await immutable(path,artifact);
  const stored=await boundedJson(path);assert.deepEqual(stored.value,artifact,'artifact_replay');artifacts[name]={path:local(path),sha256:stored.sha256};
 }
 const body={...result.dataset,manifestSha256:manifest.sha256,protocolFingerprint:s.loaded.plan.value.fingerprint,artifacts,
  earlyParity:result.features.earlyParity},dataset={...body,fingerprint:digest(body)},pathOut=join(directory,'dataset.json');
 if(mode==='create')await immutable(pathOut,dataset);else assert.deepEqual((await boundedJson(pathOut)).value,dataset,'dataset_replay');
 console.log(JSON.stringify({status:mode==='create'?'frozen_research_dataset':'verified_research_dataset',fingerprint:dataset.fingerprint,
  partitions:dataset.partitions,labelCount:dataset.labelCount,earlyParity:dataset.earlyParity,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{
 console.error(e.code==='EEXIST'?'Выборка уже существует; нужна отдельная версия.':'Выборка отклонена: проверьте SHA, протокол, исходы, временные границы и серии.');process.exitCode=1;
});
