import {it,expect} from 'vitest';
import {PandaScoreClient,PandaScoreError} from '../src/pandascore/client.js';
import {PandaUpcomingSchema,PandaRostersSchema} from '../src/pandascore/schemas.js';
import {auditUpcomingTournament} from '../src/pandascore/audit.js';

// Synthetic provider-shaped examples; never live coverage or training data.
const start=Date.parse('2026-11-01T12:00:00Z'),token='synthetic-private-token';
const match=(id:number|string=10)=>({id,name:'Synthetic A vs B',status:'not_started',scheduled_at:'2026-11-02T12:00:00Z',
  tournament:{id:30,name:'Synthetic tournament'},league:{id:40,name:'Synthetic league'},videogame:{slug:'dota-2'},number_of_games:3,
  opponents:[{type:'Team',opponent:{id:50,name:'Synthetic A'}},{type:'Team',opponent:{id:60,name:'Synthetic B'}}]});
const roster=()=>({type:'Team',rosters:[50,60].map((id,i)=>({id,name:'Synthetic team',current_videogame:{slug:'dota-2'},
  players:Array.from({length:5},(_,j)=>({id:i*5+j+100,name:'Synthetic player',birthday:'private',first_name:'private',image_url:'private'}))}))});
const json=(value:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{status,headers});
function harness(responses:(Response|Error)[],options:{maxRequests?:number;maxWaitMs?:number}={}){
  let time=start;const calls:{url:string;init:RequestInit}[]=[],waits:number[]=[];
  const client=new PandaScoreClient({apiToken:token,...options},{now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;},fetch:async (url,init)=>{
    calls.push({url:url.href,init});const next=responses.shift();if(next instanceof Error)throw next;if(!next)throw new Error('unexpected synthetic request');return next;
  }});return {client,calls,waits,now:()=>time};
}
it('keeps provider bigint IDs and strips biography/assets; series size is not a map result',()=>{
  const m=PandaUpcomingSchema.parse([match('9007199254740993')])[0]!;
  expect(m.providerMatchId).toBe('9007199254740993');expect(m.seriesBestOf).toBe(3);
  expect(m.scheduledAt).toBe('2026-11-02T12:00:00.000Z');
  const r=PandaRostersSchema.parse(roster());expect(r).toHaveLength(2);expect(r[0]!.players).toHaveLength(5);
  expect(JSON.stringify(r)).not.toMatch(/birthday|private|image_url|first_name/);
});
it('preserves unknown times/names and TBD opponents without inventing a lineup',()=>{
  expect(PandaUpcomingSchema.parse([{...match(),name:null,scheduled_at:null,opponents:[]}])[0]).toMatchObject({name:null,scheduledAt:null,opponents:[]});
  const r=roster();r.rosters[0]!.players=[];expect(PandaRostersSchema.parse(r)[0]!.players).toEqual([]);
});
it('normalizes empty provider labels to unknown while retaining a nonempty full event name',()=>{
  const m=PandaUpcomingSchema.parse([{...match(),name:'  ',serie:{id:31,name:'',full_name:'Synthetic full event'}}])[0]!;
  expect(m.name).toBeNull();expect(m.eventSeries).toEqual({providerEventSeriesId:'31',name:'Synthetic full event'});
});
it('rejects unsafe IDs, duplicate matches/opponents/players/teams and the wrong game',()=>{
  expect(()=>PandaUpcomingSchema.parse([match(Number.MAX_SAFE_INTEGER+1)])).toThrow();
  expect(()=>PandaUpcomingSchema.parse([match(),match()])).toThrow();
  const m=match();m.opponents[1]!.opponent.id=50;expect(()=>PandaUpcomingSchema.parse([m])).toThrow();
  expect(()=>PandaUpcomingSchema.parse([{...match(),videogame:{slug:'league-of-legends'}}])).toThrow();
  const a=roster();a.rosters[1]!.players[0]!.id=100;expect(()=>PandaRostersSchema.parse(a)).toThrow();
  const b=roster();b.rosters[1]!.id=50;expect(()=>PandaRostersSchema.parse(b)).toThrow();
});
it('requires a server token and rejects header injection without exposing configuration',()=>{
  expect(()=>new PandaScoreClient({})).toThrowError(expect.objectContaining({code:'missing_api_token'}));
  expect(()=>new PandaScoreClient({apiToken:'x\r\nsecret'})).toThrowError(expect.objectContaining({code:'invalid_configuration'}));
});
it('uses a fixed API host, bearer header, bounded first page and redirect refusal',async()=>{
  const h=harness([json([match()],200,{'X-Rate-Limit-Remaining':'900'})]),r=await h.client.getUpcomingMatches();
  const c=h.calls[0]!;expect(c.url).toBe('https://api.pandascore.co/dota2/matches/upcoming?sort=scheduled_at,id&page=1&per_page=20');
  expect(c.init).toMatchObject({redirect:'error',headers:{Authorization:'Bearer '+token}});
  expect(r.source).toMatchObject({knownAt:null,rateLimitRemaining:900,attempts:1,payloadSha256:expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect(JSON.stringify(r)).not.toContain(token);
});
it('validates tournament IDs before requests and sends no user-supplied endpoint',()=>{
  const h=harness([]);expect(()=>h.client.getTournamentRosters('../secret?token=x')).toThrowError(expect.objectContaining({code:'invalid_id'}));
  expect(h.calls).toHaveLength(0);
});
it.each([401,403,302])('stops HTTP %s without retrying or disclosing an error body',async status=>{
  const h=harness([json({error:token},status)]);
  try{await h.client.getUpcomingMatches();throw new Error('expected failure');}catch(e){
    expect(e).toBeInstanceOf(PandaScoreError);expect(String(e)).not.toContain(token);expect((e as PandaScoreError).status).toBe(status);}
  expect(h.calls).toHaveLength(1);
});
it('honours Retry-After on 429 and preserves recovered HTTP attempts',async()=>{
  const h=harness([json({},429,{'Retry-After':'5'}),json([match()])]);await h.client.getUpcomingMatches();
  expect(h.waits).toEqual([5000]);expect(h.client.requestStats).toMatchObject({attempts:2,httpStatuses:{'429':1,'200':1}});
});
it('refuses a long cooldown and prevents another call from bypassing it',async()=>{
  const h=harness([json({},429,{'Retry-After':'120'})]);
  await expect(h.client.getUpcomingMatches()).rejects.toMatchObject({code:'source_rate_limited',retryAfterMs:120000});
  await expect(h.client.getUpcomingMatches()).rejects.toMatchObject({code:'source_rate_limited'});expect(h.calls).toHaveLength(1);
});
it('retries transient errors within the total run budget and sanitizes transport exceptions',async()=>{
  const h=harness([json({},503),json([match()])]);await h.client.getUpcomingMatches();expect(h.waits).toEqual([4000]);
  const n=harness([new Error('URL with '+token),new Error('URL with '+token)]);
  await expect(n.client.getUpcomingMatches()).rejects.toMatchObject({code:'source_network_error',message:expect.not.stringContaining(token)});
  expect(n.client.requestStats).toMatchObject({attempts:2,transportErrors:{source_network_error:2}});
  const b=harness([json([match()])],{maxRequests:1});await b.client.getUpcomingMatches();
  await expect(b.client.getTournamentRosters('30')).rejects.toMatchObject({code:'request_budget_exhausted'});expect(b.calls).toHaveLength(1);
});
it('bounds bytes and rejects invalid UTF-8/JSON/schema without automatic retry',async()=>{
  const values=[new Response('x'.repeat(2*1024*1024+1)),new Response('not-json'),new Response(new Uint8Array([0xff])),json({wrong:[]})];
  for(const response of values){const h=harness([response]);await expect(h.client.getUpcomingMatches()).rejects.toBeInstanceOf(PandaScoreError);expect(h.calls).toHaveLength(1);}
});
it('aborts a stalled request with a structured timeout',async()=>{
  const c=new PandaScoreClient({apiToken:token,timeoutMs:10,maxRequests:1},{fetch:async(_url,init)=>new Promise((_resolve,reject)=>{
    init.signal!.addEventListener('abort',()=>reject(new Error('secret '+token)),{once:true});
  })});
  // The first timed-out attempt exhausts the total request budget before a second request.
  await expect(c.getUpcomingMatches()).rejects.toMatchObject({code:'request_budget_exhausted'});
  expect(c.requestStats.transportErrors.source_timeout).toBe(1);
});
it('captures one future match and exact tournament rosters with two expected fives',async()=>{
  const h=harness([json([match()]),json(roster()),json({id:100,steam_id:null,birthday:'private'})]),r=await auditUpcomingTournament(h.client,{now:h.now});
  expect(h.calls[1]!.url).toBe('https://api.pandascore.co/tournaments/30/rosters');expect(r.captureStatus).toBe('complete');
  expect(r.coverage).toMatchObject({scheduleRows:1,tournamentRosterTeams:2,exactExpectedFives:2,expectedLineupReady:true,
    canonicalPlayersLinked:0,playerHistoryLinks:'requires_verified_provider_mapping',playerIdentityProfilesSampled:1});
  expect(r.teams.every(t=>t.matchAttendanceConfirmed===false)).toBe(true);expect(r.trainingExamples).toBe(0);
});
it('selects deterministically by future scheduled time and ID without using past/canceled/undated rows',async()=>{
  const rows=[{...match(1),status:'canceled'},{...match(2),scheduled_at:null},{...match(3),scheduled_at:'2026-10-31T12:00:00Z'},match(20),match(10)];
  const h=harness([json(rows),json(roster()),json({id:100})]),r=await auditUpcomingTournament(h.client,{now:h.now});expect(r.selectedMatch!.providerMatchId).toBe('10');
});
it('does not choose five players from six or synthesize missing rosters',async()=>{
  const body=roster();body.rosters[0]!.players.push({id:999,name:'Substitute',birthday:'private',first_name:'private',image_url:'private'});body.rosters.pop();
  const h=harness([json([match()]),json(body),json({id:100})]),r=await auditUpcomingTournament(h.client,{now:h.now});
  expect(r.teams.map(t=>t.rosterStatus)).toEqual(['requires_manual_selection','missing']);expect(r.teams[1]!.players).toBeNull();
  expect(r.coverage.expectedLineupReady).toBe(false);expect(r.teams[0]!.players).toHaveLength(6);
});
it('empty page or absent requested tournament yields unknown readiness and no extra request',async()=>{
  for(const rows of [[],[match()]]){const h=harness([json(rows)]),r=await auditUpcomingTournament(h.client,{now:h.now,tournamentId:'99'});
    expect(r.captureStatus).toBe('no_future_match_in_page');expect(r.coverage.exactExpectedFives).toBeNull();expect(h.calls).toHaveLength(1);}
});
it('preserves schedule on roster failure and never counts HTTP coverage as lineup verification',async()=>{
  const h=harness([json([match()]),json({error:token},403)]),r=await auditUpcomingTournament(h.client,{now:h.now});
  expect(r.captureStatus).toBe('blocked_or_partial');expect(r.schedule!.data).toHaveLength(1);
  expect(r.rosters).toBeNull();expect(r.coverage.exactExpectedFives).toBeNull();expect(r.errors[0]!.code).toBe('source_forbidden');
  expect(JSON.stringify(r)).not.toContain(token);expect(r.databaseWrites).toBe(0);
});
it('inventories identifier paths without copying personal fields or interpreting provider IDs as Steam IDs',async()=>{
  const h=harness([json({id:100,steam_id:'76561197960265828',current_team:{id:50},birthday:'private',email:'private'})]);
  const p=await h.client.getPlayerIdentifierInventory('100');
  expect(p.data).toMatchObject({providerPlayerId:'100',canonicalPlayerId:null,steamAccountId:null,scope:'field_inventory_only'});
  expect(p.data.identifierFields).toEqual([{path:'current_team.id',type:'number'},{path:'id',type:'number'},{path:'steam_id',type:'string'}]);
  expect(JSON.stringify(p)).not.toMatch(/private|76561197960265828|birthday|email/);
});
it('rejects a profile ID mismatch and preserves independently captured schedule and rosters',async()=>{
  const h=harness([json([match()]),json(roster()),json({id:101})]),r=await auditUpcomingTournament(h.client,{now:h.now});
  expect(r.errors[0]!.code).toBe('source_id_mismatch');expect(r.identityProbe).toBeNull();expect(r.rosters!.data).toHaveLength(2);
  expect(r.captureStatus).toBe('blocked_or_partial');
});
it('consults the durable budget for every attempt and records every HTTP response',async()=>{
  let time=start,n=0,claims=0;const observations:number[]=[];
  const c=new PandaScoreClient({apiToken:token},{now:()=>time,sleep:async ms=>{time+=ms;},
    budget:{beforeRequest:async()=>{claims++;},observe:async status=>{observations.push(status);}},
    fetch:async()=>++n===1?json({},503):json([match()])});
  await c.getUpcomingMatches();expect(claims).toBe(2);expect(observations).toEqual([503,200]);
});
it('a durable quota denial stops before exposing the token or sending HTTP',async()=>{
  let calls=0;const c=new PandaScoreClient({apiToken:token},{budget:{beforeRequest:async()=>{throw new PandaScoreError('source_rate_limited',null,null,3600000);},observe:async()=>{}},
    fetch:async()=>{calls++;return json([]);}});
  await expect(c.getUpcomingMatches()).rejects.toMatchObject({code:'source_rate_limited',retryAfterMs:3600000});expect(calls).toBe(0);expect(c.requestStats.attempts).toBe(0);
});
