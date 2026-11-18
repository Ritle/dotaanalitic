import {DraftCaptureHistorySchema,type DraftCaptureHistory,type DraftCaptureIdentity} from './draft-capture-contract.js';
import {sql,type Executor} from '@dota/db';
import {readAccountEvidence} from '@dota/db';
import {registryHash} from '@dota/db';

/** Availability here is current server observation, not a backdated historical identity claim. */
export async function captureIdentities(tx:Executor,accounts:string[],cutoff:string):Promise<DraftCaptureIdentity[]>{
  const allowed=(await sql<{id:string}>`
    SELECT 'proof:'||id::text AS id FROM player_account_evidence
      WHERE external_account_id=ANY(${accounts}::text[]) AND fetched_at<${cutoff}::timestamptz
    UNION ALL SELECT 'legacy:'||id::text AS id FROM player_external_accounts
      WHERE external_account_id=ANY(${accounts}::text[]) AND observed_at<${cutoff}::timestamptz
      AND (link_status<>'verified' OR verified_at<${cutoff}::timestamptz)`.execute(tx)).rows;
  const ids=new Set(allowed.map(r=>r.id));
  return (await readAccountEvidence(tx,accounts)).filter(r=>ids.has(r.observationId))
    .sort((a,b)=>a.observationId.localeCompare(b.observationId));
}

export function emptyCaptureHistory():DraftCaptureHistory{
  const body={scope:'all_local_pro_before_decision_remote_completeness_unknown' as const,
    maps:[],players:[],receipts:[],facts:[],identities:[],series:[]};
  return {...body,status:'unavailable',sha256:registryHash(body)};
}

/** Frozen evidence projection in the caller's repeatable-read snapshot. No network or feature computation. */
export async function captureHistory(tx:Executor,cutoff:string):Promise<DraftCaptureHistory>{
  const maps=(await sql<{id:string;[key:string]:unknown}>`SELECT id::text,series_id::text,
    (extract(epoch from started_at)*1000000)::bigint::text AS started_at_us,
    (extract(epoch from synced_at)*1000000)::bigint::text AS synced_at_us,
    duration_seconds,radiant_win,is_pro,ingest_state,data_revision::text,patch_id::text,
    radiant_team_id::text,dire_team_id::text
    FROM matches WHERE is_pro IS TRUE AND started_at<${cutoff}::timestamptz
      AND synced_at<${cutoff}::timestamptz ORDER BY started_at,id LIMIT 5001`.execute(tx)).rows;
  if(maps.length>5000)throw Error('DRAFT_CAPTURE_HISTORY_LIMIT');
  const ids=maps.map(m=>m.id);
  const players=(await sql<{source_account_id:string|null;[key:string]:unknown}>`SELECT match_id::text,player_slot,side,
    player_id::text,source_account_id::text,hero_id FROM match_players WHERE match_id=ANY(${ids}::bigint[])
    ORDER BY match_id,player_slot LIMIT 50001`.execute(tx)).rows;
  const receipts=(await sql<Record<string,unknown>>`SELECT id::text,canonical_match_id::text,provider,provider_match_id,
    adapter_version,normalizer_version,payload_sha256,context_sha256,status,reasons,
    (extract(epoch from event_at)*1000000)::bigint::text AS event_at_us,
    (extract(epoch from known_at)*1000000)::bigint::text AS known_at_us,
    (extract(epoch from fetched_at)*1000000)::bigint::text AS fetched_at_us,source_payload
    FROM provider_ingest_receipts WHERE canonical_match_id=ANY(${ids}::bigint[]) AND fetched_at<${cutoff}::timestamptz
    ORDER BY id LIMIT 10001`.execute(tx)).rows;
  const facts=(await sql<Record<string,unknown>>`SELECT id::text,match_id::text,receipt_id::text,field_name,value,value_sha256,
    provider,adapter_version,evidence_ref,review_state,availability_class,earliest_stage,
    (extract(epoch from event_at)*1000000)::bigint::text AS event_at_us,
    (extract(epoch from known_at)*1000000)::bigint::text AS known_at_us,
    (extract(epoch from fetched_at)*1000000)::bigint::text AS fetched_at_us,
    (extract(epoch from recorded_at)*1000000)::bigint::text AS recorded_at_us
    FROM match_field_observations WHERE match_id=ANY(${ids}::bigint[])
      AND fetched_at<${cutoff}::timestamptz AND recorded_at<${cutoff}::timestamptz
    ORDER BY id LIMIT 200001`.execute(tx)).rows;
  const seriesIds=[...new Set(maps.flatMap(m=>typeof m.series_id==='string'?[m.series_id]:[]))];
  const series=(await sql<Record<string,unknown>>`SELECT id::text,provider,provider_series_id,team_a_id::text,team_b_id::text
    FROM series WHERE id=ANY(${seriesIds}::uuid[]) ORDER BY id`.execute(tx)).rows;
  if(players.length>50000||receipts.length>10000||facts.length>200000)throw Error('DRAFT_CAPTURE_HISTORY_LIMIT');
  const identities=await captureIdentities(tx,[...new Set(players.flatMap(p=>p.source_account_id?[p.source_account_id]:[]))],cutoff);
  if(identities.length>50000)throw Error('DRAFT_CAPTURE_HISTORY_LIMIT');
  const body={scope:'all_local_pro_before_decision_remote_completeness_unknown' as const,maps,players,receipts,facts,identities,series};
  if(Buffer.byteLength(JSON.stringify(body))>30*1024*1024)throw Error('DRAFT_CAPTURE_HISTORY_LIMIT');
  return DraftCaptureHistorySchema.parse({...body,status:maps.length&&receipts.length?'captured':'unavailable',sha256:registryHash(body)});
}
