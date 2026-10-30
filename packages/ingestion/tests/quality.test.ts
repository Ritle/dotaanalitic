import { expect,test } from 'vitest';
import { createHash } from 'node:crypto';
import { assess,classifyLeague,matchEventAt,parseSource,sideOf, type QualityContext } from '../src/quality.js';
import { MatchSchema } from '../src/opendota/schemas.js';

const map=()=>MatchSchema.parse({match_id:'123',start_time:1700000000,radiant_win:false,
  radiant_team_id:'1',dire_team_id:'2',players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:128+i-5,hero_id:i+1,account_id:i+1}))});
const context=():QualityContext=>({pro:true,knownHeroes:new Set(Array.from({length:20},(_,i)=>i+1)),
  players:new Map(Array.from({length:10},(_,i)=>[String(i+1),String(i+101)])),radiantTeamId:'1',direTeamId:'2',seriesId:null,conflict:false,
  fetchedAt:'2026-10-31T00:00:00.000Z'});

test('slots define sides; neither array order nor team A/B supplies Radiant or first pick',()=>{
  expect([0,4,128,132,5,127,null].map(sideOf)).toEqual(['radiant','radiant','dire','dire',null,null,null]);
  const match=map();match.players?.reverse();
  expect(assess(match,context()).metrics).toMatchObject({slots_valid:true,final_heroes_valid:true,first_pick_side:null,known_at:null,n_raw:1});
});
test.each([0,11,12])('keeps final heroes independently of %i picks',count=>{
  const match=map();match.picks_bans=count?Array.from({length:count},(_,i)=>({is_pick:true,hero_id:i+1,team:i<5?0:1,order:i}))
    :[{is_pick:false,hero_id:20,team:0,order:0}];
  const result=assess(match,context());
  expect(result.final_heroes_status).toBe('eligible');
  expect(result.draft_timeline_status).toBe('structurally_inconsistent');
  expect(result.metrics.pick_events).toBe(count);
  expect(match.picks_bans).toHaveLength(count||1);
});
test('matching picks do not certify historical draft rules; wrong side is a separate anomaly',()=>{
  const match=map();match.picks_bans=Array.from({length:10},(_,i)=>({is_pick:true,hero_id:i+1,team:i<5?0:1,order:i}));
  expect(assess(match,context())).toMatchObject({draft_timeline_status:'unknown',draft_order_valid:null});
  match.picks_bans[0]!.team=1;
  expect(assess(match,context()).anomalies).toContain('DRAFT_SIDE_MISMATCH');
});
test('unresolved organizations/canonical players never discard identified final heroes',()=>{
  const match=map();match.radiant_team_id=null;match.dire_team_id=null;
  const ctx=context();ctx.players=new Map();ctx.radiantTeamId=null;ctx.direTeamId=null;
  expect(assess(match,ctx)).toMatchObject({final_heroes_status:'eligible',organization_status:'unknown',player_status:'unknown',
    metrics:{source_accounts_10:true,canonical_players_10:false}});
});
test('league discovery alone cannot classify professional outcomes',()=>{
  expect(['professional','premium','amateur','excluded',null,'unknown','Professional'].map(classifyLeague))
    .toEqual([true,true,false,false,null,null,null]);
  const ctx=context();ctx.pro=null;
  expect(assess(map(),ctx).outcome_status).toBe('unknown');
  ctx.conflict=true;expect(assess(map(),ctx).outcome_status).toBe('ineligible');
});
test('a boolean winner without a completed duration is not a verified outcome',()=>{
  const match=map();
  const ctx={...context(),fetchedAt:'2026-10-31T00:00:00.000Z'};
  expect(assess(match,ctx).outcome_status).toBe('unknown');
  match.duration=1800;
  expect(assess(match,ctx).outcome_status).toBe('eligible');
  ctx.fetchedAt=matchEventAt(match)!;
  expect(assess(match,ctx).outcome_status).toBe('unknown');
});
test('missing start times remain unknown; raw draft arrays are immutable projections without chat/profile data',()=>{
  const raw={...map(),chat:[{key:'private-message'}],players:[{account_id:1,player_slot:0,hero_id:1,personaname:'private-name'}],
    picks_bans:[{hero_id:1,order:7,team:9,is_pick:true,provider_extra:'untouched'}]};
  const rawBody=JSON.stringify(raw);
  const observation={data:raw,rawBody,source:{provider:'opendota' as const,endpoint:'/matches/123',adapterVersion:'v2',
    fetchedAt:'2026-10-31T00:00:00.000Z',knownAt:null,payloadSha256:createHash('sha256').update(rawBody).digest('hex'),
    attempts:1,rateLimitRemaining:{minute:null,day:null,month:null}}};
  const parsed=parseSource(observation,'123');
  expect(JSON.stringify(parsed.projection)).not.toContain('private-message');
  expect(JSON.stringify(parsed.projection)).not.toContain('private-name');
  expect(parsed.projection.picks_bans).toEqual(raw.picks_bans);
  expect(parsed.source.knownAt).toBeNull();
  expect(matchEventAt(MatchSchema.parse({match_id:1}))).toBeNull();
  expect(()=>parseSource({...observation,rawBody:'{}'},'123')).toThrow('source_hash_mismatch');
});
