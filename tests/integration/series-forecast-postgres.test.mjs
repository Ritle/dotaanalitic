import {afterAll,beforeAll,expect,test} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {testDatabase} from '../helpers/postgres.ts';
import {publishTargetSchedule,syntheticTargetMatch} from '../helpers/schedule-target.ts';
import {rehearsalInput} from '../fixtures/series-forecast-rehearsal.mjs';
import {editionHttpComparison} from '../fixtures/bo3-edition-http-comparison.mjs';
import {captureScheduledRehearsal,reviewRehearsalTiming,reviewRehearsalSample} from '../../tools/research/series-forecast-postgres.mjs';
import {reviewEditionCoverage} from '../../tools/research/series-edition-coverage.mjs';
import {sql} from '../../packages/db/dist/index.js';
import {registrySha} from '../../packages/db/dist/v1-registry.js';

let database,db;
beforeAll(async()=>{
  database=await testDatabase(); db=database.db;
  const ddl=await readFile(new URL('../../tools/research/series-forecast-postgres.sql',import.meta.url),'utf8');
  await db.transaction().execute(tx=>sql.raw(ddl).execute(tx));
},60000);
afterAll(async()=>{await database?.close();});

async function setup(id,age=1000,editionId='8') {
  const {now}=(await sql`SELECT clock_timestamp() AS now`.execute(db)).rows[0];
  const fetched=new Date(now.valueOf()-age).toISOString();
  const match=syntheticTargetMatch({providerMatchId:id,scheduledAt:new Date(now.valueOf()+3600000).toISOString(),
    eventSeries:{providerEventSeriesId:editionId,name:'Synthetic edition'}});
  const observation=await publishTargetSchedule(db,[match],fetched);
  const {cutoff}=(await sql`SELECT (extract(epoch FROM clock_timestamp())*1000000)::bigint::text AS cutoff`.execute(db)).rows[0];
  const input=rehearsalInput();
  Object.assign(input.target,{editionId,seriesId:id,scheduledAt:match.scheduledAt,scheduleObservedAt:fetched});
  input.scenario.cutoffAtUs=cutoff;
  return {input,match,binding:{snapshotSha256:observation.sha,providerTeamAId:'74',providerTeamBId:'75'}};
}
async function result(match,start,edition=match.eventSeries.providerEventSeriesId) {
  const t=Date.parse(start),at=ms=>new Date(t+ms).toISOString(),id=match.providerMatchId;
  const game=(n,begin,end)=>({id:String(100+n),match_id:id,position:n,status:'finished',finished:true,
    forfeit:false,begin_at:begin,end_at:end,winner:{type:'Team',id:'74'}});
  const data={id,name:'Synthetic BO3',status:'finished',videogame:{slug:'dota-2'},number_of_games:3,
    match_type:'best_of',forfeit:false,draw:false,game_advantage:null,begin_at:at(-5000),end_at:at(20),
    league_id:'72',serie_id:edition,tournament_id:'71',opponents:['75','74'].map(id=>({type:'Team',opponent:{id,name:null}})),
    winner_type:'Team',winner_id:'74',results:[{team_id:'74',score:2},{team_id:'75',score:0}],
    games:[game(2,at(12),at(20)),game(1,start,at(10))]};
  await sql`SELECT pg_sleep_until(${at(21)}::timestamptz)`.execute(db);
  const source={provider:'pandascore',endpoint:'/matches/'+id,adapterVersion:'synthetic-bo3-result-test',
    fetchedAt:at(21),payloadSha256:registrySha(JSON.stringify(data))};
  const text=JSON.stringify({source,data});
  await sql`INSERT INTO journal_provider_result_receipts(provider_match_id,observation_text,observation_sha256,terminal)
    VALUES(${id},${text},${registrySha(text)},true)`.execute(db);
}
test('one immutable receipt under concurrent calls; replays after a schedule change and conflicts on changed inputs',async()=>{
  const {input,binding,match}=await setup('1001');
  const capture=()=>captureScheduledRehearsal(db,input,binding);
  const [a,b]=await Promise.all([capture(),capture()]);
  expect(a).toEqual(b);
  await publishTargetSchedule(db,[{...match,status:'running'}]);
  expect(await capture()).toEqual(a);
  await expect(captureScheduledRehearsal(db,input,{...binding,providerTeamAId:'77'})).rejects.toThrow('conflicting');
  await expect(sql`UPDATE bo3_rehearsal.forecasts SET request_sha='changed'`.execute(db)).rejects.toThrow('Immutable');
  await expect(sql`TRUNCATE bo3_rehearsal.commit_witnesses`.execute(db)).rejects.toThrow('Immutable');
  expect(await reviewRehearsalTiming(db,'1001')).toBe('FIRST_MAP_START_UNCONFIRMED');
  await result(match,new Date(Date.parse(a.committedBy)+3).toISOString());
  expect(await reviewRehearsalTiming(db,'1001')).toBe('BEFORE_FIRST_MAP');
});
test('earlier or equal actual game-one start excludes the forecast; played series must match the edition',async()=>{
  const {input,binding,match}=await setup('1002');
  const a=await captureScheduledRehearsal(db,input,binding);
  await result(match,new Date(Date.parse(a.committedBy)-50).toISOString());
  expect(await reviewRehearsalTiming(db,'1002')).toBe('NOT_BEFORE_FIRST_MAP');
  await result(match,a.committedBy);
  expect(await reviewRehearsalTiming(db,'1002')).toBe('NOT_BEFORE_FIRST_MAP');
  const sample=await reviewRehearsalSample(db);
  expect(sample.beforeFirstMap).not.toContain('1002');
  expect(sample.exclusions).toContainEqual({id:'1002',reason:'NOT_BEFORE_FIRST_MAP'});
  expect(sample.observedForecasts).toBe(sample.beforeFirstMap.length+sample.exclusions.length);
  await result(match,a.committedBy,'9');
  expect(await reviewRehearsalTiming(db,'1002')).toBe('RESULT_SCOPE_CHANGED');
});
test('stale source, changed edition, clock or digest fail before insertion; unavailable stays in denominator',async()=>{
  const stale=await setup('1003',301000);
  await expect(captureScheduledRehearsal(db,stale.input,stale.binding)).rejects.toThrow('STALE');
  const {input,binding}=await setup('1004');
  for (const patch of [{editionId:'9'},{scheduledAt:'2099-02-01T00:00:00.000Z'}]) {
    await expect(captureScheduledRehearsal(db,{...input,target:{...input.target,...patch}},binding)).rejects.toThrow('mismatch');
  }
  await expect(captureScheduledRehearsal(db,input,{...binding,snapshotSha256:'a'.repeat(64)})).rejects.toThrow('revision');
  input.history.maps=[];
  await captureScheduledRehearsal(db,input,binding);
  expect(await reviewRehearsalTiming(db,'1004')).toBe('FORECAST_UNAVAILABLE');
});
test('interruption after the first commit cannot backdate a recovered receipt',async()=>{
  const {input,binding,match}=await setup('1005');
  await sql`CREATE TRIGGER interrupt_witness BEFORE INSERT ON bo3_rehearsal.commit_witnesses
    FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable()`.execute(db);
  try {await expect(captureScheduledRehearsal(db,input,binding)).rejects.toThrow('Immutable');}
  finally {await sql`DROP TRIGGER interrupt_witness ON bo3_rehearsal.commit_witnesses`.execute(db);}
  expect(await reviewRehearsalTiming(db,'1005')).toBe('NO_COMMIT_WITNESS');
  const {start}=(await sql`SELECT clock_timestamp() AS start`.execute(db)).rows[0];
  await result(match,start.toISOString());
  await captureScheduledRehearsal(db,input,binding);
  expect(await reviewRehearsalTiming(db,'1005')).toBe('NOT_BEFORE_FIRST_MAP');
});

test('whole-edition CLI counts played BO3 and suppresses coverage when two HTTP passes disagree',async({onTestFinished})=>{
  const fixture=fileURLToPath(new URL('../fixtures/bo3-edition-inventory.json',import.meta.url));
  const digest='a4dfc2c9036c485c82cc8bdb37be4666f0e0d3dbe0e4d26e364028a6c3221d35';
  const text=await readFile(fixture,'utf8');
  const initial=await reviewEditionCoverage(db,text,digest);
  expect(initial).toMatchObject({denominator:4,timely:0,coverage:0});
  expect(initial.played.every(m=>m.timing==='NO_FORECAST_ATTEMPT')).toBe(true);
  for (const id of ['8801','8802','8803','8901']) {
    const {input,binding,match}=await setup(id,1000,id==='8901'?'881':'880');
    if(id==='8803') input.history.maps=[];
    const receipt=await captureScheduledRehearsal(db,input,binding);
    if(id==='8801' || id==='8802') {
      const delta=id==='8801'?3:-50;
      await result(match,new Date(Date.parse(receipt.committedBy)+delta).toISOString());
    }
  }
  const cli=fileURLToPath(new URL('../../tools/research/series-edition-coverage.mjs',import.meta.url));
  const report=JSON.parse(execFileSync(process.execPath,[cli,fixture,digest],{
    env:{...process.env,DATABASE_URL:database.url},encoding:'utf8',timeout:15000
  }));
  expect(report).toMatchObject({denominatorComplete:true,denominator:4,timely:1,coverage:0.25,
    journalOnly:[],unresolved:[],played:[
      {matchId:'8801',timing:'BEFORE_FIRST_MAP'}, {matchId:'8802',timing:'NOT_BEFORE_FIRST_MAP'},
      {matchId:'8803',timing:'FORECAST_UNAVAILABLE'}, {matchId:'8804',timing:'NO_FORECAST_ATTEMPT'}
    ],outside:[{matchId:'8805',reason:'OTHER_FORMAT'},{matchId:'8806',reason:'CANCELLED'}]});
  const inventory=JSON.parse(text);
  const pagesPath=fileURLToPath(new URL('../fixtures/bo3-edition-pages.json',import.meta.url));
  const pagesSha='5fd9841fde21509a9e5f54d66cd492a6a87b2f4707de417332e26b4fbfebab31';
  const paged=JSON.parse(execFileSync(process.execPath,[cli,pagesPath,pagesSha],{
    env:{...process.env,DATABASE_URL:database.url},encoding:'utf8',timeout:15000
  }));
  expect(paged).toEqual({...report,inventorySha256:registrySha(JSON.stringify(inventory)),pagesSha256:pagesSha,pageIssues:[]});
  const http=editionHttpComparison();
  const reviewHttp=()=>{
    const raw=JSON.stringify(http);
    return reviewEditionCoverage(db,raw,registrySha(raw));
  };
  expect(await reviewHttp()).toMatchObject({denominator:4,timely:1,coverage:0.25});
  http.passes[1][1].body[1].id='8807';
  const directory=await mkdtemp(join(tmpdir(),'bo3-compare-'));
  onTestFinished(()=>rm(directory,{recursive:true,force:true}));
  const httpPath=join(directory,'comparison.json');
  const httpText=JSON.stringify(http);
  const digestHttp=registrySha(httpText);
  await writeFile(httpPath,httpText);
  const comparison=JSON.parse(execFileSync(process.execPath,[cli,httpPath,digestHttp],{
    env:{...process.env,DATABASE_URL:database.url},encoding:'utf8',timeout:15000
  }));
  expect(comparison).toMatchObject({comparisonSha256:digestHttp,sourceComplete:false,denominator:null,coverage:null,journalOnly:[],
    comparison:{passes:[{total:6,issues:[]},{total:6,issues:[]}],firstOnly:['8804'],secondOnly:['8807']}});
  const pages=JSON.parse(await readFile(pagesPath,'utf8'));
  for(const [modify,code] of [
    [p=>p.splice(1,1),'MISSING_PAGES'],
    [p=>{p[1].matches[0].id='8801';},'DUPLICATE_MATCH'],
    [p=>{p[2].matches[0].serie_id='881';},'OUTSIDE_SCOPE']
  ]) {
    const changed=structuredClone(pages);
    modify(changed.pages);
    const raw=JSON.stringify(changed);
    const incomplete=await reviewEditionCoverage(db,raw,registrySha(raw));
    expect(incomplete).toMatchObject({denominator:null,coverage:null,pageIssues:[{code}]});
  }
  const review=async rows=>{
    const source=JSON.stringify({...inventory,matches:rows});
    return reviewEditionCoverage(db,source,registrySha(source));
  };
  const wrongStage=await review(inventory.matches.map(m=>m.matchId==='8801'?{...m,stageId:'73'}:m));
  expect(wrongStage).toMatchObject({timely:0,denominator:4,coverage:0});
  expect(wrongStage.played[0].timing).toBe('FORECAST_SCOPE_MISMATCH');
  const omitted=await review(inventory.matches.slice(1));
  expect(omitted).toMatchObject({journalOnly:['8801'],denominatorComplete:false,denominator:null,coverage:null});
});

test('unknown scope never yields a percentage; complete empty editions have zero denominator',async()=>{
  const manifest={format:'synthetic-edition-inventory-v1',leagueId:'72',editionId:'889',complete:true,matches:[]};
  const review=async patch=>{
    const text=JSON.stringify({...manifest,...patch});
    return reviewEditionCoverage(db,text,registrySha(text));
  };
  expect(await review({})).toMatchObject({denominatorComplete:true,denominator:0,timely:0,coverage:null});
  expect(await review({complete:false})).toMatchObject({denominatorComplete:false,denominator:null,coverage:null});
  const row={matchId:'8891',stageId:'73',bestOf:3,status:'unknown'};
  for (const unresolved of [row,{...row,bestOf:null,status:'played'}]) {
    expect(await review({matches:[unresolved]})).toMatchObject({denominatorComplete:false,coverage:null,unresolved:['8891']});
  }
  await expect(review({matches:[row,{...row,stageId:'71'}]})).rejects.toThrow('duplicate');
  await expect(reviewEditionCoverage(db,JSON.stringify(manifest),'0'.repeat(64))).rejects.toThrow('digest');
});
