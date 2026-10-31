import { createHash } from 'node:crypto';
import { expect,it } from 'vitest';
import { auditFrozenDatasetContent } from '../src/dataset-audit.js';
import { canonicalContextJson } from '../src/temporal.js';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const hash=(value:unknown)=>sha(canonicalContextJson(value));
const time=(day:number)=>`2024-01-${String(day).padStart(2,'0')}T00:00:00.000Z`;
const uuid=(i:number)=>`123e4567-e89b-42d3-a456-${String(i).padStart(12,'0')}`;
const splits=['train','calibration','validation','test'];
// Synthetic serialized examples test the audit boundary; these are not model/training artifacts.
function fixture(){
  const request={stage:'pre_match',teamASide:'radiant',fromAt:time(1),trainUntil:time(5),calibrationUntil:time(10),
    validationUntil:time(15),toAt:time(20),snapshotAt:'2026-10-31T20:00:00.000Z',maxMaps:100};
  const members=[2,6,11,16].map((day,i)=>({matchId:String(9007199254740993n+BigInt(i)),seriesId:uuid(i),
    startedAt:time(day),providerSeriesKey:`opendota:${i+1}`,seriesConflict:false,seriesOrganizationsKnown:true}));
  const inputs=members.map((m,i)=>{
    const inputSnapshot={schemaVersion:'prepared-context-v1',stage:'pre_match',matchId:m.matchId,cutoffAt:m.startedAt,
      teamAId:'11',teamBId:'22',teamASide:'radiant',facts:[{field:'patch',value:'1'},
        {field:'teams',value:{radiantTeamId:'11',direTeamId:'22'}},
        {field:'lineup',value:Array.from({length:10},(_,n)=>({playerSlot:n<5?n:n+123,playerId:String(n+1)}))}],
      contextProofs:[],patchProofs:[],identityProofs:[],contextPolicyKey:'synthetic',identityPolicyVersion:'synthetic'};
    return {matchId:m.matchId,inputSnapshot,inputSnapshotHash:hash(inputSnapshot),seriesProof:{id:m.seriesId,
      provider:'opendota',providerSeriesId:String(i+1),teamAId:'11',teamBId:'22'},sourceEvidence:{receiptId:String(i+1),
      payloadSha256:'a'.repeat(64),receiptFetchedAt:'2026-10-30T00:00:00.000Z'},dataRevision:'1',quality:[],qualityFingerprint:hash([])};
  });
  const source={policyVersion:'strict-context-preparation-v2',request,cohort:'strict_verified_asof',trainingReady:false,
    deployable:false,syntheticOnly:true,featureState:'not_built',historyState:'not_built',seriesInventory:members,
    seriesAliases:members.map((m,i)=>({seriesId:m.seriesId,provider:'opendota',providerSeriesId:String(i+1),
      teamAId:'11',teamBId:'22',providerSeriesKey:m.providerSeriesKey,seriesConflict:false,seriesOrganizationsKnown:true})),
    inputs,summary:{candidates:4,eligible:4,excluded:0,bySplit:{train:1,calibration:1,validation:1,test:1},byPatch:{'1':4},
      assessments:members.map((m,i)=>({matchId:m.matchId,reasons:[] as string[],split:splits[i]! as string|null,patchId:'1'}))}};
  return {format:'pg-jsonb-dataset-v1',manifest:{stage:'pre_match',feature_schema_version:'prepared-context-v1',
    label_policy_version:'verified-map-v1',cutoff_policy_version:source.policyVersion,data_revision:hash(source),
    split_policy:{version:'explicit-windows-provider-series-v2',fromAt:request.fromAt,trainUntil:request.trainUntil,
      calibrationUntil:request.calibrationUntil,validationUntil:request.validationUntil,toAt:request.toAt},source_manifest:source},
    maps:members.map((m,i)=>({match_id:m.matchId,split:splits[i]!,team_a_id:'11',team_b_id:'22',cutoff_at:m.startedAt,
      input_features:{},input_hash:sha('{}'),team_a_won:true,label_source:`opendota:receipt:${i+1}`,
      label_verified_at:request.snapshotAt,source_evidence:inputs[i]!.sourceEvidence,outcome_receipt_id:String(i+1),
      match_data_revision:'1',series_id_snapshot:m.seriesId}))};
}
function run(value:ReturnType<typeof fixture>,rehashSource=true){
  if(rehashSource)value.manifest.data_revision=hash(value.manifest.source_manifest);
  const text=JSON.stringify(value);return auditFrozenDatasetContent(text,sha(text));
}
it('reports four distinct chronological folds and bigint IDs without claiming model readiness',()=>{
  const report=run(fixture());
  expect(report).toMatchObject({status:'valid',structuralChecksPassed:true,trainingReady:false,deployable:false,
    remoteSeriesCompleteness:'unknown',summary:{maps:4,syntheticOnly:true,byPatch:{'1':4}}});
  for(const split of splits)expect(report.summary.bySplit[split]).toMatchObject({n:1,series:1});
});
it('rejects tampered bytes before interpreting the payload and does not reinterpret unknown formats',()=>{
  const f=fixture(),raw=JSON.stringify(f);
  expect(auditFrozenDatasetContent(raw+' ',sha(raw)).reasons).toContain('DATASET_FINGERPRINT_MISMATCH');
  f.manifest.feature_schema_version='numeric-model-v9';
  expect(run(f)).toMatchObject({status:'unavailable',reasons:['UNSUPPORTED_DATASET_FORMAT']});
  expect(auditFrozenDatasetContent('{',sha('{')).reasons).toContain('INVALID_JSON');
});
it('detects duplicate map/input/inventory records and label-independent snapshot hash changes',()=>{
  const f=fixture();f.maps.push({...f.maps[0]!});
  f.manifest.source_manifest.inputs.push(structuredClone(f.manifest.source_manifest.inputs[0]!));
  f.manifest.source_manifest.seriesInventory.push({...f.manifest.source_manifest.seriesInventory[0]!});
  expect(run(f).reasons).toEqual(expect.arrayContaining(['DUPLICATE_MAP','DUPLICATE_INPUT','DUPLICATE_INVENTORY_MAP']));
  const g=fixture();g.manifest.source_manifest.inputs[0]!.inputSnapshot.teamAId='33';
  expect(run(g).reasons).toEqual(expect.arrayContaining(['INPUT_SNAPSHOT_HASH_MISMATCH','INPUT_SIDE_MISMATCH']));
});
it('detects declared windows, wrong cutoffs, swapped split assignments and source hash corruption',()=>{
  const f=fixture();f.manifest.split_policy.trainUntil=time(4);f.maps[0]!.cutoff_at=time(3);f.maps[3]!.split='train';
  expect(run(f).reasons).toEqual(expect.arrayContaining(['SPLIT_WINDOW_MISMATCH','INPUT_CUTOFF_OR_STAGE_MISMATCH',
    'SPLIT_ASSIGNMENT_MISMATCH','NON_CHRONOLOGICAL_SPLITS']));
  const g=fixture();g.manifest.source_manifest.request.maxMaps=99;
  expect(run(g,false).reasons).toContain('SOURCE_MANIFEST_HASH_MISMATCH');
});
it('detects external series aliases across folds even when canonical UUIDs differ',()=>{
  const f=fixture(),s=f.manifest.source_manifest;
  s.inputs[3]!.seriesProof.providerSeriesId='1';s.seriesInventory[3]!.providerSeriesKey='opendota:1';
  s.seriesAliases[3]!.providerSeriesId='1';s.seriesAliases[3]!.providerSeriesKey='opendota:1';
  expect(run(f).reasons).toEqual(expect.arrayContaining(['PROVIDER_SERIES_CROSSES_SPLIT','SPLIT_ASSIGNMENT_MISMATCH']));
});
it('requires consistent full recorded inventory and exclusions, including out-of-window siblings',()=>{
  const f=fixture(),s=f.manifest.source_manifest;
  s.seriesInventory.push({...s.seriesInventory[0]!,matchId:'10',startedAt:time(21)});
  expect(run(f).reasons).toContain('SPLIT_ASSIGNMENT_MISMATCH');
  const g=fixture();g.manifest.source_manifest.summary.assessments[0]!.reasons=['SYNTHETIC_EXCLUSION'];
  expect(run(g).reasons).toContain('EXCLUSION_MANIFEST_MISMATCH');
});
it('requires an explicit reason and no split for every excluded candidate',()=>{
  for(const declared of [{reasons:[] as string[],split:null},{reasons:['SYNTHETIC_EXCLUSION'],split:'train'}]){
    const f=fixture(),s=f.manifest.source_manifest;
    s.seriesInventory.push({...s.seriesInventory[0]!,matchId:'10',startedAt:time(3)});
    s.summary.candidates=5;s.summary.excluded=1;
    s.summary.assessments.push({matchId:'10',patchId:'1',...declared});
    expect(run(f)).toMatchObject({status:'invalid',reasons:expect.arrayContaining(['EXCLUSION_MANIFEST_MISMATCH'])});
  }
});
it('reports missing holdout as unavailable instead of a successful validation',()=>{
  const f=fixture(),s=f.manifest.source_manifest;f.maps.pop();s.inputs.pop();s.seriesInventory.pop();s.seriesAliases.pop();
  s.summary.assessments.pop();s.summary.candidates=3;s.summary.eligible=3;s.summary.bySplit.test=0;s.summary.byPatch['1']=3;
  const report=run(f);expect(report).toMatchObject({status:'unavailable',structuralChecksPassed:true});
  expect(report.reasons).toContain('EMPTY_SPLIT_TEST');
});
it('legacy v1 exports retain structural diagnostics without an unrecorded provider alias guarantee',()=>{
  const f=fixture(),s=f.manifest.source_manifest;s.policyVersion='strict-context-preparation-v1';
  f.manifest.cutoff_policy_version=s.policyVersion;f.manifest.split_policy.version='explicit-windows-whole-series-v1';
  const report=run(f);expect(report).toMatchObject({status:'unavailable',structuralChecksPassed:true});
  expect(report.reasons).toContain('LEGACY_PROVIDER_ALIAS_INVENTORY_UNAVAILABLE');
});
it('flags future source evidence and current draft facts in pre-match snapshots',()=>{
  const f=fixture(),s=f.manifest.source_manifest;
  s.inputs[0]!.sourceEvidence.receiptFetchedAt='2027-01-01T00:00:00.000Z';
  s.inputs[1]!.inputSnapshot.facts.push({field:'heroes',value:[{playerSlot:0,heroId:1}]});
  expect(run(f).reasons).toContain('LABEL_EVIDENCE_CLOCK_MISMATCH');
  expect(run(f).reasons).toContain('PRE_MATCH_DRAFT_LEAK');
});
it('does not round sub-millisecond SQL clocks through the target cutoff or verification horizon',()=>{
  for(const field of ['cutoff_at','label_verified_at'] as const){
    const f=fixture();f.maps[0]![field]=f.maps[0]![field].replace('.000Z','.000001+00:00');
    expect(run(f)).toMatchObject({status:'invalid',reasons:['INVALID_FROZEN_CONTRACT']});
  }
  const exact=fixture();exact.maps[0]!.cutoff_at=exact.maps[0]!.cutoff_at.replace('.000Z','.000000+00:00');
  expect(run(exact).status).toBe('valid');
});
it('validates provider keys using the same bounded namespace and bigint domain as preparation',()=>{
  for(const change of [{provider:'Open Dota',providerSeriesId:'1'},
    {provider:'opendota',providerSeriesId:'9223372036854775808'}]){
    const f=fixture(),alias=f.manifest.source_manifest.seriesAliases[0]!;
    Object.assign(alias,change);alias.providerSeriesKey=change.provider+':'+change.providerSeriesId;
    expect(run(f).reasons).toContain('SERIES_ALIAS_KEY_MISMATCH');
  }
});
it('cannot hide unknown alias organizations by marking a member as known',()=>{
  const f=fixture(),alias=f.manifest.source_manifest.seriesAliases[0]!;
  Object.assign(alias,{teamAId:null,seriesOrganizationsKnown:false});
  expect(run(f).reasons).toContain('SERIES_INVENTORY_ALIAS_MISMATCH');
});
