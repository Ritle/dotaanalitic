import {sql,MatchContextRepository,type Db} from '../../packages/db/src/index.js';
import {seedPlayerHeroes} from './player-hero.js';
import {catalogTeamId,catalogPlayerId} from './catalog.js';
/** Synthetic earlier-reference fixture; not a production training dataset. */
export async function assignSampleSeries(db:Db,matchId:string,seriesId=`00000000-0000-4000-8000-${matchId.padStart(12,'0')}`){
  await sql`INSERT INTO series(id,team_a_id,team_b_id,provider,status,best_of) VALUES(${seriesId},${catalogTeamId},9007199254740994,'synthetic','completed',1) ON CONFLICT DO NOTHING`.execute(db);
  await sql`UPDATE matches SET series_id=${seriesId} WHERE id=${matchId}`.execute(db);
  await new MatchContextRepository(db).append({matchId,fact:{field:'series_id',value:seriesId},eventAt:null,knownAt:null,fetchedAt:'2026-10-31T00:00:00.000Z',
    provider:'synthetic',providerRecordId:null,evidenceRef:'synthetic:verified-map-series',adapterVersion:'synthetic-v1',reviewState:'accepted',availability:'retrospective_fact',earliestStage:'post_match'});
}
export async function seedSamples(db:Db){
  await seedPlayerHeroes(db);await assignSampleSeries(db,'8001');await assignSampleSeries(db,'8002');
  for(let i=0;i<5;i++){
    const matchId=String(9001+i),role=i<3?1:2;
    await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id,dire_team_id)
      VALUES(${matchId},${`2023-04-0${i+1}T12:00:00Z`},1800,${i===0||i===3},true,${catalogTeamId},9007199254740994)`.execute(db);
    await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id,source_account_id)
      SELECT ${matchId}::bigint,player_slot,side,hero_id,source_account_id FROM match_players WHERE match_id=8001`.execute(db);
    await new MatchContextRepository(db).append({matchId,fact:{field:'roles',value:Array.from({length:5},(_,j)=>({playerSlot:j,
      playerId:String(BigInt(catalogPlayerId)+BigInt(j)),rolePos:role===2&&j<2?2-j:j+1,basis:'confirmed',confidence:1}))},eventAt:null,knownAt:null,
      fetchedAt:'2026-10-31T00:00:00.000Z',provider:'synthetic',providerRecordId:null,evidenceRef:'synthetic:reference-role',adapterVersion:'synthetic-v1',
      reviewState:'accepted',availability:'retrospective_fact',earliestStage:'post_match'});
    await assignSampleSeries(db,matchId);
  }
}
