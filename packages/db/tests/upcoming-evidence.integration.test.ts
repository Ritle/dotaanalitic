import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,test,expect} from 'vitest';
import {sql} from '../src/index.js';
import {UpcomingEvidenceRepository} from '../src/upcoming-evidence.js';
import {testDatabase} from '../../../tests/helpers/postgres.js';

// Synthetic normalized observations, confined to disposable databases.
let database:Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async()=>{database=await testDatabase();},30000);
afterEach(async()=>{await database?.close();},30000);
const at=(s:number)=>`2025-01-01T00:00:${String(s).padStart(2,'0')}.000Z`;
const matchId='9007199254740993';
const endpoint=(key:string)=>key==='schedule'?'/dota2/matches/upcoming?sort=scheduled_at,id&page=1&per_page=20':
  `/tournaments/${key.slice(11)}/rosters`;
const match=(tournament='71')=>({providerMatchId:matchId,name:'Synthetic fixture',status:'not_started',scheduledAt:'2025-01-02T19:00:00.000Z',
  tournament:{providerTournamentId:tournament,name:null},league:{providerLeagueId:'72',name:null},eventSeries:null,seriesBestOf:3,
  opponents:[{providerTeamId:'74',name:'Synthetic A'},{providerTeamId:'75',name:'Synthetic B'}]});
const rosters=()=>['74','75','76'].map((id,i)=>({providerTeamId:id,name:null,
  players:Array.from({length:i===0?6:5},(_,j)=>({providerPlayerId:String(100+i*10+j),name:null}))}));
async function insert(key:string,data:unknown[],recordedAt:string,options:{fetchedAt?:string;badHash?:boolean;wrongEndpoint?:boolean}={}){
  const fetchedAt=options.fetchedAt??at(1);
  const snapshot={data,source:{provider:'pandascore',adapterVersion:'synthetic-evidence-test',endpoint:options.wrongEndpoint?endpoint('tournament:99'):endpoint(key),
    fetchedAt,knownAt:null,payloadSha256:'a'.repeat(64),attempts:1,rateLimitRemaining:null}};
  const text=JSON.stringify(snapshot),digest=createHash('sha256').update(text).digest('hex');
  await sql`INSERT INTO upcoming_source_observations(cache_key,provider,source_endpoint,source_payload_sha256,
    source_fetched_at,recorded_at,snapshot_sha256,snapshot_text)
    VALUES (${key},'pandascore',${endpoint(key)},${snapshot.source.payloadSha256},${fetchedAt},${recordedAt},
      ${options.badHash?'0'.repeat(64):digest},${text})`.execute(database.db);
}
const read=(cutoffAt=at(30))=>new UpcomingEvidenceRepository(database.db).readAsOf({providerMatchId:matchId,cutoffAt});

test('strict recorded-at cutoff, exact source hashes, BIGINT IDs and six-player registration survive read-only replay',async()=>{
  await insert('schedule',[match()],at(10));await insert('tournament:71',rosters(),at(15));
  expect(await read(at(10))).toMatchObject({status:'unavailable',reasons:['schedule_not_observed'],schedule:null});
  expect(await read(at(15))).toMatchObject({status:'partial',reasons:['roster_not_observed'],roster:null});
  const result=await read(at(16));
  expect(result).toMatchObject({status:'observed',reasons:[],schedule:{match:{providerMatchId:matchId}},
    mapBinding:'not_assessed',lineupVerification:'not_assessed',trainingReady:false,deployable:false});
  expect(result.roster!.teams.map(t=>t.players.length)).toEqual([6,5]);
  expect(result.schedule!.observation.recordedAt).toBe('2025-01-01T00:00:10.000000Z');
  expect(await read(at(16))).toEqual(result);
  expect((await sql`SELECT (SELECT count(*)::int FROM matches) AS maps,
    (SELECT count(*)::int FROM upcoming_source_observations) AS observations`.execute(database.db)).rows[0]).toEqual({maps:0,observations:2});
});

test('late recording is not backdated to fetch or scheduled time; partial pages do not imply cancellation',async()=>{
  await insert('schedule',[match()],at(10));await insert('tournament:71',rosters(),at(20),{fetchedAt:at(2)});
  expect((await read(at(19))).roster).toBeNull();
  await insert('schedule',[],at(25));
  const result=await read();
  expect(result).toMatchObject({status:'observed',laterSchedulePagesOmittingMatch:1,schedule:{match:{status:'not_started'}}});
  expect(result.schedule!.observation.recordedAt).toBe('2025-01-01T00:00:10.000000Z');
});

test('new tournament uses its own latest roster and a removed opponent never falls back to an older roster',async()=>{
  await insert('schedule',[match()],at(5));await insert('tournament:71',rosters(),at(6));
  await insert('schedule',[match('81')],at(10));
  expect(await read()).toMatchObject({status:'partial',reasons:['roster_not_observed'],roster:null});
  await insert('tournament:81',rosters(),at(15));
  await insert('tournament:81',rosters().slice(1),at(20));
  const result=await read();
  expect(result).toMatchObject({status:'partial',reasons:['opponent_roster_missing']});
  expect(result.roster!.teams.map(t=>t.providerTeamId)).toEqual(['75']);
});

test.each(['hash','endpoint','duplicate_match'] as const)('invalid newest schedule (%s) fails closed without selecting older evidence',async kind=>{
  await insert('schedule',[match()],at(5));
  await insert('schedule',kind==='duplicate_match'?[match(),match()]:[match()],at(10),{badHash:kind==='hash',wrongEndpoint:kind==='endpoint'});
  await expect(read()).rejects.toMatchObject({code:'invalid_observation'});
});

test('missing opponents and duplicate player registrations remain unusable for a map lineup',async()=>{
  await insert('schedule',[{...match(),opponents:[]}],at(5));
  expect(await read()).toMatchObject({status:'partial',reasons:['opponents_incomplete','roster_not_observed']});
  await insert('schedule',[match()],at(10));
  const teams=rosters();teams[1]!.players[0]!.providerPlayerId=teams[0]!.players[0]!.providerPlayerId;
  await insert('tournament:71',teams,at(15));
  expect(await read()).toMatchObject({status:'partial',reasons:['roster_player_conflict'],lineupVerification:'not_assessed'});
});

test('invalid requests and future cutoffs are rejected',async()=>{
  await expect(new UpcomingEvidenceRepository(database.db).readAsOf({providerMatchId:9007199254740993,cutoffAt:at(30)})).rejects.toThrow();
  await expect(new UpcomingEvidenceRepository(database.db).readAsOf({providerMatchId:matchId,cutoffAt:'2999-01-01T00:00:00.000Z'}))
    .rejects.toMatchObject({code:'future_cutoff'});
});

test('invalid newest roster fails closed and does not restore the earlier registration',async()=>{
  await insert('schedule',[match()],at(5));await insert('tournament:71',rosters(),at(10));
  const teams=rosters();teams[0]!.players.push(teams[0]!.players[0]!);
  await insert('tournament:71',teams,at(20));
  await expect(read()).rejects.toMatchObject({code:'invalid_observation'});
});

test('bounded schedule history explicitly reports incomplete search instead of claiming no evidence exists',async()=>{
  await insert('schedule',[match()],at(5));await insert('schedule',[],at(10));
  await sql`INSERT INTO upcoming_source_observations(cache_key,provider,source_endpoint,source_payload_sha256,
    source_fetched_at,recorded_at,snapshot_sha256,snapshot_text)
    SELECT cache_key,provider,source_endpoint,source_payload_sha256,source_fetched_at,recorded_at,snapshot_sha256,snapshot_text
    FROM upcoming_source_observations CROSS JOIN generate_series(1,199) WHERE recorded_at=${at(10)}::timestamptz`.execute(database.db);
  expect(await read()).toMatchObject({status:'unavailable',reasons:['schedule_history_limit'],scheduleRowsExamined:200,schedule:null});
});

test('CLI exports a reproducible report and refuses to overwrite it',async()=>{
  await insert('schedule',[match()],at(5));await insert('tournament:71',rosters(),at(10));
  const path=join(tmpdir(),`upcoming-evidence-${randomUUID()}.json`);
  const args=['scripts/read-upcoming-evidence.mjs',matchId,at(30),path];
  const options={env:{...process.env,DATABASE_URL:database.url},encoding:'utf8' as const,stdio:'pipe' as const};
  try {
    const output=JSON.parse(execFileSync(process.execPath,args,options));
    expect(output).toMatchObject({status:'observed',trainingReady:false,deployable:false});
    const content=await readFile(path,'utf8');expect(JSON.parse(content)).toEqual(await read());
    expect(()=>execFileSync(process.execPath,args,options)).toThrow();
    expect(await readFile(path,'utf8')).toBe(content);
  }finally{await unlink(path).catch(()=>{});}
});
