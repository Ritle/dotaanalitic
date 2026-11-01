// Synthetic observations in disposable PostgreSQL only.
import {beforeEach,afterEach,test,expect} from 'vitest';
import {sql} from '../src/index.js';
import {SeriesProvisionRepository} from '../src/series-provision.js';
import {OpenDotaClient,IngestionService} from '../../ingestion/src/index.js';
import {testDatabase} from '../../../tests/helpers/postgres.js';
let database:Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async()=>{database=await testDatabase();},30000);
afterEach(async()=>{await database?.close();},30000);
const request={providerSeriesIds:['901'],snapshotAt:'2026-10-31T20:00:00.000Z'};
const payload=(id:string,swap=false)=>({match_id:id,start_time:1700000000+Number(BigInt(id)%10n)*3600,duration:1800,radiant_win:true,
  leagueid:77,series_id:'901',series_type:1,radiant_team_id:swap?222:111,dire_team_id:swap?111:222,
  radiant_team:{team_id:swap?222:111,name:'Synthetic radiant'},dire_team:{team_id:swap?111:222,name:'Synthetic dire'},
  players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:i+123,hero_id:i+1,account_id:100001+i}))});
function importer(raw:unknown){
  let clock=Date.parse('2026-10-30T00:00:00.000Z');
  return new IngestionService(database.db,new OpenDotaClient({}, {now:()=>clock,sleep:async ms=>{clock+=ms;},fetch:async url=>new Response(JSON.stringify(
    url.pathname==='/api/heroes'?Array.from({length:10},(_,i)=>({id:i+1,name:`synthetic_${i}`,localized_name:`Synthetic ${i}`})):
    url.pathname==='/api/leagues'?[{leagueid:77,name:'Synthetic league',tier:'professional'},{leagueid:88,name:'Synthetic other',tier:'professional'}]:raw))}));
}
const repo=()=>new SeriesProvisionRepository(database.db);
test('preview includes side-swapped siblings; atomic registry apply, immutable evidence and importer replay are idempotent',async()=>{
  for(const [id,swap] of [['9007199254740993',false],['9007199254740994',true]] as const)await importer(payload(id,swap)).ingest(id);
  const plan=await repo().preview(request);expect(plan.status).toBe('ready');expect(plan.groups).toHaveLength(1);
  expect(plan.groups[0]).toMatchObject({bestOf:3,mapIds:['9007199254740993','9007199254740994'],reasons:[]});
  const results=await Promise.all([repo().apply(request,plan.fingerprint),repo().apply(request,plan.fingerprint)]);
  expect(results.map(r=>r.status).sort()).toEqual(['already_applied','applied']);
  expect((await sql`SELECT best_of,status,scheduled_at FROM series`.execute(database.db)).rows).toEqual([{best_of:3,status:null,scheduled_at:null}]);
  expect((await sql`SELECT count(*)::int AS n FROM matches WHERE series_id IS NOT NULL`.execute(database.db)).rows[0]).toEqual({n:0});
  for(const [id,swap] of [['9007199254740993',false],['9007199254740994',true]] as const){
    const first=await importer(payload(id,swap)).ingest(id);expect(first).toMatchObject({duplicate:false,status:'accepted'});
    expect(await importer(payload(id,swap)).ingest(id)).toMatchObject({duplicate:true,dataRevision:first.dataRevision});
  }
  expect((await sql`SELECT count(DISTINCT series_id)::int AS groups,count(series_id)::int AS maps FROM matches`.execute(database.db)).rows[0]).toEqual({groups:1,maps:2});
  expect((await sql`SELECT count(*)::int AS n FROM match_field_observations WHERE known_at IS NOT NULL`.execute(database.db)).rows[0]).toEqual({n:0});
  await expect(sql`DELETE FROM series_provision_batches`.execute(database.db)).rejects.toThrow();
});
test('another league sharing a provider series ID blocks the whole group',async()=>{
  await importer(payload('11')).ingest('11');await importer({...payload('12',true),leagueid:88}).ingest('12');
  const plan=await repo().preview(request);expect(plan.status).toBe('blocked');expect(plan.groups[0]!.reasons).toContain('SERIES_LEAGUE_CONFLICT');
  await expect(repo().apply(request,plan.fingerprint)).rejects.toThrow('series_plan_not_ready');
  expect((await sql`SELECT count(*)::int AS n FROM series`.execute(database.db)).rows[0]).toEqual({n:0});
});
test('a contradictory received-only observation cannot be hidden by a canonical receipt',async()=>{
  await importer(payload('11')).ingest('11');
  await sql`INSERT INTO provider_ingest_receipts(provider,provider_match_id,adapter_version,normalizer_version,context_sha256,
    payload_sha256,fetched_at,source_payload,status,reasons)
    SELECT provider,provider_match_id,adapter_version,normalizer_version,${'f'.repeat(64)},${'e'.repeat(64)},fetched_at,
    jsonb_set(source_payload,'{series_id}','"999"'::jsonb),'received','[]'::jsonb FROM provider_ingest_receipts WHERE canonical_match_id=11 LIMIT 1`.execute(database.db);
  const plan=await repo().preview(request);expect(plan.status).toBe('blocked');expect(plan.groups[0]!.reasons).toContain('MAP_SERIES_CONFLICT');
});
test.each([0,3,null])('unsupported or missing series type %s never uses the SQL BO3 default',async seriesType=>{
  await importer({...payload('11'),series_type:seriesType}).ingest('11');
  const plan=await repo().preview(request);expect(plan.status).toBe('blocked');expect(plan.groups[0]!.reasons).toContain('SERIES_TYPE_UNSUPPORTED');
});
test('new sibling after preview invalidates the fingerprint before writes',async()=>{
  await importer(payload('11')).ingest('11');const plan=await repo().preview(request);
  await importer(payload('12')).ingest('12');
  await expect(repo().apply(request,plan.fingerprint)).rejects.toThrow('series_plan_changed');
  expect((await sql`SELECT count(*)::int AS n FROM series`.execute(database.db)).rows[0]).toEqual({n:0});
});
test('duplicate canonical series aliases remain blocked rather than silently selecting one',async()=>{
  await importer(payload('11')).ingest('11');const plan=await repo().preview(request);const g=plan.groups[0]!;
  await sql`INSERT INTO series(team_a_id,team_b_id,league_id,provider,provider_series_id,best_of)
    SELECT ${g.teamAId}::bigint,${g.teamBId}::bigint,${g.leagueId}::bigint,'opendota','901',3 FROM generate_series(1,2)`.execute(database.db);
  expect((await repo().preview(request)).groups[0]!.reasons).toContain('CANONICAL_SERIES_AMBIGUOUS');
});

test('importer does not attach a new map to a registered series from another known league',async()=>{
  await importer(payload('11')).ingest('11');const plan=await repo().preview(request);await repo().apply(request,plan.fingerprint);
  await importer({...payload('12'),leagueid:88}).ingest('12');
  expect((await sql`SELECT series_id FROM matches WHERE id=12`.execute(database.db)).rows[0]).toEqual({series_id:null});
  expect((await repo().preview(request)).groups[0]!.reasons).toContain('SERIES_LEAGUE_CONFLICT');
});

test('a source receipt one microsecond after the snapshot is not rounded into the reviewed horizon',async()=>{
  await importer(payload('11')).ingest('11');
  await sql`INSERT INTO provider_ingest_receipts(provider,provider_match_id,adapter_version,normalizer_version,context_sha256,
    payload_sha256,fetched_at,source_payload,status,reasons)
    SELECT provider,provider_match_id,adapter_version,normalizer_version,${'f'.repeat(64)},payload_sha256,
    ${request.snapshotAt}::timestamptz+interval '1 microsecond',source_payload,'received','[]'::jsonb
    FROM provider_ingest_receipts WHERE canonical_match_id=11 LIMIT 1`.execute(database.db);
  expect((await repo().preview(request)).groups[0]!.reasons).toContain('RECEIPT_AFTER_SNAPSHOT');
});
