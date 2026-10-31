import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { DatasetBuildRequestSchema, DatasetIdSchema, DatasetManifestSchema,
  type DatasetBuildRequest, type ReadinessField } from '@dota/contracts';
import type { Db, Executor } from './index.js';
import { DatasetRepository } from './dataset-repository.js';
import { OutcomeVerifier } from './outcome-verifier.js';
import { MatchContextRepository } from './context-repository.js';
import { GameRegistryRepository } from './game-context-repository.js';
import { assessContextReadiness } from './readiness.js';
import { readAccountEvidence } from './identity-repository.js';
import { resolveIdentity, IDENTITY_POLICY_VERSION } from './identity.js';
import { canonicalContextJson } from './temporal.js';
import { assignDatasetSplits, type SplitMember } from './dataset-splits.js';

export const DATASET_PREPARATION_POLICY='strict-context-preparation-v1';
const hash=(value:unknown)=>createHash('sha256').update(canonicalContextJson(value)).digest('hex');
const synthetic=(value:unknown)=>/synthetic|fixture|demo/i.test(canonicalContextJson(value));
type MapAssessment={matchId:string;reasons:string[];split:string|null;patchId:string|null};
type Participant={player_slot:number;source_account_id:string|null;hero_id:number|null};

/** Offline preparation only. It neither collects predictions nor computes predictive features.
 * syntheticOnly is for isolated fixture databases; the production CLI never exposes it. */
export class DatasetBuilder {
  constructor(private readonly db:Db, private readonly options:{syntheticOnly?:boolean}={}) {}

  async prepare(input:DatasetBuildRequest, codeRevision:string, persist=false) {
    const request=DatasetBuildRequestSchema.parse(input);
    if (!codeRevision.trim() || codeRevision.length>512) throw new Error('invalid_code_revision');
    for(let attempt=0;;attempt++) {
      try { return await this.prepareTransaction(request,codeRevision,persist); }
      catch(error) {
        const code=typeof error==='object' && error!==null && 'code' in error?error.code:null;
        const constraint=typeof error==='object' && error!==null && 'constraint' in error?error.constraint:null;
        if(attempt<2 && (code==='40001' || code==='23505' && constraint==='uq_frozen_training_dataset_fingerprint')) continue;
        throw error;
      }
    }
  }
  private async prepareTransaction(request:DatasetBuildRequest,codeRevision:string,persist:boolean) {
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
      const clock=(await sql<{valid:boolean}>`SELECT ${request.snapshotAt}::timestamptz<=clock_timestamp() AS valid`.execute(trx)).rows[0]!;
      if (!clock.valid) return {status:'unavailable' as const,reason:'SNAPSHOT_IN_FUTURE',datasetId:null};
      const candidates=(await sql<{matchId:string;seriesId:string|null;startedAt:string}>`
        SELECT id::text AS "matchId",series_id AS "seriesId",
          to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt"
        FROM matches WHERE started_at>=${request.fromAt} AND started_at<${request.toAt}
        ORDER BY started_at,id LIMIT ${request.maxMaps+1}`.execute(trx)).rows;
      if(candidates.length>request.maxMaps) return {status:'unavailable' as const,reason:'CANDIDATE_LIMIT_EXCEEDED',datasetId:null};
      const seriesIds=[...new Set(candidates.flatMap(row=>row.seriesId??[]))];
      const siblings=(await sql<SplitMember>`SELECT id::text AS "matchId",series_id AS "seriesId",
          to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt"
        FROM matches WHERE series_id=ANY(${seriesIds}::uuid[]) ORDER BY started_at,id LIMIT ${request.maxMaps+1}`.execute(trx)).rows;
      if(siblings.length>request.maxMaps) return {status:'unavailable' as const,reason:'SERIES_INVENTORY_LIMIT_EXCEEDED',datasetId:null};
      const members=new Map([...candidates,...siblings].map(row=>[row.matchId,row]));
      const assignments=new Map(assignDatasetSplits([...members.values()],request).map(row=>[row.matchId,row]));
      const registry=await new GameRegistryRepository(trx).snapshot();
      const identityRevision=(await sql<{revision:string}>`SELECT revision FROM identity_registry_state WHERE singleton`.execute(trx)).rows[0]!.revision;
      const requiredFacts:ReadinessField[]=['lineup','teams','patch',...(request.stage==='post_draft'?['heroes' as const]:[])];
      const assessments:MapAssessment[]=[];
      const prepared=[];
      for(const map of candidates) {
        const assignment=assignments.get(map.matchId)!;
        const reasons:string[]=assignment.reason?[assignment.reason]:[];
        const result=await new OutcomeVerifier(trx).verifyProMap({matchId:map.matchId,snapshotAt:request.snapshotAt,teamASide:request.teamASide});
        if(result.status!=='verified') { assessments.push({matchId:map.matchId,reasons:[...reasons,...result.reasons],split:null,patchId:null}); continue; }
        const base=await new MatchContextRepository(trx).readObservations({matchId:map.matchId,cutoffAt:result.startedAt,stage:request.stage});
        if(base.context===null) { assessments.push({matchId:map.matchId,reasons:[...reasons,base.reason],split:null,patchId:null}); continue; }
        const claimed=base.context.observations.flatMap(row=>row.fact.field==='lineup'?(row.fact.value??[]).flatMap(p=>p.playerId??[]):[]);
        const existing=(await sql<{id:string}>`SELECT id FROM players WHERE id=ANY(${claimed}::bigint[])`.execute(trx)).rows.map(r=>r.id);
        const readiness=assessContextReadiness(base.context.observations,registry,existing,result.startedAt,result.completedAt,{
          matchId:map.matchId,stage:request.stage,cutoffAt:result.startedAt,snapshotAt:request.snapshotAt,
          cohort:'strict_verified_asof',requiredFacts,assumedFacts:[] });
        reasons.push(...readiness.blockers,...readiness.missingFacts.map(f=>'CONTEXT_'+f.toUpperCase()+'_UNAVAILABLE'));
        const lineup=readiness.fields.find(f=>f.fact?.field==='lineup')?.fact;
        const teams=readiness.fields.find(f=>f.fact?.field==='teams')?.fact;
        const heroes=readiness.fields.find(f=>f.fact?.field==='heroes')?.fact;
        const patch=readiness.fields.find(f=>f.fact?.field==='patch')?.fact;
        const patchId=patch?.field==='patch'?patch.value:null;
        const radiant=request.teamASide==='radiant'?result.teamAId:result.teamBId;
        const dire=request.teamASide==='dire'?result.teamAId:result.teamBId;
        if(teams?.field==='teams' && (teams.value?.radiantTeamId!==radiant || teams.value?.direTeamId!==dire)) reasons.push('CONTEXT_TEAM_SIDE_MISMATCH');
        const participants=(await sql<Participant>`SELECT player_slot,source_account_id,hero_id FROM match_players
          WHERE match_id=${map.matchId} ORDER BY player_slot`.execute(trx)).rows;
        const accounts=participants.flatMap(p=>p.source_account_id??[]);
        const identities=(await readAccountEvidence(trx,accounts)).filter(e=>e.fetchedAt<=request.snapshotAt);
        const identityProofIds=new Set<string>();
        if(participants.length!==10 || lineup?.field!=='lineup' || lineup.value?.length!==10) reasons.push('ACTUAL_LINEUP_INCOMPLETE');
        else for(const member of lineup.value) {
          const actual=participants.find(p=>p.player_slot===member.playerSlot);
          const identity=actual?.source_account_id?resolveIdentity(identities,actual.source_account_id,result.startedAt):null;
          if(!identity || identity.status!=='verified' || identity.playerId!==member.playerId) reasons.push('IDENTITY_OR_LINEUP_MISMATCH');
          for(const id of identity?.observationIds??[]) identityProofIds.add(id);
        }
        if(request.stage==='post_draft' && (heroes?.field!=='heroes' || heroes.value?.length!==10 ||
          heroes.value.some(hero=>participants.find(p=>p.player_slot===hero.playerSlot)?.hero_id!==hero.heroId))) reasons.push('OBSERVED_HERO_MISMATCH');
        const seriesProof=await this.seriesProof(trx,map.matchId,result.outcomeReceiptId);
        if(seriesProof===null) reasons.push('SERIES_MEMBERSHIP_UNVERIFIED');
        const quality=await this.qualityProvenance(trx,map.matchId,result.outcomeReceiptId);
        if(quality.length===0) reasons.push('QUALITY_ASSESSMENT_MISSING');
        const fields=readiness.fields.filter(f=>f.status==='available' && ['lineup','teams','patch','roles',...(request.stage==='post_draft'?['heroes']:[])].includes(f.field));
        const proofIds=new Set(fields.flatMap(f=>f.evidence.filter(e=>e.eligible).map(e=>e.id)));
        // Only selected, stage-legal facts enter inputs; rejected/late observations are not features.
        const contextProofs=base.context.observations.filter(o=>proofIds.has(o.id));
        const patchProofs=registry.patches.filter(p=>proofIds.has('patch:'+p.id));
        const identityProofs=identities.filter(e=>identityProofIds.has(e.observationId))
          .sort((a,b)=>a.observationId<b.observationId?-1:a.observationId>b.observationId?1:0);
        const inputSnapshot={schemaVersion:'prepared-context-v1',stage:request.stage,matchId:map.matchId,
          cutoffAt:result.startedAt,teamAId:result.teamAId,teamBId:result.teamBId,teamASide:request.teamASide,
          facts:fields.map(f=>f.fact),contextProofs,patchProofs,identityProofs,
          contextPolicyKey:readiness.policyKey,identityPolicyVersion:IDENTITY_POLICY_VERSION};
        if(!this.options.syntheticOnly && synthetic([inputSnapshot,result.sourceEvidence,seriesProof])) reasons.push('SYNTHETIC_EVIDENCE_FORBIDDEN');
        const uniqueReasons=[...new Set(reasons)].sort();
        assessments.push({matchId:map.matchId,reasons:uniqueReasons,split:uniqueReasons.length?null:assignment.split,patchId});
        if(uniqueReasons.length || assignment.split===null) continue;
        prepared.push({outcome:result,split:assignment.split,inputSnapshot,inputSnapshotHash:hash(inputSnapshot),seriesProof,
          // Retrospective source cross-check is selection provenance, never pre-match draft input.
          actualParticipants:participants,quality,qualityFingerprint:hash(quality)});
      }
      const byReason:Record<string,number>={}, bySplit:Record<string,number>={}, byPatch:Record<string,number>={};
      for(const row of assessments) for(const reason of row.reasons) byReason[reason]=(byReason[reason]??0)+1;
      for(const row of assessments.filter(r=>r.reasons.length===0)) {
        bySplit[row.split!]=(bySplit[row.split!]??0)+1; byPatch[row.patchId!]=(byPatch[row.patchId!]??0)+1;
      }
      const summary={policyVersion:DATASET_PREPARATION_POLICY,stage:request.stage,candidates:candidates.length,
        eligible:prepared.length,excluded:candidates.length-prepared.length,byReason,bySplit,byPatch,assessments,
        trainingReady:false,deployable:false,syntheticOnly:this.options.syntheticOnly??false};
      if(!prepared.length) return {status:'unavailable' as const,reason:'NO_ELIGIBLE_MAPS',datasetId:null,summary};
      if(!persist) return {status:'prepared' as const,datasetId:null,summary};
      const sourceManifest={policyVersion:DATASET_PREPARATION_POLICY,request,summary,
        cohort:'strict_verified_asof',requiredFacts,assumedFacts:[],identityRevision,registryRevision:registry.revision,
        trainingReady:false,deployable:false,syntheticOnly:this.options.syntheticOnly??false,
        featureState:'not_built',historyState:'not_built',modelGates:['S1_07_EMPIRICAL_GATE_OPEN','CORPUS_GATE_OPEN','S3_FEATURE_MODEL_GATES_OPEN'],
        seriesInventory:[...members.values()],
        inputs:prepared.map(p=>({matchId:p.outcome.matchId,inputSnapshot:p.inputSnapshot,inputSnapshotHash:p.inputSnapshotHash,
          seriesProof:p.seriesProof,sourceEvidence:p.outcome.sourceEvidence,dataRevision:p.outcome.dataRevision,
          actualParticipants:p.actualParticipants,quality:p.quality,qualityFingerprint:p.qualityFingerprint}))};
      const manifest=DatasetManifestSchema.parse({stage:request.stage,featureSchemaVersion:'prepared-context-v1',
        labelPolicyVersion:'verified-map-v1',cutoffPolicyVersion:DATASET_PREPARATION_POLICY,
        patchRegistryRevision:registry.revision,dataRevision:hash(sourceManifest),codeRevision,
        splitPolicy:{version:'explicit-windows-whole-series-v1',fromAt:request.fromAt,trainUntil:request.trainUntil,
          calibrationUntil:request.calibrationUntil,validationUntil:request.validationUntil,toAt:request.toAt,
          unknownSeries:'exclude',boundarySeries:'exclude',membership:'all_locally_known_maps'},sourceManifest});
      await sql`SAVEPOINT dataset_write`.execute(trx);
      const repository=new DatasetRepository(trx), datasetId=await repository.create(manifest);
      for(const row of prepared) await repository.append({datasetId,matchId:row.outcome.matchId,
        outcomeReceiptId:row.outcome.outcomeReceiptId,teamAId:row.outcome.teamAId,teamBId:row.outcome.teamBId,
        cutoffAt:row.outcome.startedAt,split:row.split,features:{},labelVerifiedAt:row.outcome.labelVerifiedAt});
      const digest=(await sql<{fingerprint:string}>`SELECT training_json_hash(training_dataset_content(${datasetId})) AS fingerprint`.execute(trx)).rows[0]!.fingerprint;
      const existing=(await sql<{id:string}>`SELECT id FROM training_dataset_versions WHERE stage=${request.stage}
        AND status='frozen' AND dataset_fingerprint=${digest}`.execute(trx)).rows[0];
      if(existing) {
        await sql`ROLLBACK TO SAVEPOINT dataset_write`.execute(trx);
        return {status:'frozen' as const,datasetId:existing.id,fingerprint:digest,duplicate:true,summary};
      }
      await sql`RELEASE SAVEPOINT dataset_write`.execute(trx);
      const frozen=await repository.freeze(datasetId);
      return {status:'frozen' as const,datasetId,fingerprint:frozen.fingerprint,duplicate:false,summary};
    });
  }
  private async seriesProof(db:Executor,matchId:string,receiptId:string) {
    const {rows}=await sql<{id:string;provider:string;providerSeriesId:string;teamAId:string;teamBId:string}>`
      SELECT s.id,s.provider,s.provider_series_id AS "providerSeriesId",s.team_a_id::text AS "teamAId",s.team_b_id::text AS "teamBId"
      FROM matches m JOIN series s ON s.id=m.series_id JOIN provider_ingest_receipts r ON r.id=${receiptId}
      WHERE m.id=${matchId} AND s.provider='opendota' AND s.provider_series_id ~ '^[1-9][0-9]*$'
        AND r.source_payload->>'series_id'=s.provider_series_id
        AND ((s.team_a_id=m.radiant_team_id AND s.team_b_id=m.dire_team_id) OR
          (s.team_a_id=m.dire_team_id AND s.team_b_id=m.radiant_team_id))`.execute(db);
    return rows[0]??null;
  }
  private async qualityProvenance(db:Executor,matchId:string,receiptId:string) {
    // Assessed-at is the normalizer execution time, not historical fact availability.
    return (await sql<{id:string;validatorVersion:string;assessedAt:string;sourceSnapshotId:string|null;
      draftObservationId:string|null;outcomeStatus:string;playerStatus:string;finalHeroesStatus:string;
      organizationStatus:string;seriesStatus:string;draftTimelineStatus:string;draftOrderValid:boolean|null}>`
      SELECT id::text AS id,validator_version AS "validatorVersion",
        to_char(assessed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "assessedAt",
        source_snapshot_id::text AS "sourceSnapshotId",draft_observation_id::text AS "draftObservationId",
        outcome_status AS "outcomeStatus",player_status AS "playerStatus",final_heroes_status AS "finalHeroesStatus",
        organization_status AS "organizationStatus",series_status AS "seriesStatus",
        draft_timeline_status AS "draftTimelineStatus",draft_order_valid AS "draftOrderValid"
      FROM match_quality_assessments WHERE match_id=${matchId} AND metrics->>'receipt_id'=${receiptId}
      ORDER BY id`.execute(db)).rows;
  }
  async exportFrozen(datasetId:string) {
    const id=DatasetIdSchema.parse(datasetId);
    const {rows}=await sql<{fingerprint:string;content:string}>`SELECT dataset_fingerprint AS fingerprint,
      training_dataset_content(id)::text AS content FROM training_dataset_versions WHERE id=${id} AND status='frozen'`.execute(this.db);
    if(!rows[0]) throw new Error('frozen_dataset_not_found');
    const result=rows[0];
    if(createHash('sha256').update(result.content,'utf8').digest('hex')!==result.fingerprint) throw new Error('dataset_fingerprint_mismatch');
    return result;
  }
}
