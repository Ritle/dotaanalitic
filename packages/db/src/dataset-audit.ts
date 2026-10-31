import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { DatasetIdSchema, DatasetAuditDigestSchema, FrozenDatasetAuditContentSchema, FrozenDatasetAuditEnvelopeSchema } from '@dota/contracts';
import type { Executor } from './index.js';
import { canonicalContextJson } from './temporal.js';
import { assignDatasetSplits, providerSeriesKey, splitAt } from './dataset-splits.js';

export const DATASET_AUDIT_POLICY='frozen-split-audit-v1';
const splits=['train','calibration','validation','test'] as const;
const hash=(value:unknown)=>createHash('sha256').update(canonicalContextJson(value)).digest('hex');
const sha=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
type AuditSummary={maps:number;bySplit:Record<string,{n:number;fromAt:string|null;toAt:string|null;series:number}>;
  byPatch:Record<string,number>;syntheticOnly:boolean|null};
const emptySummary=():AuditSummary=>({maps:0,bySplit:Object.fromEntries(splits.map(s=>[s,{n:0,fromAt:null,toAt:null,series:0}])),byPatch:{},syntheticOnly:null});
const result=(status:'valid'|'invalid'|'unavailable',reasons:string[],fingerprint:string|null,summary:AuditSummary,
  structuralChecksPassed=false)=>({policyVersion:DATASET_AUDIT_POLICY,status,reasons:[...new Set(reasons)].sort(),fingerprint,
  structuralChecksPassed,summary,scope:'recorded_frozen_dataset' as const,remoteSeriesCompleteness:'unknown' as const,
  trainingReady:false as const,deployable:false as const});

/** Audit immutable recorded inputs only. Does not refetch sources or reassess historical facts against today's DB. */
export function auditFrozenDatasetContent(rawCanonicalContent:string,expectedSha:string) {
  const fingerprint=sha(rawCanonicalContent), summary=emptySummary();
  if(!DatasetAuditDigestSchema.safeParse(expectedSha).success || fingerprint!==expectedSha)
    return result('invalid',['DATASET_FINGERPRINT_MISMATCH'],fingerprint,summary);
  let raw:unknown;
  try{raw=JSON.parse(rawCanonicalContent);}catch{return result('invalid',['INVALID_JSON'],fingerprint,summary);}
  const envelope=FrozenDatasetAuditEnvelopeSchema.safeParse(raw);
  if(envelope.success && (envelope.data.format!=='pg-jsonb-dataset-v1'||envelope.data.manifest.feature_schema_version!=='prepared-context-v1'))
    return result('unavailable',['UNSUPPORTED_DATASET_FORMAT'],fingerprint,summary);
  const parsed=FrozenDatasetAuditContentSchema.safeParse(raw);
  if(!parsed.success)return result('invalid',['INVALID_FROZEN_CONTRACT'],fingerprint,summary);
  const {manifest,maps}=parsed.data,source=manifest.source_manifest,query=source.request;
  const errors=new Set<string>(),blockers=new Set<string>();
  const fail=(code:string)=>errors.add(code);
  const modern=source.policyVersion==='strict-context-preparation-v2';
  if(!modern && source.policyVersion!=='strict-context-preparation-v1')
    return result('unavailable',['UNSUPPORTED_PREPARATION_POLICY'],fingerprint,summary);
  if(manifest.cutoff_policy_version!==source.policyVersion || manifest.stage!==query.stage ||
    manifest.split_policy.version!==(modern?'explicit-windows-provider-series-v2':'explicit-windows-whole-series-v1')) fail('POLICY_MISMATCH');
  for(const key of ['fromAt','trainUntil','calibrationUntil','validationUntil','toAt'] as const)
    if(manifest.split_policy[key]!==query[key])fail('SPLIT_WINDOW_MISMATCH');
  // Hash original JSON values: PostgreSQL date serialization is normalized only for comparisons above.
  if(!envelope.success || hash(envelope.data.manifest.source_manifest)!==manifest.data_revision)fail('SOURCE_MANIFEST_HASH_MISMATCH');
  const unique=(ids:string[],code:string)=>{if(new Set(ids).size!==ids.length)fail(code);};
  unique(maps.map(m=>m.match_id),'DUPLICATE_MAP');unique(source.inputs.map(m=>m.matchId),'DUPLICATE_INPUT');
  unique(source.seriesInventory.map(m=>m.matchId),'DUPLICATE_INVENTORY_MAP');
  unique(source.summary.assessments.map(m=>m.matchId),'DUPLICATE_ASSESSMENT');
  const inputs=new Map(source.inputs.map(m=>[m.matchId,m])),inventory=new Map(source.seriesInventory.map(m=>[m.matchId,m]));
  const assessments=new Map(source.summary.assessments.map(m=>[m.matchId,m]));
  const canonicalKeys=new Map(source.inputs.map(i=>[i.seriesProof.id,i.seriesProof.provider+':'+i.seriesProof.providerSeriesId]));
  const aliasKeys=new Map<string,string|null>();
  const aliases=new Map((source.seriesAliases??[]).map(a=>[a.seriesId,a]));
  if(!modern)blockers.add('LEGACY_PROVIDER_ALIAS_INVENTORY_UNAVAILABLE');
  else if(!source.seriesAliases)fail('PROVIDER_ALIAS_INVENTORY_MISSING');
  else {
    unique(source.seriesAliases.map(a=>a.seriesId),'DUPLICATE_SERIES_ALIAS');
    const groups=new Map<string,Set<string>>();
    for(const alias of source.seriesAliases){
      const key=providerSeriesKey(alias.provider,alias.providerSeriesId);
      if(alias.providerSeriesKey!==key)fail('SERIES_ALIAS_KEY_MISMATCH');
      aliasKeys.set(alias.seriesId,key);
      if(key){const pairs=groups.get(key)??new Set<string>();
        pairs.add(alias.teamAId && alias.teamBId && alias.teamAId!==alias.teamBId?[alias.teamAId,alias.teamBId].sort().join(':'):'unknown');groups.set(key,pairs);}
    }
    for(const alias of source.seriesAliases){const pairs=alias.providerSeriesKey?groups.get(alias.providerSeriesKey):null;
      const knownPairs=pairs?[...pairs].filter(p=>p!=='unknown'):[];
      if(alias.seriesConflict!==(knownPairs.length>1) ||
        alias.seriesOrganizationsKnown!==(pairs!==null && pairs!==undefined && !pairs.has('unknown') && knownPairs.length===1))fail('SERIES_ALIAS_CONFLICT_MISMATCH');}
  }
  const members=source.seriesInventory.map(m=>({...m,providerSeriesKey:modern?m.providerSeriesKey:
    m.seriesId===null?null:canonicalKeys.get(m.seriesId)??'canonical:'+m.seriesId}));
  for(const member of members)if(modern && (member.providerSeriesKey===undefined || member.seriesConflict===undefined || member.seriesOrganizationsKnown===undefined ||
    member.seriesId!==null && (!aliasKeys.has(member.seriesId)||aliasKeys.get(member.seriesId)!==member.providerSeriesKey ||
      aliases.get(member.seriesId)?.seriesConflict!==member.seriesConflict ||
      aliases.get(member.seriesId)?.seriesOrganizationsKnown!==member.seriesOrganizationsKnown)))fail('SERIES_INVENTORY_ALIAS_MISMATCH');
  let decisions:ReturnType<typeof assignDatasetSplits>=[];
  if(!errors.has('DUPLICATE_INVENTORY_MAP')) decisions=assignDatasetSplits(members,query);
  const decisionsById=new Map(decisions.map(m=>[m.matchId,m]));
  const sourceIds=new Set(source.inputs.map(i=>i.matchId)),mapIds=new Set(maps.map(m=>m.match_id));
  if(sourceIds.size!==mapIds.size || [...sourceIds].some(id=>!mapIds.has(id)))fail('INPUT_MAP_SET_MISMATCH');
  const candidateIds=members.filter(m=>splitAt(m.startedAt,query)!==null).map(m=>m.matchId);
  if(candidateIds.length!==source.summary.candidates || assessments.size!==candidateIds.length || candidateIds.some(id=>!assessments.has(id)))fail('CANDIDATE_COVERAGE_MISMATCH');
  if(source.summary.eligible!==maps.length || source.summary.excluded!==source.summary.candidates-maps.length)fail('SUMMARY_COUNT_MISMATCH');
  for(const row of source.summary.assessments){const included=mapIds.has(row.matchId);
    if(included?row.reasons.length>0 || row.split===null:row.reasons.length===0 || row.split!==null)fail('EXCLUSION_MANIFEST_MISMATCH');}
  const groups=new Map<string,Set<string>>(),seriesBySplit=new Map(splits.map(s=>[s,new Set<string>()]));
  for(const map of maps){
    const input=inputs.get(map.match_id),member=inventory.get(map.match_id),assessment=assessments.get(map.match_id);
    if(!input || !member || !assessment){fail('MAP_PROVENANCE_MISSING');continue;}
    const snapshot=input.inputSnapshot,decision=decisionsById.get(map.match_id),key=input.seriesProof.provider+':'+input.seriesProof.providerSeriesId;
    const group=groups.get(key)??new Set<string>();group.add(map.split);groups.set(key,group);seriesBySplit.get(map.split)!.add(key);
    if(map.series_id_snapshot===null || map.series_id_snapshot!==member.seriesId || map.series_id_snapshot!==input.seriesProof.id)fail('SERIES_SNAPSHOT_MISMATCH');
    if(providerSeriesKey(input.seriesProof.provider,input.seriesProof.providerSeriesId)!==key ||
      [input.seriesProof.teamAId,input.seriesProof.teamBId].sort().join(':')!==[map.team_a_id,map.team_b_id].sort().join(':'))fail('SERIES_PROOF_MISMATCH');
    if(modern && (member.providerSeriesKey!==key || member.seriesConflict || !member.seriesOrganizationsKnown))fail('SERIES_MEMBERSHIP_CONFLICT');
    if(!decision || decision.reason!==null || decision.split!==map.split || assessment.split!==map.split)fail('SPLIT_ASSIGNMENT_MISMATCH');
    if(map.cutoff_at!==member.startedAt || snapshot.cutoffAt!==member.startedAt || snapshot.matchId!==map.match_id || snapshot.stage!==manifest.stage)fail('INPUT_CUTOFF_OR_STAGE_MISMATCH');
    if(snapshot.teamAId!==map.team_a_id || snapshot.teamBId!==map.team_b_id || snapshot.teamASide!==query.teamASide)fail('INPUT_SIDE_MISMATCH');
    if(hash(snapshot)!==input.inputSnapshotHash)fail('INPUT_SNAPSHOT_HASH_MISMATCH');
    if(hash(input.quality)!==input.qualityFingerprint)fail('QUALITY_HASH_MISMATCH');
    if(Object.keys(map.input_features).length || map.input_hash!==sha('{}'))fail('PREPARATION_FEATURES_NOT_EMPTY');
    if(map.label_verified_at!==query.snapshotAt || input.sourceEvidence.receiptFetchedAt>query.snapshotAt ||
      map.source_evidence.receiptFetchedAt>query.snapshotAt || map.label_verified_at<=map.cutoff_at)fail('LABEL_EVIDENCE_CLOCK_MISMATCH');
    if(map.outcome_receipt_id!==input.sourceEvidence.receiptId || map.outcome_receipt_id!==map.source_evidence.receiptId ||
      map.label_source!=='opendota:receipt:'+map.outcome_receipt_id || input.sourceEvidence.payloadSha256!==map.source_evidence.payloadSha256 ||
      map.match_data_revision!==input.dataRevision)fail('SOURCE_EVIDENCE_MISMATCH');
    const required=['lineup','teams','patch',...(manifest.stage==='post_draft'?['heroes']:[])];
    if(required.some(field=>!snapshot.facts.some(f=>f.field===field && f.value!==null)))fail('REQUIRED_INPUT_FACT_MISSING');
    if(manifest.stage==='pre_match' && snapshot.facts.some(f=>['heroes','first_pick_side','draft_order_version'].includes(f.field)))fail('PRE_MATCH_DRAFT_LEAK');
    for(const proof of [...snapshot.contextProofs,...snapshot.patchProofs,...snapshot.identityProofs])
      if(proof.knownAt===null || proof.knownAt>snapshot.cutoffAt || proof.eventAt!==null && proof.eventAt>snapshot.cutoffAt || proof.fetchedAt>query.snapshotAt)fail('INPUT_PROOF_CLOCK_MISMATCH');
    const patch=snapshot.facts.find(f=>f.field==='patch');
    if(patch?.field==='patch'){
      summary.byPatch[patch.value]=(summary.byPatch[patch.value]??0)+1;
      if(assessment.patchId!==patch.value)fail('PATCH_SUMMARY_MISMATCH');
    }
    const fold=summary.bySplit[map.split]!;fold.n++;fold.fromAt=fold.fromAt===null||map.cutoff_at<fold.fromAt?map.cutoff_at:fold.fromAt;
    fold.toAt=fold.toAt===null||map.cutoff_at>fold.toAt?map.cutoff_at:fold.toAt;
  }
  for(const values of groups.values())if(values.size>1)fail('PROVIDER_SERIES_CROSSES_SPLIT');
  for(const [i,name] of splits.entries()){
    const fold=summary.bySplit[name]!;fold.series=seriesBySplit.get(name)!.size;
    if(!fold.n)blockers.add('EMPTY_SPLIT_'+name.toUpperCase());
    if((source.summary.bySplit[name]??0)!==fold.n)fail('SPLIT_SUMMARY_MISMATCH');
    for(const later of splits.slice(i+1))if(fold.toAt!==null && summary.bySplit[later]!.fromAt!==null && fold.toAt>=summary.bySplit[later]!.fromAt!)fail('NON_CHRONOLOGICAL_SPLITS');
  }
  if(hash(summary.byPatch)!==hash(source.summary.byPatch))fail('PATCH_SUMMARY_MISMATCH');
  summary.maps=maps.length;summary.syntheticOnly=source.syntheticOnly;
  return result(errors.size?'invalid':blockers.size?'unavailable':'valid',[...errors,...blockers],fingerprint,summary,errors.size===0);
}

export class DatasetAuditRepository {
  constructor(private readonly db:Executor){}
  async audit(datasetId:string){
    const id=DatasetIdSchema.parse(datasetId);
    const row=(await sql<{fingerprint:string;content:string}>`SELECT dataset_fingerprint AS fingerprint,
      training_dataset_content(id)::text AS content FROM training_dataset_versions WHERE id=${id} AND status='frozen'`.execute(this.db)).rows[0];
    return {datasetId:id,...(row?auditFrozenDatasetContent(row.content,row.fingerprint):
      result('unavailable',['FROZEN_DATASET_NOT_FOUND'],null,emptySummary()))};
  }
}
