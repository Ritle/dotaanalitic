import {randomBytes} from 'node:crypto';
import {afterAll,beforeAll,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {ProMapReportSchema} from '@dota/contracts';
import {IdentityRepository,sql} from '@dota/db';
import {IngestionService,OpenDotaClient} from '@dota/ingestion';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';

// Synthetic source responses, isolated DB and real HTTP handlers; no provider traffic.
let fixture:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string;
beforeAll(async()=>{
  fixture=await testDatabase();const password=randomBytes(24).toString('hex');
  await new AuthService(fixture.db).provision('synthetic-conflict-owner',password);
  app=await buildApp(readConfig({DATABASE_URL:fixture.url}),{db:fixture.db,logger:false});
  const r=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},
    payload:{login:'synthetic-conflict-owner',password}});
  const c=r.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c??'']).map(v=>v.split(';')[0]).join('; ');
},60000);
afterAll(async()=>{await app?.close();await fixture?.close();},30000);
const base=(id:string,team=3101)=>({match_id:id,start_time:1700000000,duration:1800,radiant_win:false,leagueid:77,series_id:901,
  radiant_team_id:team,dire_team_id:team+1,radiant_team:{team_id:team,name:'Synthetic A'},dire_team:{team_id:team+1,name:'Synthetic B'},
  players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:128+i-5,hero_id:i+1,account_id:100001+i})),picks_bans:null as unknown});
async function ingest(payload:ReturnType<typeof base>){
  let clock=Date.parse('2026-11-02T00:00:00Z');
  const client=new OpenDotaClient({}, {now:()=>clock,sleep:async ms=>{clock+=ms;},fetch:async url=>new Response(JSON.stringify(
    url.pathname==='/api/heroes'?Array.from({length:20},(_,i)=>({id:i+1,name:`synthetic_${i+1}`,localized_name:`Synthetic ${i+1}`})):
    url.pathname==='/api/leagues'?[{leagueid:77,name:'Synthetic league',tier:'professional'}]:payload))});
  return new IngestionService(fixture.db,client).ingest(payload.match_id);
}
async function report(kind:'teams'|'players',id:string){
  const r=await app.inject({url:`/api/v1/${kind}/${id}/matches?cutoffAt=2024-01-01T00%3A00%3A00.000Z`,headers:{cookie}});
  expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('no-store');
  return ProMapReportSchema.parse(r.json());
}
async function canonical(id:string){return (await sql`SELECT started_at,radiant_win,duration_seconds,radiant_team_id,dire_team_id,league_id,series_id,
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY player_slot) FROM match_players p WHERE p.match_id=m.id) AS players FROM matches m WHERE id=${id}`.execute(fixture.db)).rows[0];}
async function evidence(id:string){return (await sql`SELECT
  (SELECT count(*)::int FROM match_source_snapshots WHERE match_id=${id}) snapshots,
  (SELECT count(*)::int FROM provider_ingest_receipts WHERE canonical_match_id=${id}) receipts,
  (SELECT count(*)::int FROM match_field_observations WHERE match_id=${id}) facts,
  (SELECT count(*)::int FROM match_quality_assessments WHERE match_id=${id}) assessments`.execute(fixture.db)).rows[0]!;}

test.each(['winner','duration','hero','account','series','organization'] as const)('%s contradiction retains facts, excludes the map and survives exact replay',async(kind)=>{
  const index=['winner','duration','hero','account','series','organization'].indexOf(kind);
  const payload=base(String(900001000001+index),3101+index*2);await ingest(payload);
  const team=(await sql<{id:string}>`SELECT id FROM teams WHERE opendota_team_id=${payload.radiant_team_id}`.execute(fixture.db)).rows[0]!.id;
  expect((await report('teams',team)).summary.nRaw).toBe(1);const frozen=await canonical(payload.match_id);
  const changed=structuredClone(payload);
  if(kind==='winner')changed.radiant_win=true;
  if(kind==='duration')changed.duration=1900;
  if(kind==='hero'){changed.players[0]!.hero_id=2;changed.players[1]!.hero_id=1;}
  if(kind==='account')changed.players[0]!.account_id=999001;
  if(kind==='series')changed.series_id=902;
  if(kind==='organization'){changed.radiant_team_id=9901;changed.radiant_team={team_id:9901,name:'Synthetic correction'};}
  const result=await ingest(changed);expect(result.status).toBe('conflict');
  expect(await canonical(payload.match_id)).toEqual(frozen);
  const r=await report('teams',team);expect(r).toMatchObject({status:'insufficient_data',summary:{nRaw:0,winRate:null}});
  // Import quarantine clears is_pro. Legacy mutually exclusive counters classify this as unknown pro first.
  expect(r.coverage).toMatchObject({candidates:1,unknownPro:1,conflict:0});
  expect(r.warnings).toContain('NO_ELIGIBLE_PRO_MAPS');
  const receipts=(await sql<{reasons:string[];known_at:null}>`SELECT reasons,known_at FROM provider_ingest_receipts WHERE id=${result.receiptId}`.execute(fixture.db)).rows[0]!;
  expect(receipts.reasons.some(reason=>reason.startsWith('CONFLICT:'))).toBe(true);expect(receipts.known_at).toBeNull();
  const archived=await evidence(payload.match_id);expect(archived.snapshots).toBe(2);
  expect(await ingest(changed)).toMatchObject({status:'conflict',duplicate:true,dataRevision:result.dataRevision});
  expect((await ingest(payload)).status).toBe('conflict');
  expect(await evidence(payload.match_id)).toEqual(archived);expect(await canonical(payload.match_id)).toEqual(frozen);
});

test('new cross-provider identity conflict excludes both player reports before and after reimport without choosing an owner',async()=>{
  await sql`INSERT INTO players(id,nickname) VALUES (80001,'Synthetic shared alias'),(80002,'Synthetic shared alias')`.execute(fixture.db);
  const repo=new IdentityRepository(fixture.db),proof={playerId:'80001',provider:'opendota' as const,externalAccountId:'880001',status:'verified' as const,
    eventAt:null,knownAt:null,fetchedAt:'2026-11-02T00:00:00.000Z',evidenceRef:'synthetic:account-proof',source:'synthetic'};
  await repo.appendAccountEvidence(proof);const payload=base('900001000020',3201);payload.players[0]!.account_id=880001;
  await ingest(payload);expect((await report('players','80001')).summary.nRaw).toBe(1);
  const old=await canonical(payload.match_id);
  const conflict=await repo.appendAccountEvidence({...proof,provider:'stratz',playerId:'80002',evidenceRef:'synthetic:contradiction'});
  expect(conflict.resolution).toMatchObject({status:'conflict',playerId:null});
  for(const id of ['80001','80002'])expect(await report('players',id)).toMatchObject({summary:{nRaw:0,winRate:null},coverage:{identityUnresolved:1}});
  await ingest(payload);expect(await canonical(payload.match_id)).toEqual(old);
  for(const id of ['80001','80002'])expect((await report('players',id)).summary.nRaw).toBe(0);
  const counts=await evidence(payload.match_id);expect((await ingest(payload)).duplicate).toBe(true);expect(await evidence(payload.match_id)).toEqual(counts);
});

test('contradictory draft events stay separate from ten final heroes and never become verified draft actions',async()=>{
  const payload=base('900001000030',3301);payload.picks_bans=[{is_pick:true,hero_id:1,team:0,order:0}];
  await ingest(payload);const old=await canonical(payload.match_id);
  const changed={...payload,picks_bans:[{is_pick:true,hero_id:19,team:1,order:0}]};
  await ingest(changed);expect(await canonical(payload.match_id)).toEqual(old);
  const drafts=(await sql<{raw_picks_bans:unknown}>`SELECT raw_picks_bans FROM match_draft_source_observations WHERE match_id=${payload.match_id} ORDER BY id`.execute(fixture.db)).rows;
  expect(drafts.map(d=>d.raw_picks_bans)).toEqual([payload.picks_bans,changed.picks_bans]);
  expect((await sql`SELECT count(*)::int AS n FROM match_draft_actions WHERE match_id=${payload.match_id}`.execute(fixture.db)).rows[0]).toEqual({n:0});
  const team=(await sql<{id:string}>`SELECT id FROM teams WHERE opendota_team_id=3301`.execute(fixture.db)).rows[0]!.id;
  expect(await report('teams',team)).toMatchObject({summary:{nRaw:1,winRate:0},predictionEligibility:'not_assessed',model:null});
});
