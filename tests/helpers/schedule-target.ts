import {sql,type Db} from '../../packages/db/src/index.js';
import {registrySha} from '../../packages/db/src/v1-registry.js';
import type {UpcomingMatch} from '../../packages/contracts/src/index.js';
/** Explicit synthetic schedule, confined to caller-owned disposable test databases. */
export async function seedTargetCatalog(db:Db){
  await sql`INSERT INTO teams(id,name) VALUES(11,'Synthetic Target A'),(22,'Synthetic Target B')`.execute(db);
  await sql`INSERT INTO leagues(id,name,opendota_league_id) VALUES(77,'Synthetic Target Event',777)`.execute(db);
}
export function syntheticTargetMatch(patch:Partial<UpcomingMatch>={}):UpcomingMatch{return {providerMatchId:'9007199254742999',name:'Synthetic Target Match',status:'not_started',
  scheduledAt:new Date(Date.now()+3600000).toISOString(),tournament:{providerTournamentId:'71',name:'Synthetic Stage'},league:{providerLeagueId:'72',name:'Synthetic Event'},
  eventSeries:null,seriesBestOf:3,opponents:[{providerTeamId:'74',name:'Synthetic Target A'},{providerTeamId:'75',name:'Synthetic Target B'}],...patch};}
export async function publishTargetSchedule(db:Db,data:UpcomingMatch[]){
  const fetchedAt=new Date(Date.now()-1000).toISOString(),snapshot={data,source:{provider:'pandascore',adapterVersion:'synthetic-target-test',
    endpoint:'/dota2/matches/upcoming?sort=scheduled_at,id&page=1&per_page=20',fetchedAt,knownAt:null,payloadSha256:'a'.repeat(64),attempts:1,rateLimitRemaining:null}};
  const text=JSON.stringify(snapshot),sha=registrySha(text);
  const row=(await sql<{id:string}>`INSERT INTO upcoming_source_observations(cache_key,provider,source_endpoint,source_payload_sha256,source_fetched_at,snapshot_sha256,snapshot_text)
    VALUES('schedule','pandascore',${snapshot.source.endpoint},${snapshot.source.payloadSha256},${fetchedAt},${sha},${text}) RETURNING id::text`.execute(db)).rows[0]!;
  await sql`INSERT INTO upcoming_source_cache(cache_key,payload,expires_at) VALUES('schedule',${text}::jsonb,clock_timestamp()+interval '5 minutes')
    ON CONFLICT(cache_key) DO UPDATE SET payload=EXCLUDED.payload,expires_at=EXCLUDED.expires_at`.execute(db);
  return {id:row.id,sha,snapshot};
}
