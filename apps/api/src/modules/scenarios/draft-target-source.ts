import {sql,type Db,OutcomeVerifier} from '@dota/db';
import {DraftCaptureRepository} from './draft-capture-repository.js';
import {DraftTargetAuditInputSchema,DraftTargetCandidateSchema} from './draft-target-resolution.js';

/** Local inspection only. OutcomeVerifier takes share locks; no DML/provider calls. */
export async function readDraftTargetSources(db:Db){
  return db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
    await sql`SET LOCAL statement_timeout='30s'`.execute(tx);
    await sql`SET LOCAL lock_timeout='5s'`.execute(tx);
    const inspectedAt=(await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`.execute(tx)).rows[0]!.at;
    const rows=(await sql<{owner:string;scenario:string;revision:number}>`SELECT owner_user_id::text AS owner,scenario_id::text AS scenario,revision
      FROM owner_draft_captures ORDER BY id LIMIT 101`.execute(tx)).rows;
    if(rows.length>100)throw Error('draft_target_capture_limit');
    const items=[];let bytes=0;
    const accountSize=(value:unknown)=>{bytes+=Buffer.byteLength(JSON.stringify(value));if(bytes>60*1024*1024)throw Error('draft_target_size_limit');};
    for(const row of rows){
      const capture=await new DraftCaptureRepository(db).get(row.owner,row.scenario,row.revision,tx);
      if(!capture)throw Error('capture_disappeared');
      accountSize(capture);
      const s=capture.snapshot.scenario;
      // All locally known maps of this exact organization pair, not a guessed
      // time window or nth imported map. Exceeding the cap refuses the audit.
      const maps=(await sql<{matchId:string;[key:string]:unknown}>`SELECT m.id::text AS "matchId",m.data_revision::text AS "dataRevision",
        m.is_pro AS "isPro",m.ingest_state AS "ingestState",(extract(epoch FROM m.started_at)*1000000)::bigint::text AS "startedAtUs",
        m.radiant_team_id::text AS "radiantTeamId",m.dire_team_id::text AS "direTeamId",m.map_number AS "mapNumber",
        CASE WHEN se.id IS NULL THEN NULL ELSE jsonb_build_object('provider',se.provider,'providerSeriesId',se.provider_series_id) END AS series
        FROM matches m LEFT JOIN series se ON se.id=m.series_id
        WHERE (m.radiant_team_id=${s.teamAId}::bigint AND m.dire_team_id=${s.teamBId}::bigint)
          OR (m.radiant_team_id=${s.teamBId}::bigint AND m.dire_team_id=${s.teamAId}::bigint)
        ORDER BY m.id LIMIT 201`.execute(tx)).rows;
      if(maps.length>200)throw Error('draft_target_candidate_limit');
      const candidates=[];
      for(const map of maps){
        const players=(await sql`SELECT player_slot AS slot,source_account_id::text AS "accountId",hero_id AS "heroId"
          FROM match_players WHERE match_id=${map.matchId}::bigint ORDER BY player_slot`.execute(tx)).rows;
        const ordinals=(await sql`SELECT id::text,value,value_sha256 AS "valueSha256",review_state AS "reviewState",evidence_ref AS "evidenceRef",
          (extract(epoch FROM fetched_at)*1000000)::bigint::text AS "fetchedAtUs",
          (extract(epoch FROM recorded_at)*1000000)::bigint::text AS "recordedAtUs"
          FROM match_field_observations WHERE match_id=${map.matchId}::bigint AND field_name='context.map_number'
          AND recorded_at<=${inspectedAt}::timestamptz AND fetched_at<=${inspectedAt}::timestamptz ORDER BY id LIMIT 101`.execute(tx)).rows;
        if(ordinals.length>100)throw Error('draft_target_evidence_limit');
        const outcome=await new OutcomeVerifier(tx).verifyProMap({matchId:map.matchId,snapshotAt:inspectedAt.slice(0,-4)+'Z',teamASide:'radiant'});
        const receipt=outcome.status==='verified'?(await sql`SELECT id::text,provider,provider_match_id AS "providerMatchId",payload_sha256 AS "payloadSha256",
          (extract(epoch FROM fetched_at)*1000000)::bigint::text AS "fetchedAtUs",source_payload AS projection
          FROM provider_ingest_receipts WHERE id=${outcome.outcomeReceiptId}::bigint`.execute(tx)).rows[0]??null:null;
        const candidate=DraftTargetCandidateSchema.parse({...map,players,ordinals,receipt,
          outcome:{verified:outcome.status==='verified',receiptId:outcome.status==='verified'?outcome.outcomeReceiptId:null}});
        accountSize(candidate);candidates.push(candidate);
      }
      items.push({capture,candidates});
    }
    return DraftTargetAuditInputSchema.parse({format:'draft-target-audit-input-v1',inspectedAt,syntheticOnly:false,items});
  });
}
