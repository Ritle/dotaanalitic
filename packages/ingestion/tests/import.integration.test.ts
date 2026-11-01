import {afterAll,beforeAll,test,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {sql,IdentityRepository,ProMapRepository,readAccountEvidence,resolveIdentity} from '@dota/db';
import {OpenDotaClient,PostgresProviderBudget,IngestionService,validateCurrentHistoryCapture} from '../src/index.js';
import {testDatabase} from '../../../tests/helpers/postgres.js';

let fixture:Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async()=>{fixture=await testDatabase();},60000);
afterAll(async()=>{await fixture?.close();},30000);
const base=(id:string)=>({match_id:id,start_time:1700000000,duration:1800,radiant_win:false,leagueid:77,series_id:0,patch:60,
  players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:128+i-5,hero_id:i+1,account_id:100001+i})),picks_bans:null as unknown});
const heroes=Array.from({length:20},(_,i)=>({id:i+1,name:`synthetic_hero_${i+1}`,localized_name:`Synthetic ${i+1}`}));
function importer(payload:unknown,tier:string|null='professional'){
  let clock=Date.UTC(2026,9,31);
  const client=new OpenDotaClient({}, {now:()=>clock,sleep:async ms=>{clock+=ms;},fetch:async url=>{
    const data=url.pathname==='/api/heroes'?heroes:url.pathname==='/api/leagues'?[{leagueid:77,name:'Synthetic league',tier}]:payload;
    return new Response(JSON.stringify(data));
  }});
  return new IngestionService(fixture.db,client);
}

test('captured current pro-history feeds retrospective player statistics without backdating identity; raw replay is idempotent',async()=>{
  const account='300001',player='9007199254741999',matchId='900000000090';
  await sql`INSERT INTO players(id,opendota_account_id,nickname) VALUES (${player},${account},'Synthetic current history player')`.execute(fixture.db);
  await new IdentityRepository(fixture.db).appendAccountEvidence({playerId:player,provider:'opendota',externalAccountId:account,status:'verified',
    eventAt:null,knownAt:'2026-10-31T00:00:00.000Z',fetchedAt:'2026-10-31T00:00:00.000Z',source:'synthetic-current-catalogue',evidenceRef:'synthetic-numeric-proof'});
  const raw={...base(matchId),radiant_team_id:3101,dire_team_id:3102,
    radiant_team:{team_id:3101,name:'Synthetic history A'},dire_team:{team_id:3102,name:'Synthetic history B'},
    players:base(matchId).players.map((p,i)=>({...p,account_id:300001+i}))};
  const observation=(endpoint:string,data:unknown)=>{const rawBody=JSON.stringify(data);return {rawBody,source:{provider:'opendota',adapterVersion:'synthetic-current-history-test',endpoint,
    fetchedAt:'2026-10-31T00:00:01.000Z',knownAt:null,payloadSha256:createHash('sha256').update(rawBody).digest('hex'),attempts:1,
    rateLimitRemaining:{minute:null,day:null,month:null}}};};
  const validated=validateCurrentHistoryCapture({schemaVersion:1,mode:'live_current_history_capture',teamIds:['3101'],sample:1,
    cutoffAt:'2026-10-31T00:00:00.000Z',capturedAt:'2026-10-31T00:00:02.000Z',
    discoveries:[observation('/teams/3101/matches',[{...raw,radiant:true,opposing_team_id:3102}])],
    heroes:observation('/heroes',heroes),leagues:observation('/leagues',[{leagueid:77,name:'Synthetic history league',tier:'professional'}]),
    matches:[observation(`/matches/${matchId}`,raw)],errors:[]});
  expect(validated.matches[0]!.eligible).toBe(true);
  const service=new IngestionService(fixture.db,{getMatchSource:async()=>validated.matches[0]!.observation,getHeroes:async()=>validated.heroes,getLeagues:async()=>validated.leagues});
  const first=await service.ingest(matchId),again=await service.ingest(matchId);expect(again).toMatchObject({duplicate:true,dataRevision:first.dataRevision,status:'accepted'});
  const report=await new ProMapRepository(fixture.db).report('players',player,{cutoffAt:'2024-01-01T00:00:00.000Z',limit:20});
  expect(report).toMatchObject({scope:'retrospective_descriptive',predictionEligibility:'not_assessed',model:null,
    summary:{nRaw:1,wins:0,losses:1,winRate:0},coverage:{knownPatch:0,knownSeries:0,completeCanonicalRosters:0}});
  const evidence=await readAccountEvidence(fixture.db,[account]);expect(resolveIdentity(evidence,account,'2024-01-01T00:00:00.000Z').playerId).toBeNull();
  expect((await sql<{n:number}>`SELECT count(*)::int AS n FROM match_field_observations WHERE match_id=${matchId} AND known_at IS NOT NULL`.execute(fixture.db)).rows[0]!.n).toBe(0);
});
test('repeat and parallel import produce one map, ten slots, one raw snapshot and a stable revision',async()=>{
  const payload=base('900000000001');
  const first=await importer(payload).ingest(payload.match_id);
  expect(first.status).toBe('accepted');
  const results=await Promise.all(Array.from({length:3},()=>importer(payload).ingest(payload.match_id)));
  expect(results.every(row=>row.duplicate)).toBe(true);
  const {rows}=await sql<{maps:string;players:string;snapshots:string;drafts:string;revision:string;known:string;patch_id:null}>
    `SELECT (SELECT count(*) FROM matches WHERE id=${payload.match_id}) AS maps,
     (SELECT count(*) FROM match_players WHERE match_id=${payload.match_id}) AS players,
     (SELECT count(*) FROM match_source_snapshots WHERE match_id=${payload.match_id}) AS snapshots,
     (SELECT count(*) FROM match_draft_source_observations WHERE match_id=${payload.match_id}) AS drafts,
     data_revision AS revision,patch_id,(SELECT count(*) FROM match_field_observations WHERE match_id=${payload.match_id} AND known_at IS NOT NULL) AS known
     FROM matches WHERE id=${payload.match_id}`.execute(fixture.db);
  expect(rows[0]).toEqual({maps:'1',players:'10',snapshots:'1',drafts:'1',revision:first.dataRevision,known:'0',patch_id:null});
});
test.each([0,10,11,12])('%i picks, wrong sides and missing organizations are retained separately from final heroes',async count=>{
  const payload=base('9000000001'+String(count).padStart(2,'0'));
  payload.picks_bans=count?Array.from({length:count},(_,i)=>({is_pick:true,hero_id:i+1,team:1,order:i,extra:'retain'}))
    :[{is_pick:false,hero_id:20,team:0,order:0,extra:'retain'}];
  await importer(payload).ingest(payload.match_id);
  const {rows}=await sql<{raw:unknown[];final_heroes_status:string;organization_status:string;draft_order_valid:null;actions:string}>
    `SELECT d.raw_picks_bans AS raw,q.final_heroes_status,q.organization_status,q.draft_order_valid,
      (SELECT count(*) FROM match_draft_actions WHERE match_id=${payload.match_id}) AS actions
      FROM match_draft_source_observations d JOIN match_quality_assessments q ON q.draft_observation_id=d.id WHERE d.match_id=${payload.match_id}`.execute(fixture.db);
  expect(rows[0]!.raw).toEqual(payload.picks_bans);
  expect(rows[0]).toMatchObject({final_heroes_status:'eligible',organization_status:'unknown',draft_order_valid:null,actions:'0'});
});
test('a source correction is archived; known canonical winner is not silently overwritten',async()=>{
  const payload=base('900000000003');
  const first=await importer(payload).ingest(payload.match_id);
  const corrected={...payload,radiant_win:true};
  const conflict=await importer(corrected).ingest(payload.match_id);
  expect(conflict.status).toBe('conflict');
  const row=(await sql<{radiant_win:boolean;is_pro:null;ingest_state:string;count:string}>
    `SELECT radiant_win,is_pro,ingest_state,(SELECT count(*) FROM match_source_snapshots WHERE match_id=${payload.match_id}) AS count
      FROM matches WHERE id=${payload.match_id}`.execute(fixture.db)).rows[0]!;
  expect(row).toEqual({radiant_win:false,is_pro:null,ingest_state:'conflict',count:'2'});
  expect(conflict.dataRevision).not.toBe(first.dataRevision);
  expect((await importer(payload).ingest(payload.match_id)).status).toBe('conflict');
});
test('unknown time/schema is quarantined without inventing a map date; receipts deduplicate',async()=>{
  const payload={match_id:'900000000004',players:'invalid-shape'};
  const one=await importer(payload).ingest(payload.match_id);
  const two=await importer(payload).ingest(payload.match_id);
  expect(one.status).toBe('quarantined');expect(two.duplicate).toBe(true);
  expect((await sql<{count:string}>`SELECT count(*) FROM matches WHERE id=${payload.match_id}`.execute(fixture.db)).rows[0]!.count).toBe('0');
});
test('unverified identity links never merge player histories; later verification fills nullable IDs',async()=>{
  const payload=base('900000000005');
  await sql`INSERT INTO players(id,nickname) VALUES ('9007199254740993','Synthetic same nickname'),('9007199254740995','Synthetic same nickname')`.execute(fixture.db);
  await sql`INSERT INTO player_external_accounts(player_id,provider,external_account_id,link_status)
    VALUES ('9007199254740993','opendota','100001','provisional')`.execute(fixture.db);
  await importer(payload).ingest(payload.match_id);
  expect((await sql<{player_id:null}>`SELECT player_id FROM match_players WHERE match_id=${payload.match_id} AND player_slot=0`.execute(fixture.db)).rows[0]!.player_id).toBeNull();
  await sql`UPDATE player_external_accounts SET link_status='verified',evidence_ref='synthetic-test-evidence',verified_at=now()
    WHERE provider='opendota' AND external_account_id='100001'`.execute(fixture.db);
  await importer(payload).ingest(payload.match_id);
  expect((await sql<{player_id:string}>`SELECT player_id FROM match_players WHERE match_id=${payload.match_id} AND player_slot=0`.execute(fixture.db)).rows[0]!.player_id).toBe('9007199254740993');
});
test('non-pro/unknown leagues cannot enter confirmed pro statistics',async()=>{
  for(const [id,tier] of [['900000000006','amateur'],['900000000007',null]] as const){
    await importer(base(id),tier).ingest(id);
    expect((await sql<{is_pro:boolean|null}>`SELECT is_pro FROM matches WHERE id=${id}`.execute(fixture.db)).rows[0]!.is_pro).toBe(tier===null?null:false);
  }
});

test('verified account evidence resolves new imports; provider disagreement stays unresolved',async()=>{
  const identity=new IdentityRepository(fixture.db);
  await sql`INSERT INTO players(id,nickname) VALUES (80001,'Synthetic shared alias'),(80002,'Synthetic shared alias')`.execute(fixture.db);
  const proof={playerId:'80001',provider:'opendota' as const,externalAccountId:'880001',status:'verified' as const,
    eventAt:null,knownAt:null,fetchedAt:'2026-10-31T00:00:00.000Z',evidenceRef:'synthetic:account-proof',source:'synthetic'};
  await identity.appendAccountEvidence(proof);
  const first=base('900000000051');first.players[0]!.account_id=880001;
  await importer(first).ingest(first.match_id);
  expect((await sql<{player_id:string|null}>`SELECT player_id FROM match_players WHERE match_id=${first.match_id} AND player_slot=0`.execute(fixture.db)).rows[0]!.player_id).toBe('80001');
  const conflict=await identity.appendAccountEvidence({...proof,provider:'stratz',playerId:'80002',evidenceRef:'synthetic:contradiction'});
  expect(conflict.resolution.status).toBe('conflict');
  const second=base('900000000052');second.players[0]!.account_id=880001;
  await importer(second).ingest(second.match_id);
  expect((await sql<{player_id:string|null}>`SELECT player_id FROM match_players WHERE match_id=${second.match_id} AND player_slot=0`.execute(fixture.db)).rows[0]!.player_id).toBeNull();
});
test('transaction rollback preserves received source evidence but never a half-written canonical map',async()=>{
  await sql`CREATE FUNCTION fail_test_quality() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic injected failure'; END $$` .execute(fixture.db);
  await sql`CREATE TRIGGER fail_test_quality BEFORE INSERT ON match_quality_assessments FOR EACH ROW EXECUTE FUNCTION fail_test_quality()`.execute(fixture.db);
  const payload=base('900000000008');
  try{await expect(importer(payload).ingest(payload.match_id)).rejects.toThrow('synthetic injected failure');}
  finally{await sql`DROP TRIGGER fail_test_quality ON match_quality_assessments`.execute(fixture.db);}
  expect((await sql<{count:string}>`SELECT count(*) FROM matches WHERE id=${payload.match_id}`.execute(fixture.db)).rows[0]!.count).toBe('0');
  expect((await sql<{status:string}>`SELECT status FROM provider_ingest_receipts WHERE provider_match_id=${payload.match_id}`.execute(fixture.db)).rows[0]!.status).toBe('received');
});
test('source/assessment records are immutable and body refinements do not increase unique map counts',async()=>{
  await expect(sql`UPDATE provider_ingest_receipts SET reasons='[]'::jsonb WHERE provider_match_id='900000000001'`.execute(fixture.db)).rejects.toThrow(/Immutable/);
  await expect(sql`DELETE FROM match_source_snapshots WHERE provider_match_id='900000000001'`.execute(fixture.db)).rejects.toThrow(/Immutable/);
});
test('shared quota is atomic, survives a new instance and honors server cooldown',async()=>{
  const quota=new PostgresProviderBudget(fixture.db,{daily:2,monthly:3});
  const outcomes=await Promise.all([quota.claim(),new PostgresProviderBudget(fixture.db,{daily:2,monthly:3}).claim()]);
  expect(outcomes.filter(result=>result.allowed)).toHaveLength(1);
  await quota.observe(429,120000,{minute:null,day:null,month:null});
  const blocked=await new PostgresProviderBudget(fixture.db).claim();
  expect(blocked.allowed).toBe(false);expect(blocked.retryAfterMs).toBeGreaterThan(110000);
  await sql`UPDATE provider_quotas SET blocked_until='-infinity',next_request_at='-infinity',day_used=2 WHERE provider='opendota'`.execute(fixture.db);
  expect(await quota.claim()).toMatchObject({allowed:false,period:'day'});
  await sql`UPDATE provider_quotas SET day_start=day_start-interval '1 day',next_request_at='-infinity' WHERE provider='opendota'`.execute(fixture.db);
  expect((await quota.claim()).allowed).toBe(true);
});
