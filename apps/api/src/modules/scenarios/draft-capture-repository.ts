import {randomUUID} from 'node:crypto';
import {DraftCaptureRequestSchema,DraftCaptureSavedSchema,DraftCaptureSnapshotSchema,
  type DraftCaptureSnapshot} from './draft-capture-contract.js';
import {ScenarioInputSchema} from '@dota/contracts';
import {sql,type Db,type Executor} from '@dota/db';
import {ScenarioError} from '@dota/db';
import {registrySha} from '@dota/db';
import {V1ScheduleTargetRepository} from '@dota/db';
import {captureIdentities,captureHistory,emptyCaptureHistory} from './draft-capture-source.js';
import {captureDraftPlayers} from './draft-capture-players.js';
import {DraftHistoryRepository} from './draft-history-repository.js';

type Row={id:string;snapshot_text:string;snapshot_sha256:string;recorded_at:string};
const recorded=sql<string>`to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function decode(row:Row){
  if(registrySha(row.snapshot_text)!==row.snapshot_sha256)throw Error('draft_capture_integrity');
  return DraftCaptureSavedSchema.parse({id:row.id,sha256:row.snapshot_sha256,recordedAt:row.recorded_at,snapshot:JSON.parse(row.snapshot_text)});
}
export class DraftCaptureRepository{
  constructor(private readonly db:Db){}
  async get(owner:string,scenarioId:string,revision:number,tx:Executor=this.db){
    const row=(await sql<Row>`SELECT id,snapshot_text,snapshot_sha256,${recorded} AS recorded_at FROM owner_draft_captures
      WHERE owner_user_id=${owner}::uuid AND scenario_id=${scenarioId}::uuid AND revision=${revision}`.execute(tx)).rows[0];
    return row?decode(row):null;
  }
  async create(owner:string,scenarioId:string,raw:unknown){
    const {expectedRevision,scheduleTargetRequestId=null}=DraftCaptureRequestSchema.parse(raw);
    await new DraftHistoryRepository(this.db).prepare(owner,scenarioId,expectedRevision);
    // A waiter can get a repeatable-read serialization failure after another request commits.
    for(let attempt=0;;attempt++)try{return await this.capture(owner,scenarioId,expectedRevision,scheduleTargetRequestId);}
    catch(e){if(attempt<2&&e instanceof Error&&'code' in e&&e.code==='40001')continue;throw e;}
  }
  private async capture(owner:string,scenarioId:string,revision:number,scheduleTargetRequestId:string|null){
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
      await sql`SET LOCAL statement_timeout='30s'`.execute(tx);
      await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
      // Lock the scenario itself, serializing both capture retries and ordinary scenario edits.
      const current=(await sql<{revision:number}>`SELECT s.revision FROM scenarios s JOIN app_users u ON u.id=s.owner_user_id
        WHERE s.id=${scenarioId}::uuid AND s.owner_user_id=${owner}::uuid AND u.is_active AND u.account_role='owner'
        FOR UPDATE OF s`.execute(tx)).rows[0];
      if(!current)throw new ScenarioError('NOT_FOUND');
      const prior=await this.get(owner,scenarioId,revision,tx);if(prior){
        if(scheduleTargetRequestId!==null&&prior.snapshot.scheduleTargetRequestId!==scheduleTargetRequestId)throw new ScenarioError('CONFLICT');
        return prior;
      }
      if(current.revision!==revision)throw new ScenarioError('CONFLICT');
      const row=(await sql<{input_snapshot:unknown;input_hash:string;recorded_at:string}>`SELECT input_snapshot,input_hash,${recorded} AS recorded_at
        FROM scenario_input_snapshots WHERE scenario_id=${scenarioId}::uuid AND revision=${revision}`.execute(tx)).rows[0]!;
      const input=ScenarioInputSchema.parse(row.input_snapshot);
      const cutoff=(await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`.execute(tx)).rows[0]!.at;
      const playerIds=[...input.lineupA,...input.lineupB].map(p=>p.playerId!);
      const accounts=(await sql<{id:string}>`SELECT external_account_id AS id FROM player_account_evidence WHERE player_id=ANY(${playerIds}::bigint[])
        UNION SELECT external_account_id FROM player_external_accounts WHERE player_id=ANY(${playerIds}::bigint[]) AND provider IN ('opendota','stratz')`.execute(tx)).rows.map(r=>r.id);
      const evidence=await captureIdentities(tx,accounts,cutoff),players=captureDraftPlayers(input,evidence),reasons:string[]=[];
      if(players.some(p=>p.heroId===null)||new Set(players.map(p=>p.heroId)).size!==10)reasons.push('TEN_DISTINCT_HEROES_REQUIRED');
      if(players.some(p=>p.accountId===null))reasons.push('PLAYER_ACCOUNT_UNRESOLVED');
      if(new Set(players.flatMap(p=>p.accountId?[p.accountId]:[])).size!==10)reasons.push('TEN_DISTINCT_ACCOUNTS_REQUIRED');
      let target:DraftCaptureSnapshot['target']=null;
      if(input.context.mapNumber&&scheduleTargetRequestId){
        const saved=await new V1ScheduleTargetRepository(this.db).get(owner,scheduleTargetRequestId,tx)
          .catch(e=>{if(e instanceof ScenarioError&&e.code==='NOT_FOUND')return null;throw e;});
        const r=saved?.record;
        if(saved&&r&&input.context.seriesId===null&&r.request.teamAId===input.teamAId&&r.request.teamBId===input.teamBId&&r.selectedAt<cutoff
          &&r.observation.recordedAt<cutoff&&r.observation.fetchedAt.slice(0,-1)+'000Z'<cutoff
          &&(r.observation.match.seriesBestOf===null||input.context.mapNumber<=r.observation.match.seriesBestOf)){
          target={status:'pending',provider:'pandascore',providerSeriesId:r.request.providerMatchId,
            mapNumber:input.context.mapNumber,actualMatchId:null,evidence:saved};
        }else reasons.push('DRAFT_TARGET_MISMATCH');
      }else if(input.context.seriesId&&input.context.mapNumber){
        const series=(await sql<{id:string;provider:string|null;provider_series_id:string|null;team_a_id:string;team_b_id:string}>`
          SELECT id::text,provider,provider_series_id,team_a_id::text,team_b_id::text FROM series WHERE id=${input.context.seriesId}::uuid`.execute(tx)).rows[0];
        if(series?.provider&&series.provider_series_id&&series.provider_series_id!=='0'
          &&new Set([series.team_a_id,series.team_b_id,input.teamAId,input.teamBId]).size===2)
          target={status:'pending',provider:series.provider,providerSeriesId:series.provider_series_id,
            mapNumber:input.context.mapNumber,actualMatchId:null,evidence:series};
      }
      if(!target)reasons.push('DRAFT_MAP_REFERENCE_MISSING');
      const observation=await new DraftHistoryRepository(this.db).get(owner,scenarioId,revision,tx);
      if(!observation||observation.recordedAt>=cutoff||observation.evidence.selection.scenarioHash!==row.input_hash)throw Error('draft_history_not_before_cutoff');
      // Preserve the legacy raw snapshot contract. The compact observation is a separate versioned source.
      let history=emptyCaptureHistory();
      try{history=await captureHistory(tx,cutoff);}catch(e){
        if(!(e instanceof Error)||e.message!=='DRAFT_CAPTURE_HISTORY_LIMIT')throw e;
        reasons.push('DRAFT_CAPTURE_HISTORY_LIMIT');
      }
      if(history.status==='unavailable')reasons.push('LOCAL_HISTORY_UNAVAILABLE');
      const historyAccounts=new Set(history.players.map(p=>p.source_account_id));
      if(players.some(p=>p.accountId!==null&&!historyAccounts.has(p.accountId)))reasons.push('PLAYER_PRO_HISTORY_MISSING');
      const snapshot=DraftCaptureSnapshotSchema.parse({format:'owner-draft-capture-v1',scenarioId,revision,scheduleTargetRequestId,
        scenarioHash:row.input_hash,scenarioRecordedAt:row.recorded_at,scenario:input,decisionCutoffAt:cutoff,
        players,identityEvidence:evidence,target,history,status:reasons.length?'unavailable':'captured',reasons,
        warnings:['OWNER_DRAFT_ASSERTION','ACTUAL_MAP_AND_START_UNVERIFIED','HISTORY_ELIGIBILITY_NOT_ASSESSED',
          'LOCAL_HISTORY_REMOTE_COMPLETENESS_UNKNOWN','IDENTITIES_OBSERVED_AT_CAPTURE_NOT_HISTORICAL_PROOF'],
        primaryEligible:false,scoringPerformed:false,deployable:false});
      const text=JSON.stringify(snapshot),hash=registrySha(text),id=randomUUID();
      const result=(await sql<Row>`INSERT INTO owner_draft_captures(id,owner_user_id,scenario_id,revision,snapshot_text,snapshot_sha256,decision_cutoff_at)
        VALUES(${id}::uuid,${owner}::uuid,${scenarioId}::uuid,${revision},${text},${hash},${cutoff}::timestamptz)
        ON CONFLICT(owner_user_id,scenario_id,revision) DO NOTHING
        RETURNING id,snapshot_text,snapshot_sha256,${recorded} AS recorded_at`.execute(tx)).rows[0];
      if(!result)throw Error('draft_capture_concurrent_retry');
      await sql`INSERT INTO owner_draft_history_links(capture_id,observation_id) VALUES(${id}::uuid,${observation.id}::uuid)`.execute(tx);
      return decode(result);
    });
  }
}
