import {z} from 'zod';
import {sql,type Db,type Executor,ScenarioError,OutcomeVerifier,registrySha} from '@dota/db';
import {DraftCaptureRepository} from './draft-capture-repository.js';
import {DraftTargetCandidateSchema} from './draft-target-resolution.js';
import {DraftNativeRequestSchema,DraftNativeResultSchema,DraftNativeSavedSchema,DraftNativeStateSchema} from './draft-native-contract.js';
import {verifyNativeDraft} from './draft-native-verify.js';
const Evidence=z.object({format:z.literal('owner-draft-native-evidence-v1'),candidate:DraftTargetCandidateSchema.nullable(),result:DraftNativeResultSchema}).strict();
type Row={id:string;evidence_text:string;evidence_sha256:string;recorded_at:string};
const columns=sql`id,evidence_text,evidence_sha256,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at`;
function decode(row:Row){
  if(registrySha(row.evidence_text)!==row.evidence_sha256)throw Error('draft_native_integrity');
  const evidence=Evidence.parse(JSON.parse(row.evidence_text));
  return DraftNativeSavedSchema.parse({id:row.id,recordedAt:row.recorded_at,sha256:row.evidence_sha256,result:evidence.result});
}
async function candidate(tx:Executor,matchId:string,at:string){
  const m=(await sql`SELECT m.id::text AS "matchId",m.data_revision::text AS "dataRevision",m.is_pro AS "isPro",m.ingest_state AS "ingestState",
    (extract(epoch FROM m.started_at)*1000000)::bigint::text AS "startedAtUs",m.radiant_team_id::text AS "radiantTeamId",
    m.dire_team_id::text AS "direTeamId",m.map_number AS "mapNumber",
    CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('provider',s.provider,'providerSeriesId',s.provider_series_id) END AS series
    FROM matches m LEFT JOIN series s ON s.id=m.series_id WHERE m.id=${matchId}::bigint`.execute(tx)).rows[0];
  if(!m)return null;
  const players=(await sql`SELECT player_slot AS slot,source_account_id::text AS "accountId",hero_id AS "heroId"
    FROM match_players WHERE match_id=${matchId}::bigint ORDER BY player_slot LIMIT 101`.execute(tx)).rows;
  const outcome=await new OutcomeVerifier(tx).verifyProMap({matchId,snapshotAt:at.slice(0,-4)+'Z',teamASide:'radiant'});
  const receipt=outcome.status==='verified'?(await sql`SELECT id::text,provider,provider_match_id AS "providerMatchId",payload_sha256 AS "payloadSha256",
    (extract(epoch FROM fetched_at)*1000000)::bigint::text AS "fetchedAtUs",source_payload AS projection
    FROM provider_ingest_receipts WHERE id=${outcome.outcomeReceiptId}::bigint`.execute(tx)).rows[0]??null:null;
  return DraftTargetCandidateSchema.parse({...m,players,ordinals:[],receipt,
    outcome:{verified:outcome.status==='verified',receiptId:outcome.status==='verified'?outcome.outcomeReceiptId:null}});
}
export class DraftNativeRepository{
  constructor(private readonly db:Db){}
  async get(owner:string,scenarioId:string,revision:number){
    // Reading binding status does not deserialize the potentially large frozen history again.
    const capture=(await sql<{id:string}>`SELECT id FROM owner_draft_captures
      WHERE owner_user_id=${owner}::uuid AND scenario_id=${scenarioId}::uuid AND revision=${revision}`.execute(this.db)).rows[0];
    if(!capture)throw new ScenarioError('NOT_FOUND');
    const rows=(await sql<Row>`SELECT ${columns} FROM owner_draft_native_bindings
      WHERE owner_user_id=${owner}::uuid AND capture_id=${capture.id}::uuid
      ORDER BY recorded_at DESC,id DESC LIMIT 1`.execute(this.db)).rows;
    const bound=(await sql<Row>`SELECT ${columns} FROM owner_draft_native_bindings
      WHERE owner_user_id=${owner}::uuid AND capture_id=${capture.id}::uuid AND status='verified'`.execute(this.db)).rows[0];
    return DraftNativeStateSchema.parse({binding:bound?decode(bound):null,latestAttempt:rows[0]?decode(rows[0]):null});
  }
  async create(owner:string,scenarioId:string,revision:number,raw:unknown){
    const request=DraftNativeRequestSchema.parse(raw);
    for(let attempt=0;;attempt++)try{
      return await this.db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
        await sql`SET LOCAL statement_timeout='30s'`.execute(tx);await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
        const locked=(await sql<{id:string}>`SELECT c.id FROM owner_draft_captures c JOIN app_users u ON u.id=c.owner_user_id
          WHERE c.owner_user_id=${owner}::uuid AND c.scenario_id=${scenarioId}::uuid AND c.revision=${revision}
          AND u.is_active AND u.account_role='owner' FOR UPDATE OF c`.execute(tx)).rows[0];
        if(!locked)throw new ScenarioError('NOT_FOUND');
        const prior=(await sql<Row>`SELECT ${columns} FROM owner_draft_native_bindings WHERE id=${request.requestId}::uuid`.execute(tx)).rows[0];
        if(prior){const saved=decode(prior);
          if(saved.result.captureId!==locked.id||saved.result.matchId!==request.matchId)throw new ScenarioError('CONFLICT');return saved;}
        const existing=(await sql<Row>`SELECT ${columns} FROM owner_draft_native_bindings WHERE capture_id=${locked.id}::uuid AND status='verified'`.execute(tx)).rows[0];
        if(existing){const saved=decode(existing);if(saved.result.matchId!==request.matchId)throw new ScenarioError('CONFLICT');return saved;}
        const capture=(await new DraftCaptureRepository(this.db).get(owner,scenarioId,revision,tx))!;
        const at=(await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`.execute(tx)).rows[0]!.at;
        const source=await candidate(tx,request.matchId,at),result=verifyNativeDraft({capture,matchId:request.matchId,inspectedAt:at,candidate:source});
        const text=JSON.stringify(Evidence.parse({format:'owner-draft-native-evidence-v1',candidate:source,result}));
        if(Buffer.byteLength(text)>2*1024*1024)throw new ScenarioError('VALIDATION_ERROR');
        const row=(await sql<Row>`INSERT INTO owner_draft_native_bindings(id,owner_user_id,capture_id,requested_match_id,status,evidence_text,evidence_sha256,inspected_at)
          VALUES(${request.requestId}::uuid,${owner}::uuid,${capture.id}::uuid,${request.matchId}::bigint,${result.status},${text},${registrySha(text)},${at}::timestamptz)
          RETURNING ${columns}`.execute(tx)).rows[0]!;
        return decode(row);
      });
    }catch(e){
      if(e instanceof Error&&'code' in e){if(attempt<2&&(e.code==='40001'||e.code==='23505'))continue;if(e.code==='23505')throw new ScenarioError('CONFLICT');}
      throw e;
    }
  }
}
