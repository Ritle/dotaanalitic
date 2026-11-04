import {randomUUID} from 'node:crypto';
import {sql,type Db,ScenarioRepository,V1ScheduleTargetRepository,V1RuntimeRepository,MatchContextRepository} from '../../packages/db/src/index.js';
import {OpenDotaClient,IngestionService} from '../../packages/ingestion/src/index.js';
import {seedPredictionScenario} from './predictions.js';
import {publishTargetSchedule,syntheticTargetMatch} from './schedule-target.js';
/** Synthetic source and verified-map protocol fixture; only caller-owned disposable databases. */
export async function seedScheduledResult(db:Db,owner:string){
  const input=await seedPredictionScenario(db);
  await sql`UPDATE teams SET opendota_team_id=CASE id WHEN 11 THEN 111 ELSE 222 END WHERE id IN (11,22)`.execute(db);
  const meeting=syntheticTargetMatch({scheduledAt:input.scheduledAt});await publishTargetSchedule(db,[meeting]);
  const targets=new V1ScheduleTargetRepository(db),preview=await targets.preview(meeting.providerMatchId);
  const target=await targets.create(owner,{requestId:randomUUID(),providerMatchId:meeting.providerMatchId,observationId:preview.observation.id,
    observationSha256:preview.observation.snapshotSha256,expectedRevision:0,mapNumber:1,providerTeamAId:'74',providerTeamBId:'75',teamAId:'11',teamBId:'22',leagueId:'77',
    reviewSourceUrl:'https://example.test/synthetic-target-review',reason:'Synthetic reviewed organization and event mapping'});
  const scenario=await new ScenarioRepository(db).save(owner,{...input,title:'Synthetic result-owner forecast',context:{...input.context,mapNumber:1}});
  const forecast=await new V1RuntimeRepository(db).create(owner,{requestId:randomUUID(),scenarioId:scenario.id,expectedRevision:1,purpose:'real_map',
    realTarget:{provider:'pandascore',bindingVersion:1,providerMatchId:meeting.providerMatchId,mapNumber:1,targetRequestId:target.record.request.requestId,targetSha256:target.sha256},
    targetScope:{provider:'opendota',leagueId:'77',eventName:'Synthetic reviewed event',fromAt:'2024-01-01T00:00:00.000Z',until:'2100-01-01T00:00:00.000Z',tier:1,stage:'main_event',
      sourceUrl:'https://example.test/synthetic-tier1',rationale:'Synthetic reviewed Tier1 scope for outcome protocol only'}});
  // These forecasts are unavailable (no active model); prospective admission is covered by
  // the runtime/result integration suite. A completed map needs no real-time waiting here.
  const matchId='9007199254742888',start=Math.floor(Date.now()/1000)-60;
  let payload={match_id:matchId,start_time:start,duration:1,radiant_win:true,radiant_team_id:111,dire_team_id:222,leagueid:77,series_id:321,
    players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:i+123,hero_id:i+1,account_id:100001+i}))};
  async function ingest(won?:boolean){
    if(won!==undefined&&won!==payload.radiant_win){payload={...payload,radiant_win:won};await sql`UPDATE matches SET radiant_win=${won},data_revision=data_revision+1 WHERE id=${matchId}`.execute(db);}
    const client=new OpenDotaClient({},{fetch:async url=>new Response(JSON.stringify(url.pathname==='/api/heroes'?
      Array.from({length:10},(_,i)=>({id:i+1,name:`synthetic_${i}`,localized_name:`Synthetic ${i}`})):
      url.pathname==='/api/leagues'?[{leagueid:77,name:'Synthetic event',tier:'professional'}]:payload))});
    await new IngestionService(db,client).ingest(matchId);
  }
  await ingest();
  const series=(await sql<{id:string}>`INSERT INTO series(league_id,team_a_id,team_b_id,provider,provider_series_id) VALUES(77,11,22,'opendota','321') RETURNING id`.execute(db)).rows[0]!;
  await sql`UPDATE matches SET series_id=${series.id}::uuid,map_number=1 WHERE id=${matchId}`.execute(db);
  await sql`UPDATE match_players SET player_id=CASE WHEN side='radiant' THEN player_slot+101 ELSE player_slot-22 END WHERE match_id=${matchId}`.execute(db);
  await new MatchContextRepository(db).append({matchId,fact:{field:'map_number',value:1},eventAt:null,knownAt:null,fetchedAt:new Date().toISOString(),availability:'retrospective_fact',
    earliestStage:'post_match',provider:'synthetic-review',providerRecordId:'synthetic-map1',evidenceRef:'https://example.test/synthetic-map1',adapterVersion:'synthetic',reviewState:'accepted'});
  await new Promise(r=>setTimeout(r,5));
  const bindingBody=()=>({requestId:randomUUID(),matchId,providerSeriesId:'321',sourceUrl:'https://example.test/synthetic-cross-provider-proof',
    rationale:'Synthetic owner-reviewed association of this meeting and first professional map',confirmedByOwner:true as const});
  return {target,scenario,forecast,matchId,meeting,ingest,bindingBody};
}
