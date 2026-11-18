import {test,expect,vi} from 'vitest';
import {assessPandaResult,type ResultTarget} from '../src/modules/scenarios/journal-result-contract';
import {PandaScoreResultClient} from '../src/modules/scenarios/journal-result-provider';
const target:ResultTarget={providerMatchId:'1',teamA:'10',teamB:'20',probability:.7,createdAt:'2026-01-01T10:00:00.000000Z',issuedAt:'2026-01-01T10:00:01.000000Z',cutoffAt:'2026-01-01T10:00:00.000Z'};
const source={fetchedAt:'2026-01-02T00:00:00.000Z',payloadSha256:'a'.repeat(64)};
const match=()=>({id:1,name:'Synthetic A — B',status:'finished',videogame:{slug:'dota-2'},forfeit:false,winner_id:10,
 opponents:[{type:'Team',opponent:{id:20,name:'B'}},{type:'Team',opponent:{id:10,name:'A'}}],
 games:[{id:200,match_id:1,position:2,status:'finished',finished:true,forfeit:false,begin_at:'2026-01-01T12:00:00Z',end_at:'2026-01-01T13:00:00Z',winner:{id:10,type:'Team'}},
 {id:100,match_id:1,position:1,status:'finished',finished:true,forfeit:false,begin_at:'2026-01-01T11:00:00Z',end_at:'2026-01-01T11:50:00Z',winner:{id:20,type:'Team'}}]});
test('first-map winner is independent of series winner, game array order and opponent order',()=>{
 expect(assessPandaResult(match(),target,source)).toMatchObject({state:'finished',providerGameId:'100',actualWinner:'B',correct:false,canonicalOutcome:false});
 expect(assessPandaResult(match(),{...target,teamA:'20',teamB:'10'},source)).toMatchObject({actualWinner:'A',correct:true});
});
test('absent/duplicate first map and changed participant IDs are unresolved, never guessed',()=>{
 const m=match();expect(assessPandaResult({...m,games:m.games.slice(0,1)},target,source).actualWinner).toBeNull();
 expect(assessPandaResult({...m,games:[m.games[1],m.games[1]]},target,source).reason).toBe('FIRST_MAP_AMBIGUOUS');
 expect(assessPandaResult(m,{...target,teamA:'99'},source).reason).toBe('PARTICIPANTS_CHANGED');
 expect(assessPandaResult({...m,games:m.games.map(g=>({...g,match_id:9}))},target,source).correct).toBeNull();
});
test('future nullable winner, forfeit, partial/missing time, late issuance and ties never become incorrect',()=>{
 const m=match(),g=m.games[1]!;
 expect(assessPandaResult({...m,status:'not_started',games:[{...g,status:'not_started',finished:false,winner:{id:null,type:'Team'}}]},target,source).state).toBe('not_started');
 expect(assessPandaResult({...m,status:'postponed',games:[{...g,status:'not_started',finished:false,winner:null}]},target,source).state).toBe('postponed');
 expect(assessPandaResult({...m,status:'canceled'},target,source)).toMatchObject({state:'cancelled',correct:null});
 for(const patch of [{forfeit:true},{end_at:null},{end_at:'2099-01-01T00:00:00Z'},{begin_at:null}])expect(assessPandaResult({...m,games:[{...g,...patch}]},target,source).correct).toBeNull();
 expect(assessPandaResult(m,{...target,issuedAt:g.begin_at},source).reason).toBe('NOT_BEFORE_MAP_START');
 expect(assessPandaResult(m,{...target,probability:.5},source).reason).toBe('NO_FAVOURITE');
 expect(assessPandaResult(m,{...target,probability:null,issuedAt:null},source).reason).toBe('NO_ISSUED_PROBABILITY');
});
test('result transport is bounded, fixed-host, respects quota and hides token from errors',async()=>{
 const beforeRequest=vi.fn(async()=>{}),observe=vi.fn(async()=>{});
 const client=new PandaScoreResultClient({apiToken:'synthetic-result-token',maxRequests:1},{budget:{beforeRequest,observe},fetch:async(url,init)=>{
  expect(url.toString()).toBe('https://api.pandascore.co/matches/1');expect(init.redirect).toBe('error');return new Response(JSON.stringify(match()));
 }});
 expect((await client.getMatch('1')).source.payloadSha256).toMatch(/^[a-f0-9]{64}$/);expect(beforeRequest).toHaveBeenCalledTimes(1);
 await expect(client.getMatch('2')).rejects.toMatchObject({code:'request_budget_exhausted'});
 const blocked=new PandaScoreResultClient({apiToken:'synthetic-result-token',maxRequests:1},{budget:{beforeRequest,observe},fetch:async()=>new Response('secret echo',{status:429,headers:{'retry-after':'60'}})});
 await expect(blocked.getMatch('1')).rejects.toMatchObject({code:'source_rate_limited',retryAfterMs:60000});
 expect(observe).toHaveBeenLastCalledWith(429,60000,null);
});
