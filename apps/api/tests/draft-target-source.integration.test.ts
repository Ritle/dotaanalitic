import {test,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedDraft,draftInput} from '../../../tests/helpers/draft.js';
import {ScenarioRepository,MatchContextRepository,sql} from '../../../packages/db/src/index.js';
import {OpenDotaClient,IngestionService} from '../../../packages/ingestion/src/index.js';
import {AuthService} from '../src/modules/auth/service.js';
import {DraftCaptureRepository} from '../src/modules/scenarios/draft-capture-repository.js';
import {readDraftTargetSources} from '../src/modules/scenarios/draft-target-source.js';
import {resolveDraftTargets} from '../src/modules/scenarios/draft-target-resolution.js';

test('reads empty/live-schema inventory and preserves captures while refusing unproven source maps',async()=>{
  const database=await testDatabase();
  try{
    expect((await readDraftTargetSources(database.db)).items).toEqual([]);
    await seedDraft(database.db);
    const owner=await new AuthService(database.db).provision('synthetic-target',randomBytes(24).toString('base64url'));
    const q=draftInput();q.draft!.assignments=(['A','B'] as const).flatMap((teamSlot,j)=>Array.from({length:5},(_,i)=>({teamSlot,rolePos:i+1,heroId:j*5+i+1})));
    const scenario=await new ScenarioRepository(database.db).save(owner.id,q),repo=new DraftCaptureRepository(database.db);
    const before=await repo.create(owner.id,scenario.id,{expectedRevision:1});
    const source=await readDraftTargetSources(database.db),result=resolveDraftTargets(source);
    expect(source.items).toHaveLength(1);expect(source.items[0]!.capture).toEqual(before);
    expect(source.items[0]!.candidates.length).toBeGreaterThan(0);
    expect(result.items[0]).toMatchObject({bindingStatus:'unavailable',actualMatchId:null,prestartVerified:false});
    expect(result.items[0]!.reasons).toContain('TARGET_REFERENCE_MISSING');
    expect(await repo.get(owner.id,scenario.id,1)).toEqual(before);
    expect((await sql`SELECT count(*)::int AS n FROM owner_draft_captures`.execute(database.db)).rows[0]!.n).toBe(1);
    expect((await sql`SELECT count(*)::int AS n FROM prediction_runs`.execute(database.db)).rows[0]!.n).toBe(0);
    // A real importer/pro-evidence path, but strictly synthetic HTTP in this disposable DB.
    await sql`UPDATE teams SET opendota_team_id=CASE WHEN id=${q.teamAId}::bigint THEN 111 ELSE 222 END WHERE id IN (${q.teamAId}::bigint,${q.teamBId}::bigint)`.execute(database.db);
    await sql`UPDATE leagues SET opendota_league_id=1 WHERE id=1`.execute(database.db);
    const matchId='9007199254742888',start=Math.floor(Date.now()/1000)-60;
    const payload={match_id:matchId,start_time:start,duration:1,radiant_win:true,radiant_team_id:111,dire_team_id:222,leagueid:1,series_id:321,
      players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:i+123,hero_id:i+1,account_id:1000+i}))};
    const client=new OpenDotaClient({},{fetch:async url=>new Response(JSON.stringify(url.pathname==='/api/heroes'?
      Array.from({length:10},(_,i)=>({id:i+1,name:`synthetic_${i}`,localized_name:`Synthetic ${i}`})):
      url.pathname==='/api/leagues'?[{leagueid:1,name:'Synthetic event',tier:'professional'}]:payload))});
    await new IngestionService(database.db,client).ingest(matchId);
    const series=randomUUID();await sql`INSERT INTO series(id,provider,provider_series_id,team_a_id,team_b_id)
      VALUES(${series}::uuid,'opendota','321',${q.teamAId}::bigint,${q.teamBId}::bigint)`.execute(database.db);
    await sql`UPDATE matches SET series_id=${series}::uuid,map_number=1 WHERE id=${matchId}::bigint`.execute(database.db);
    await new MatchContextRepository(database.db).append({matchId,fact:{field:'map_number',value:1},eventAt:null,knownAt:null,fetchedAt:new Date().toISOString(),
      availability:'retrospective_fact',earliestStage:'post_match',provider:'synthetic-review',providerRecordId:null,evidenceRef:'synthetic:map-1',adapterVersion:'synthetic',reviewState:'accepted'});
    q.context.seriesId=series;q.context.mapNumber=1;
    const linkedScenario=await new ScenarioRepository(database.db).save(owner.id,q);
    const lateCapture=await repo.create(owner.id,linkedScenario.id,{expectedRevision:1});
    const finalSource=await readDraftTargetSources(database.db),linked=resolveDraftTargets(finalSource).items.find(i=>i.captureId===lateCapture.id)!;
    expect(linked).toMatchObject({bindingStatus:'matched',actualMatchId:matchId,temporalStatus:'not_before_provider_start',prestartVerified:false,deployable:false});
    expect(await repo.get(owner.id,scenario.id,1)).toEqual(before);
  }finally{await database.close();}
},60000);
