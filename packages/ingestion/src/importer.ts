import { sql, readAccountEvidence, resolveIdentity, type Db, type Executor } from '@dota/db';
import type { OpenDotaClient } from './opendota/client.js';
import { assess, classifyLeague, completedObservation, hash, matchEventAt, NORMALIZER_VERSION, parseSource, QUALITY_POLICY, sideOf } from './quality.js';

type Provider=Pick<OpenDotaClient,'getMatchSource'|'getHeroes'|'getLeagues'>;
interface Canonical {
  id:string;started_at:Date;radiant_win:boolean|null;radiant_team_id:string|null;dire_team_id:string|null;
  league_id:string|null;series_id:string|null;is_pro:boolean|null;ingest_state:string;data_revision:string;
  duration_seconds:number|null;radiant_score:number|null;dire_score:number|null;
}
interface StoredPlayer {player_slot:number;hero_id:number;source_account_id:string|null;player_id:string|null;
  kills:number|null;deaths:number|null;assists:number|null;gpm:number|null;xpm:number|null}
export interface ImportResult {matchId:string;receiptId:string;status:'accepted'|'partial'|'conflict'|'quarantined';duplicate:boolean;dataRevision:string|null}
const json=(value:unknown)=>sql`${JSON.stringify(value)}::jsonb`;
const bounded=(value:number|null|undefined,max:number)=>value!=null && value<=max?value:null;
async function fingerprint(tx:Executor,matchId:string) {
  const {rows}=await sql<{facts:unknown}>`SELECT jsonb_build_object(
    'map',(to_jsonb(m)||jsonb_build_object('id',m.id::text,'radiant_team_id',m.radiant_team_id::text,
      'dire_team_id',m.dire_team_id::text,'league_id',m.league_id::text,'patch_id',m.patch_id::text))-'data_revision'-'synced_at'-'updated_at'-'created_at',
    'players',coalesce((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('match_id',p.match_id::text,'player_id',p.player_id::text,
      'team_id',p.team_id::text,'source_account_id',p.source_account_id::text) ORDER BY player_slot) FROM match_players p WHERE p.match_id=m.id),'[]'::jsonb)) AS facts
    FROM matches m WHERE m.id=${matchId}`.execute(tx);
  return hash(rows[0]?.facts??null);
}

async function reference(db:Db,observation:Awaited<ReturnType<Provider['getHeroes']>>|Awaited<ReturnType<Provider['getLeagues']>>) {
  const source=observation.source;
  await sql`INSERT INTO provider_reference_snapshots(provider,endpoint,adapter_version,payload_sha256,fetched_at,source_payload)
    VALUES ('opendota',${source.endpoint},${source.adapterVersion},${source.payloadSha256},${source.fetchedAt},${json(observation.data)})
    ON CONFLICT DO NOTHING`.execute(db);
  const {rows}=await sql<{id:string}>`SELECT id FROM provider_reference_snapshots WHERE provider='opendota'
    AND endpoint=${source.endpoint} AND payload_sha256=${source.payloadSha256}`.execute(db);
  return rows[0]!.id;
}

export class IngestionService {
  constructor(private readonly db:Db,private readonly provider:Provider) {}

  async ingest(matchId:string):Promise<ImportResult> {
    const observation=await this.provider.getMatchSource(matchId);
    const input=parseSource(observation,matchId);
    const eventAt=matchEventAt(input.match);
    if(!input.match || !eventAt) {
      const reasons=[...input.issues,...(!eventAt?['START_TIME_UNKNOWN']:[])];
      const context=hash({reasons});
      const inserted=await sql<{id:string}>`INSERT INTO provider_ingest_receipts(provider,provider_match_id,adapter_version,normalizer_version,
        context_sha256,payload_sha256,fetched_at,event_at,known_at,source_payload,status,reasons)
        VALUES ('opendota',${matchId},${input.source.adapterVersion},${NORMALIZER_VERSION},${context},
          ${input.source.payloadSha256},${input.source.fetchedAt},NULL,NULL,${json(input.projection)},'quarantined',${json(reasons)}) ON CONFLICT DO NOTHING RETURNING id`.execute(this.db);
      const {rows}=await sql<{id:string}>`SELECT id FROM provider_ingest_receipts WHERE provider='opendota' AND provider_match_id=${matchId}
        AND payload_sha256=${input.source.payloadSha256} AND adapter_version=${input.source.adapterVersion}
        AND normalizer_version=${NORMALIZER_VERSION} AND context_sha256=${context}`.execute(this.db);
      return {matchId,receiptId:rows[0]!.id,status:'quarantined',duplicate:inserted.rows.length===0,dataRevision:null};
    }
    const match=input.match;
    // Commit replayable raw evidence before dependent reference/network calls.
    // A failed catalogue download must not erase the already observed map.
    await sql`INSERT INTO provider_ingest_receipts(provider,provider_match_id,adapter_version,normalizer_version,
      context_sha256,payload_sha256,fetched_at,event_at,known_at,source_payload,status,reasons)
      VALUES ('opendota',${matchId},${input.source.adapterVersion},${NORMALIZER_VERSION},${hash({phase:'received'})},
        ${input.source.payloadSha256},${input.source.fetchedAt},${eventAt},NULL,${json(input.projection)},'received','[]'::jsonb)
      ON CONFLICT DO NOTHING`.execute(this.db);
    // No network call runs inside the canonical-map transaction.
    const heroes=await this.provider.getHeroes();
    const leagues=await this.provider.getLeagues();
    const heroReference=await reference(this.db,heroes);
    const leagueReference=await reference(this.db,leagues);
    const matchingLeagues=match.leagueid?leagues.data.filter(item=>item.leagueid===match.leagueid):[];
    const league=matchingLeagues.length===1?matchingLeagues[0]:undefined;
    const pro=classifyLeague(league?.tier);
    const source=input.source;
    const observedWinner=completedObservation(match,source.fetchedAt)?match.radiant_win??null:null;
    return this.db.transaction().execute(async tx=>{
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`map:${matchId}`},0))`.execute(tx);
      if(heroes.data.length)await tx.insertInto('heroes').values(heroes.data.map(hero=>({id:hero.id,internal_name:hero.name,localized_name:hero.localized_name})))
        .onConflict(oc=>oc.doNothing()).execute();
      const knownHeroes=new Set((await tx.selectFrom('heroes').select('id').execute()).map(hero=>hero.id));
      for(const id of [...knownHeroes])if(!heroes.data.some(hero=>hero.id===id))knownHeroes.delete(id);
      const participantAccounts=(match.players??[]).flatMap(player=>player.account_id?[player.account_id]:[]);
      const identityEvidence=await readAccountEvidence(tx,participantAccounts);
      const identityResolutions=[...new Set(participantAccounts)].sort().map(accountId=>({accountId,...resolveIdentity(identityEvidence,accountId,null)}));
      const players=new Map(identityResolutions.flatMap(identity=>identity.playerId===null?[]:[[identity.accountId,identity.playerId] as const]));
      const resolved=(match.players??[]).map(player=>player.account_id?players.get(player.account_id):undefined).filter(id=>id!==undefined);
      for(const [account,id] of players)if(resolved.filter(other=>other===id).length>1)players.delete(account);

      async function team(side:'radiant'|'dire'):Promise<string|null> {
        const external=side==='radiant'?match.radiant_team_id:match.dire_team_id;
        const detail=side==='radiant'?match.radiant_team:match.dire_team;
        if(!external)return null;
        if(detail?.team_id===external && detail.name)await sql`INSERT INTO teams(opendota_team_id,name,tag,synced_at)
          VALUES (${external},${detail.name},${detail.tag??null},${source.fetchedAt}) ON CONFLICT (opendota_team_id) DO NOTHING`.execute(tx);
        const {rows}=await sql<{id:string}>`SELECT id FROM teams WHERE opendota_team_id=${external}`.execute(tx);
        return rows[0]?.id??null;
      }
      let radiantTeamId=await team('radiant');
      let direTeamId=await team('dire');
      if(radiantTeamId===direTeamId){radiantTeamId=null;direTeamId=null;}
      let leagueId:string|null=null;
      if(league?.name){await sql`INSERT INTO leagues(opendota_league_id,name,tier) VALUES (${league.leagueid},${league.name},${league.tier??null})
        ON CONFLICT (opendota_league_id) DO NOTHING`.execute(tx);
        leagueId=(await sql<{id:string}>`SELECT id FROM leagues WHERE opendota_league_id=${league.leagueid}`.execute(tx)).rows[0]?.id??null;}
      const series=match.series_id?(await sql<{id:string}>`SELECT id FROM series WHERE provider='opendota'
        AND provider_series_id=${match.series_id} AND (league_id IS NULL OR league_id=${leagueId}) AND
        ((team_a_id=${radiantTeamId} AND team_b_id=${direTeamId}) OR (team_b_id=${radiantTeamId} AND team_a_id=${direTeamId}))`.execute(tx)).rows:[];
      const seriesId=series.length===1?series[0]!.id:null;
      const contextHash=hash({pro,heroReference,leagueReference,players:[...players].sort(),identityResolutions,radiantTeamId,direTeamId,seriesId});
      const existing=(await sql<{id:string;status:ImportResult['status']}>`SELECT id,status FROM provider_ingest_receipts WHERE provider='opendota'
        AND provider_match_id=${matchId} AND payload_sha256=${source.payloadSha256} AND adapter_version=${source.adapterVersion}
        AND normalizer_version=${NORMALIZER_VERSION} AND context_sha256=${contextHash}`.execute(tx)).rows[0];
      if(existing){const row=(await sql<{data_revision:string;ingest_state:string}>`SELECT data_revision,ingest_state FROM matches WHERE id=${matchId}`.execute(tx)).rows[0];
        return {matchId,receiptId:existing.id,status:row?.ingest_state==='conflict'?'conflict':existing.status,duplicate:true,dataRevision:row?.data_revision??null};}

      const before=(await sql<Canonical>`SELECT id,started_at,radiant_win,radiant_team_id,dire_team_id,league_id,series_id,is_pro,ingest_state,data_revision,duration_seconds,radiant_score,dire_score
        FROM matches WHERE id=${matchId} FOR UPDATE`.execute(tx)).rows[0];
      const oldPlayers=(await sql<StoredPlayer>`SELECT player_slot,hero_id,source_account_id,player_id,kills,deaths,assists,gpm,xpm FROM match_players WHERE match_id=${matchId}`.execute(tx)).rows;
      const previousFingerprint=await fingerprint(tx,matchId);
      const sourceAccounts=(match.players??[]).map(player=>player.account_id);
      const sourceHeroes=(match.players??[]).map(player=>player.hero_id);
      const sourceSlots=(match.players??[]).map(player=>player.player_slot);
      const normalized=(match.players??[]).filter(player=>sideOf(player.player_slot)!==null && player.hero_id!=null &&
        knownHeroes.has(player.hero_id) && sourceSlots.filter(slot=>slot===player.player_slot).length===1 && sourceHeroes.filter(hero=>hero===player.hero_id).length===1);
      const conflicts:string[]=[];
      for(const side of ['radiant','dire'] as const){
        const flat=side==='radiant'?match.radiant_team_id:match.dire_team_id;
        const nested=side==='radiant'?match.radiant_team?.team_id:match.dire_team?.team_id;
        if(flat!=null && nested!=null && flat!==nested)conflicts.push(`${side}_team_id`);
      }
      const priorFacts=(await sql<{field_name:string;value:unknown}>`SELECT field_name,value FROM match_field_observations WHERE match_id=${matchId}
        AND field_name IN ('radiant_team_id','dire_team_id','leagueid','series_id') ORDER BY id`.execute(tx)).rows;
      for(const field of ['radiant_team_id','dire_team_id','leagueid','series_id'] as const){
        const prior=priorFacts.find(fact=>fact.field_name===field && fact.value!=null && String(fact.value)!=='0');
        if(prior && match[field]!=null && String(prior.value)!==match[field])conflicts.push(field);
      }
      if(before){
        if(before.started_at.toISOString()!==eventAt)conflicts.push('started_at');
        for(const [field,oldValue,newValue] of [
          ['radiant_win',before.radiant_win,observedWinner],['radiant_team_id',before.radiant_team_id,radiantTeamId],
          ['dire_team_id',before.dire_team_id,direTeamId],['league_id',before.league_id,leagueId],['series_id',before.series_id,seriesId],
          ['is_pro',before.is_pro,pro],['duration',before.duration_seconds,bounded(match.duration,2147483647)],
          ['radiant_score',before.radiant_score,bounded(match.radiant_score,32767)],['dire_score',before.dire_score,bounded(match.dire_score,32767)]
        ] as const)if(oldValue!=null && newValue!=null && oldValue!==newValue)conflicts.push(field);
        for(const player of normalized){const old=oldPlayers.find(row=>row.player_slot===player.player_slot);
          if(old && (old.hero_id!==player.hero_id || old.source_account_id!=null && player.account_id!=null && old.source_account_id!==player.account_id))conflicts.push(`players.${player.player_slot}`);
          if(old){
            const nextId=player.account_id?players.get(player.account_id):undefined;
            if(old.player_id!=null && nextId!=null && old.player_id!==nextId)conflicts.push(`players.${player.player_slot}.player_id`);
            for(const [field,prior,next] of [['kills',old.kills,bounded(player.kills,32767)],['deaths',old.deaths,bounded(player.deaths,32767)],
              ['assists',old.assists,bounded(player.assists,32767)],['gpm',old.gpm,bounded(player.gold_per_min,2147483647)],
              ['xpm',old.xpm,bounded(player.xp_per_min,2147483647)]] as const)
              if(prior!=null && next!=null && prior!==next)conflicts.push(`players.${player.player_slot}.${field}`);
          }
        }
      }
      const conflict=before?.ingest_state==='conflict'||conflicts.length>0;
      const quality=assess(match,{pro,knownHeroes,players,radiantTeamId,direTeamId,seriesId,conflict,fetchedAt:source.fetchedAt});
      const status:ImportResult['status']=conflict?'conflict':quality.metrics.final_heroes_valid && quality.outcome_status==='eligible'?'accepted':'partial';
      if(!before)await sql`INSERT INTO matches(id,started_at,source) VALUES (${matchId},${eventAt},'opendota')`.execute(tx);
      const receipt=(await sql<{id:string}>`INSERT INTO provider_ingest_receipts(provider,provider_match_id,canonical_match_id,adapter_version,
        normalizer_version,context_sha256,payload_sha256,fetched_at,event_at,known_at,source_payload,status,reasons)
        VALUES ('opendota',${matchId},${matchId},${source.adapterVersion},${NORMALIZER_VERSION},${contextHash},${source.payloadSha256},
          ${source.fetchedAt},${eventAt},NULL,${json(input.projection)},${status},${json([...quality.anomalies,...conflicts.map(field=>`CONFLICT:${field}`)])}) RETURNING id`.execute(tx)).rows[0]!;

      await sql`INSERT INTO match_source_snapshots(match_id,provider,provider_match_id,adapter_version,fetched_at,payload_sha256,coverage,raw_blob_ref)
        VALUES (${matchId},'opendota',${matchId},${source.adapterVersion},${source.fetchedAt},${source.payloadSha256},${json(quality.metrics)},
          ${`pg:provider_ingest_receipts/${receipt.id}`}) ON CONFLICT DO NOTHING`.execute(tx);
      const snapshot=(await sql<{id:string}>`SELECT id FROM match_source_snapshots WHERE provider='opendota' AND provider_match_id=${matchId}
        AND payload_sha256=${source.payloadSha256}`.execute(tx)).rows[0]!;
      const rawDraft=input.projection.picks_bans;
      await sql`INSERT INTO match_draft_source_observations(match_id,source_snapshot_id,provider,adapter_version,fetched_at,raw_picks_bans,payload_sha256)
        VALUES (${matchId},${snapshot.id},'opendota',${source.adapterVersion},${source.fetchedAt},
          ${rawDraft==null?sql`NULL`:json(rawDraft)},${source.payloadSha256}) ON CONFLICT DO NOTHING`.execute(tx);
      const draft=(await sql<{id:string}>`SELECT id FROM match_draft_source_observations WHERE match_id=${matchId} AND provider='opendota'
        AND adapter_version=${source.adapterVersion} AND payload_sha256=${source.payloadSha256}`.execute(tx)).rows[0]!;
      const facts:Record<string,unknown>={...input.projection,pro_classification:{value:pro,league_tier:league?.tier??null,reference_id:leagueReference},
        canonical_players:[...players],identity_resolution:identityResolutions,patch_resolution:{value:null,reason:'PATCH_METADATA_UNVERIFIED'}};
      for(const [field,value] of Object.entries(facts))await sql`INSERT INTO match_field_observations(match_id,field_name,provider,value,
        provider_record_id,fetched_at,known_at,evidence_ref,adapter_version,value_sha256,review_state,receipt_id)
        VALUES (${matchId},${field},'opendota',${json(value)},${matchId},${source.fetchedAt},NULL,${`receipt:${receipt.id}`},
          ${source.adapterVersion},${hash(value)},${conflicts.some(item=>item===field||item.startsWith(field+'.'))?'conflict':'unverified'},${receipt.id})`.execute(tx);
      await sql`INSERT INTO match_quality_assessments(match_id,source_snapshot_id,draft_observation_id,validator_version,
        outcome_status,player_status,final_heroes_status,organization_status,series_status,draft_timeline_status,draft_order_valid,anomalies,metrics)
        VALUES (${matchId},${snapshot.id},${draft.id},${QUALITY_POLICY+':'+contextHash},${quality.outcome_status},${quality.player_status},
          ${quality.final_heroes_status},${quality.organization_status},${quality.series_status},${quality.draft_timeline_status},NULL,
          ${json(quality.anomalies)},${json({...quality.metrics,receipt_id:receipt.id,conflicts,normalizer_version:NORMALIZER_VERSION,hero_reference_id:heroReference,league_reference_id:leagueReference})}) ON CONFLICT DO NOTHING`.execute(tx);

      if(conflict){
        await sql`UPDATE matches SET is_pro=NULL,ingest_state='conflict',detail_status='partial' WHERE id=${matchId}`.execute(tx);
      }else{
        await sql`UPDATE matches SET radiant_win=coalesce(radiant_win,${observedWinner}),
          radiant_team_id=coalesce(radiant_team_id,${radiantTeamId}),dire_team_id=coalesce(dire_team_id,${direTeamId}),
          league_id=coalesce(league_id,${leagueId}),series_id=coalesce(series_id,${seriesId}),is_pro=coalesce(is_pro,${pro}),
          duration_seconds=coalesce(duration_seconds,${bounded(match.duration,2147483647)}),
          radiant_score=coalesce(radiant_score,${bounded(match.radiant_score,32767)}),dire_score=coalesce(dire_score,${bounded(match.dire_score,32767)}),
          detail_status=${quality.metrics.final_heroes_valid?'complete':'partial'},ingest_state=${status}
          WHERE id=${matchId}`.execute(tx);
        for(const player of normalized){
          const playerId=player.account_id && sourceAccounts.filter(id=>id===player.account_id).length===1?players.get(player.account_id)??null:null;
          await sql`INSERT INTO match_players(match_id,player_slot,side,player_id,team_id,hero_id,source_account_id,kills,deaths,assists,gpm,xpm)
            VALUES (${matchId},${player.player_slot},${sideOf(player.player_slot)},${playerId},${sideOf(player.player_slot)==='radiant'?radiantTeamId:direTeamId},
              ${player.hero_id},${player.account_id??null},${bounded(player.kills,32767)},${bounded(player.deaths,32767)},${bounded(player.assists,32767)},
              ${bounded(player.gold_per_min,2147483647)},${bounded(player.xp_per_min,2147483647)})
            ON CONFLICT (match_id,player_slot) DO UPDATE SET player_id=coalesce(match_players.player_id,EXCLUDED.player_id),
              source_account_id=coalesce(match_players.source_account_id,EXCLUDED.source_account_id),team_id=coalesce(match_players.team_id,EXCLUDED.team_id),
              kills=coalesce(match_players.kills,EXCLUDED.kills),deaths=coalesce(match_players.deaths,EXCLUDED.deaths),
              assists=coalesce(match_players.assists,EXCLUDED.assists),gpm=coalesce(match_players.gpm,EXCLUDED.gpm),xpm=coalesce(match_players.xpm,EXCLUDED.xpm)`.execute(tx);
        }
      }
      await sql`UPDATE matches SET synced_at=${source.fetchedAt},updated_at=now(),
        draft_status=${match.picks_bans?.length?'partial':'unavailable'} WHERE id=${matchId}`.execute(tx);
      const changed=previousFingerprint!==await fingerprint(tx,matchId);
      await sql`UPDATE matches SET data_revision=data_revision+${changed?1:0} WHERE id=${matchId}`.execute(tx);
      const final=(await sql<{data_revision:string}>`SELECT data_revision FROM matches WHERE id=${matchId}`.execute(tx)).rows[0]!;
      return {matchId,receiptId:receipt.id,status,duplicate:false,dataRevision:final.data_revision};
    });
  }
}
