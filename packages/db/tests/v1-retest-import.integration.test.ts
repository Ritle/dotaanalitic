// Synthetic observations and CLI steps in disposable PostgreSQL only. No working DB or provider calls.
import {beforeEach,afterEach,test,expect,vi} from 'vitest';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {sql,IdentityRepository,reviewedIdentityEvidence,V1DataRepository} from '../src/index.js';
import {verifyV1Data,prepareV1MapHistory} from '../src/v1-data.js';
import {playerHistoryQuery} from '../../ingestion/dist/player-history.js';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {retestImportFixture} from '../../../tests/helpers/retest-import.mjs';
import {executeRetestImportStep} from '../../../scripts/lib/v1-retest-import-step.mjs';
import {captureRetestBatch} from '../../../scripts/lib/v1-retest-store.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>;
let fixture:Awaited<ReturnType<typeof retestImportFixture>>;
let network=0;
const planRef={path:'synthetic-test-plan.json',sha256:'e'.repeat(64)};
beforeEach(async()=>{database=await testDatabase();fixture=await retestImportFixture();network=0;vi.stubGlobal('fetch',()=>{network++;throw Error('unexpected_network');});},60000);
afterEach(async()=>{vi.unstubAllGlobals();await fixture?.dispose();await database?.close();},30000);
async function snapshot(){
 const tables=(await sql<{tablename:string}>`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`.execute(database.db)).rows;
 const result=[];for(const {tablename} of tables){const row=(await sql`SELECT count(*)::integer n,md5(coalesce(string_agg(t::text,E'\n' ORDER BY t::text),'')) sha FROM (SELECT to_jsonb(r) t FROM ${sql.table(tablename)} r) q`.execute(database.db)).rows[0];result.push({tablename,...row});}return result;
}
test('v2 steps bind numeric identities and swapped-side maps/series; repeated imports preserve all canonical tables',async()=>{
 await fixture.close();const inputs=await fixture.prepare();let index=0;
 const run=(mode:string)=>executeRetestImportStep(inputs,database.db,mode,join(fixture.root,'step-'+(++index)),planRef);
 const identities=await run('identities');expect(identities.report.results).toHaveLength(10);
 expect((await sql`SELECT count(*)::int n FROM players`.execute(database.db)).rows[0]).toEqual({n:10});
 const first=await run('maps');expect(first.report.summary).toEqual({accepted:2});
 const series=await run('series');expect(series.report.results[0].reasons??[]).toEqual([]);expect(series.report.results[0].status).toBe('applied');await run('maps');
 const before=await snapshot();const again=await run('maps');expect(again.report.results.every((r:{duplicate?:boolean})=>r.duplicate)).toBe(true);
 expect((await run('identities')).report.summary).toEqual({already_verified:10});expect((await run('series')).report.summary).toEqual({already_present:1});expect(await snapshot()).toEqual(before);
 const rows=(await sql`SELECT id::text,radiant_team_id::text,dire_team_id::text,series_id FROM matches ORDER BY id`.execute(database.db)).rows;
 expect(rows[0]).toMatchObject({id:'100000001',radiant_team_id:'1',dire_team_id:'2'});expect(rows[1]).toMatchObject({id:'100000002',radiant_team_id:'2',dire_team_id:'1'});expect(rows[0].series_id).toBe(rows[1].series_id);expect(rows[0].series_id).not.toBeNull();
 expect((await sql`SELECT count(*)::int n FROM match_field_observations WHERE known_at IS NOT NULL`.execute(database.db)).rows[0]).toEqual({n:0});
 // The explicit test-only reader checks the complete canonical export without weakening the production guard below.
 const request={...fixture.ctx.canonical.source.request,snapshotAt:new Date().toISOString()},code=fixture.ctx.canonical.source.code;
 const dataset=await new V1DataRepository(database.db,true).export(request,code);
 expect(dataset.source.syntheticOnly).toBe(true);expect(verifyV1Data(dataset)).toEqual(dataset);
 expect(dataset.source.candidates.map(m=>m.outcome.status)).toEqual(['verified','verified']);
 expect(dataset.source.candidates.every(m=>m.players.length===10&&m.receiptPlayers.length===10)).toBe(true);
 const history=prepareV1MapHistory(dataset.source);
 expect(history.report.examples.map(e=>e.historyCoverage.priorMapsPerPlayer)).toEqual([Array(10).fill(0),Array(10).fill(1)]);
 expect(await new V1DataRepository(database.db,true).export(request,code)).toEqual(dataset);expect(await snapshot()).toEqual(before);
 // Synthetic database rows must remain forbidden to the production dataset exporter.
 await expect(run('export')).rejects.toThrow('v1_synthetic_evidence_forbidden');expect(await snapshot()).toEqual(before);
 expect((await sql`SELECT count(*)::int n FROM prediction_model_versions WHERE is_active`.execute(database.db)).rows[0]).toEqual({n:0});expect(network).toBe(0);
},60000);
test('a conflicting canonical account stays blocked and cannot be overwritten by captured numeric proof',async()=>{
 await fixture.close();const inputs=await fixture.prepare();
 await executeRetestImportStep(inputs,database.db,'identities',join(fixture.root,'identities'),planRef);
 const review=inputs.plan.identityReviews.find(r=>r.accounts[0].accountId==='100');expect(review).toBeDefined();
 const player=(await sql<{player_id:string}>`SELECT player_id::text FROM player_account_evidence WHERE external_account_id='100' LIMIT 1`.execute(database.db)).rows[0]!;
 await new IdentityRepository(database.db).appendAccountEvidence({...reviewedIdentityEvidence(review,review.accounts[0],player.player_id).claim,status:'rejected'});
 const before=await snapshot();
 const result=await executeRetestImportStep(inputs,database.db,'identities',join(fixture.root,'conflicting-identity'),planRef);
 expect(result.report.summary).toEqual({blocked:1,already_verified:9});
 expect(result.report.results.find((r:{accountId:string})=>r.accountId==='100')).toMatchObject({status:'blocked',reasons:['IDENTITY_CONFLICT']});
 expect(result.report.writesAttempted).toBe(false);expect(await snapshot()).toEqual(before);expect(network).toBe(0);
},60000);
test('contradictory history is excluded before canonical writes while valid target maps remain importable',async()=>{
 const raw={...fixture.rawMaps[0],match_id:'99999999',series_id:'699',start_time:Date.parse('2026-01-10T00:00:00.000Z')/1000,radiant_win:false};
 const row={account_id:'100',match_id:raw.match_id,leagueid:'100',start_time:raw.start_time,duration:raw.duration,radiant_win:true,player_slot:0,tier:'professional'};
 const provider:typeof fixture.provider=async(limit,hooks)=>{
  const p=await fixture.provider(limit,hooks),capture=async(endpoint:string,data:unknown)=>{
   hooks.guard();await hooks.beforeRequest();await hooks.observe(200,null);return fixture.obs(endpoint,data);
  };
  return {...p,client:{getMatchSource:(id:string)=>id===raw.match_id?capture('/matches/'+id,raw):p.client.getMatchSource(id)},
   discover:(...args:Parameters<typeof playerHistoryQuery>)=>capture('/explorer?'+new URLSearchParams({sql:playerHistoryQuery(...args)}),{err:null,rows:args[0].includes('100')?[row]:[]})};
 };
 await captureRetestBatch(fixture.ctx,'targets',provider);await captureRetestBatch(fixture.ctx,'history',provider);
 const inputs=await fixture.prepare();expect(inputs.plan.historyConflictMapIds).toEqual([raw.match_id]);
 await executeRetestImportStep(inputs,database.db,'identities',join(fixture.root,'identities'),planRef);
 const result=await executeRetestImportStep(inputs,database.db,'maps',join(fixture.root,'maps'),planRef);
 expect(result.report.summary).toEqual({not_importable:1,accepted:2});
 expect(result.report.results.find((r:{matchId:string})=>r.matchId===raw.match_id)).toMatchObject({status:'not_importable',reasons:['HISTORY_DISCOVERY_CONFLICT']});
 expect((await sql`SELECT id::text FROM matches ORDER BY id`.execute(database.db)).rows).toEqual([{id:'100000001'},{id:'100000002'}]);
 expect((await sql`SELECT count(*)::int n FROM provider_ingest_receipts WHERE provider_match_id=${raw.match_id}`.execute(database.db)).rows[0]).toEqual({n:0});
 const series=await executeRetestImportStep(inputs,database.db,'series',join(fixture.root,'series'),planRef);
 expect(series.report.summary).toEqual({applied:1});expect((await sql`SELECT provider_series_id FROM series ORDER BY id`.execute(database.db)).rows).toEqual([{provider_series_id:'700'}]);expect(network).toBe(0);
},60000);
test('missing numeric proofs stay blocked without nickname matching or provider fallback',async()=>{
 fixture.sources.registry=fixture.obs('/proPlayers',[]);await fixture.close();const inputs=await fixture.prepare(),before=await snapshot();
 const result=await executeRetestImportStep(inputs,database.db,'identities',join(fixture.root,'missing-proof'),planRef);
 expect(result.report.summary).toEqual({blocked:10});expect(result.report.results.every((r:{reasons:string[]})=>r.reasons.includes('NUMERIC_PROOF_MISSING'))).toBe(true);
 expect(result.report.writesAttempted).toBe(false);expect(await snapshot()).toEqual(before);expect(network).toBe(0);
},60000);
test('per-map failure leaves receipts; a new output directory resumes the same plan idempotently',async()=>{
 await fixture.close();const inputs=await fixture.prepare();await executeRetestImportStep(inputs,database.db,'identities',join(fixture.root,'identities'),planRef);
 await sql`ALTER TABLE matches ADD CONSTRAINT synthetic_retest_failure CHECK(id<>100000002)`.execute(database.db);
 let writes=false;await expect(executeRetestImportStep(inputs,database.db,'maps',join(fixture.root,'interrupted'),planRef,{onWrite:()=>{writes=true;}})).rejects.toThrow();expect(writes).toBe(true);
 expect(JSON.parse(await readFile(join(fixture.root,'interrupted','map-100000001.json'),'utf8')).status).toBe('accepted');
 expect((await sql`SELECT count(*)::int n FROM matches`.execute(database.db)).rows[0]).toEqual({n:1});
 await sql`ALTER TABLE matches DROP CONSTRAINT synthetic_retest_failure`.execute(database.db);
 const replay=await executeRetestImportStep(inputs,database.db,'maps',join(fixture.root,'resumed'),planRef);
 expect(replay.report.results[0].duplicate).toBe(true);expect(replay.report.results[1].status).toBe('accepted');
 expect((await sql`SELECT count(*)::int n FROM matches`.execute(database.db)).rows[0]).toEqual({n:2});expect(network).toBe(0);
},60000);
test('accepted maps with absent team objects retain a blocked series instead of invented canonical references',async()=>{
 for(const raw of fixture.rawMaps){delete raw.radiant_team;delete raw.dire_team;}
 await fixture.close();const inputs=await fixture.prepare();await executeRetestImportStep(inputs,database.db,'identities',join(fixture.root,'identities'),planRef);
 expect((await executeRetestImportStep(inputs,database.db,'maps',join(fixture.root,'maps'),planRef)).report.summary).toEqual({accepted:2});
 const series=await executeRetestImportStep(inputs,database.db,'series',join(fixture.root,'series'),planRef);
 expect(series.report.summary).toEqual({blocked:1});expect(series.report.results[0].reasons).toContain('CANONICAL_REFERENCES_MISSING');
 expect((await sql`SELECT count(*)::int n FROM series`.execute(database.db)).rows[0]).toEqual({n:0});expect(network).toBe(0);
},60000);
