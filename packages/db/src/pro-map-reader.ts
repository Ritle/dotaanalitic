import {sql,type RawBuilder} from 'kysely';
import {ContextObservationSchema,type ContextFact,type StoredContextObservation} from '@dota/contracts';
import type {Db} from './index.js';
import {GameRegistryRepository} from './game-context-repository.js';
import {readAccountEvidence} from './identity-repository.js';
import {type ProMapCandidate} from './pro-maps.js';

type MapRow={id:string;started_at:Date;is_pro:boolean|null;ingest_state:string;completed:boolean;radiant_win:boolean|null;duration_seconds:number|null;
  radiant_team_id:string|null;dire_team_id:string|null;league_id:string|null;series_id:string|null;source:string;synced_at:Date;source_fetched_at:Date|null;data_revision:string};

export async function readProMapInventory(trx:Db,target:RawBuilder<unknown>,fromAt:string|undefined,cutoffAt:string,snapshotAt:string){
  const rows=(await sql<MapRow>`SELECT m.*, (m.duration_seconds>0 AND m.radiant_win IS NOT NULL AND
    m.started_at+make_interval(secs=>m.duration_seconds)<=${cutoffAt}::timestamptz) IS TRUE AS completed,
    (SELECT max(fetched_at) FROM provider_ingest_receipts r WHERE r.canonical_match_id=m.id AND r.status IN ('accepted','partial')
      AND r.fetched_at<=${snapshotAt}::timestamptz) AS source_fetched_at
    FROM matches m WHERE ${target} AND m.started_at<${cutoffAt}::timestamptz
    AND (${fromAt??null}::timestamptz IS NULL OR m.started_at>=${fromAt??null}::timestamptz)
    ORDER BY m.started_at DESC,m.id DESC LIMIT 5001`.execute(trx)).rows;
  if(rows.length>5000)return null;
  const ids=rows.map(m=>m.id);
  const players=(await sql<{match_id:string;player_slot:number;source_account_id:string|null}>`SELECT match_id,player_slot,source_account_id
    FROM match_players WHERE match_id=ANY(${ids}::bigint[]) ORDER BY match_id,player_slot`.execute(trx)).rows;
  const facts=(await sql<{id:string;match_id:string;field:string;value:ContextFact['value'];event_at:Date|null;known_at:Date|null;fetched_at:Date;
    provider:string;provider_record_id:string|null;evidence_ref:string|null;adapter_version:string;review_state:string;availability_class:string;earliest_stage:string}>`
    SELECT id,match_id,substring(field_name from 9) AS field,value,event_at,known_at,fetched_at,provider,provider_record_id,evidence_ref,
      adapter_version,review_state,availability_class,earliest_stage FROM match_field_observations
    WHERE match_id=ANY(${ids}::bigint[]) AND field_name IN ('context.roles','context.series_id') AND context_sha256 IS NOT NULL ORDER BY id`.execute(trx)).rows;
  const byMap=new Map<string,StoredContextObservation[]>();
  for(const row of facts){const group=byMap.get(row.match_id)??[];group.push({id:row.id,...ContextObservationSchema.parse({matchId:row.match_id,
    fact:{field:row.field,value:row.value},eventAt:row.event_at?.toISOString()??null,knownAt:row.known_at?.toISOString()??null,
    fetchedAt:row.fetched_at.toISOString(),provider:row.provider,providerRecordId:row.provider_record_id,evidenceRef:row.evidence_ref,
    adapterVersion:row.adapter_version,reviewState:row.review_state,availability:row.availability_class,earliestStage:row.earliest_stage})});byMap.set(row.match_id,group);}
  const playersByMap=new Map<string,ProMapCandidate['players']>();
  for(const p of players){const group=playersByMap.get(p.match_id)??[];group.push({playerSlot:p.player_slot,sourceAccountId:p.source_account_id});playersByMap.set(p.match_id,group);}
  const evidence=await readAccountEvidence(trx,[...new Set(players.flatMap(p=>p.source_account_id??[]))]);
  const registry=await new GameRegistryRepository(trx).snapshot();
  const revision=(await sql<{revision:string}>`SELECT revision FROM identity_registry_state WHERE singleton`.execute(trx)).rows[0]!.revision;

  return {candidates:rows.map(m=>({matchId:m.id,startedAt:m.started_at.toISOString(),isPro:m.is_pro,
    conflict:m.ingest_state==='conflict',completed:m.completed,radiantWin:m.radiant_win,durationSeconds:m.duration_seconds,
    radiantTeamId:m.radiant_team_id,direTeamId:m.dire_team_id,leagueId:m.league_id,seriesId:m.series_id,source:m.source,
    syncedAt:m.synced_at.toISOString(),sourceFetchedAt:m.source_fetched_at?.toISOString()??null,dataRevision:m.data_revision,
    players:playersByMap.get(m.id)??[],observations:byMap.get(m.id)??[]})),registry,evidence,identityRevision:revision};
}
