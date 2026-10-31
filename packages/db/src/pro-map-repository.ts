import {sql} from 'kysely';
import {CatalogIdSchema,ContextObservationSchema,ProMapQuerySchema,type ProMapQuery,type ContextFact,type StoredContextObservation} from '@dota/contracts';
import type {Db} from './index.js';
import {GameRegistryRepository} from './game-context-repository.js';
import {readAccountEvidence} from './identity-repository.js';
import {selectProMaps,type ProMapCandidate} from './pro-maps.js';

type MapRow={id:string;started_at:Date;is_pro:boolean|null;ingest_state:string;completed:boolean;radiant_win:boolean|null;duration_seconds:number|null;
  radiant_team_id:string|null;dire_team_id:string|null;league_id:string|null;series_id:string|null;source:string;synced_at:Date;source_fetched_at:Date|null;data_revision:string};
export class ProMapQueryError extends Error {}
export class ProMapRepository {
  constructor(private readonly db:Db){}
  async report(kind:'teams'|'players',id:string,input:ProMapQuery) {
    CatalogIdSchema.parse(id);
    const parsed=ProMapQuerySchema.parse(input),snapshotAt=new Date().toISOString();
    const query={...parsed,cutoffAt:parsed.cutoffAt??snapshotAt};
    if(query.cutoffAt>snapshotAt || query.fromAt && query.fromAt>=query.cutoffAt || kind==='players' && query.playerId ||
      kind==='teams' && query.rolePos && !query.playerId || kind==='teams' && query.opponentId===id)
      throw new ProMapQueryError('invalid_pro_map_query');
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
      const table=kind==='teams'?'teams':'players';
      if(!(await sql`SELECT id FROM ${sql.table(table)} WHERE id=${id}`.execute(trx)).rows.length)return null;
      const target=kind==='teams'?sql`(m.radiant_team_id=${id} OR m.dire_team_id=${id})`:sql`EXISTS (
        SELECT 1 FROM match_players p WHERE p.match_id=m.id AND (p.player_id=${id} OR p.source_account_id::text IN (
          SELECT external_account_id FROM player_account_evidence WHERE player_id=${id}
          UNION SELECT external_account_id FROM player_external_accounts WHERE player_id=${id}
          UNION SELECT opendota_account_id::text FROM players WHERE id=${id})))`;
      const rows=(await sql<MapRow>`SELECT m.*, (m.duration_seconds>0 AND m.radiant_win IS NOT NULL AND
        m.started_at+make_interval(secs=>m.duration_seconds)<=${query.cutoffAt}::timestamptz) IS TRUE AS completed,
        (SELECT max(fetched_at) FROM provider_ingest_receipts r WHERE r.canonical_match_id=m.id AND r.status IN ('accepted','partial')
          AND r.fetched_at<=${snapshotAt}::timestamptz) AS source_fetched_at
        FROM matches m WHERE ${target} AND m.started_at<${query.cutoffAt}::timestamptz
        AND (${query.fromAt??null}::timestamptz IS NULL OR m.started_at>=${query.fromAt??null}::timestamptz)
        ORDER BY m.started_at DESC,m.id DESC LIMIT 5001`.execute(trx)).rows;
      if(rows.length>5000)return {status:'unavailable' as const,reason:'WINDOW_TOO_LARGE' as const,maxCandidates:5000 as const,
        message:'В окне больше 5000 карт. Уточните начальную дату.'};
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
      const unattributed=(await sql<{n:string}>`SELECT count(*)::text AS n FROM matches WHERE is_pro IS TRUE AND started_at<${query.cutoffAt}::timestamptz
        AND (${query.fromAt??null}::timestamptz IS NULL OR started_at>=${query.fromAt??null}::timestamptz)
        AND (radiant_team_id IS NULL OR dire_team_id IS NULL)`.execute(trx)).rows[0]!.n;
      return selectProMaps(kind,id,query,snapshotAt,rows.map(m=>({matchId:m.id,startedAt:m.started_at.toISOString(),isPro:m.is_pro,
        conflict:m.ingest_state==='conflict',completed:m.completed,radiantWin:m.radiant_win,durationSeconds:m.duration_seconds,
        radiantTeamId:m.radiant_team_id,direTeamId:m.dire_team_id,leagueId:m.league_id,seriesId:m.series_id,source:m.source,
        syncedAt:m.synced_at.toISOString(),sourceFetchedAt:m.source_fetched_at?.toISOString()??null,dataRevision:m.data_revision,
        players:playersByMap.get(m.id)??[],observations:byMap.get(m.id)??[]})),registry,evidence,revision,Number(unattributed));
    });
  }
}
