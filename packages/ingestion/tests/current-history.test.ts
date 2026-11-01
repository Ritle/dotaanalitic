import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {selectCurrentTeamMaps,validateCurrentHistoryCapture} from '../src/opendota/current-history.js';
import {OpenDotaClient} from '../src/opendota/client.js';
const cutoff='2026-01-01T00:00:00.000Z',fetched='2026-01-01T00:00:01.000Z',captured='2026-01-01T00:00:02.000Z';
const source=(endpoint:string,data:unknown)=>{const rawBody=JSON.stringify(data);return {rawBody,source:{provider:'opendota',adapterVersion:'synthetic-test-client',
  endpoint,fetchedAt:fetched,knownAt:null,payloadSha256:createHash('sha256').update(rawBody).digest('hex'),attempts:1,
  rateLimitRemaining:{minute:null,day:null,month:null}}};};
const summary=(id='101',time=1767139200)=>({match_id:id,start_time:time,duration:1000,radiant_win:true,leagueid:'9',radiant:true,opposing_team_id:'2'});
const map=()=>({...summary(),radiant_team_id:1,dire_team_id:2,players:[]});
const capture=()=>({schemaVersion:1,mode:'live_current_history_capture',cutoffAt:cutoff,capturedAt:captured,teamIds:['1'],sample:1,
  discoveries:[source('/teams/1/matches',[summary()])],heroes:source('/heroes',[]),leagues:source('/leagues',[{leagueid:9,name:'Synthetic league',tier:'professional'}]),
  matches:[source('/matches/101',map())],errors:[]});
it('selects recent completed unique maps fairly across teams independent of win result',()=>{
  const a=[summary('101'),summary('102',1767139100),summary('103',1767139000)],b=[summary('101'),summary('104',1767139150)];
  const r=selectCurrentTeamMaps([{teamId:'1',data:a},{teamId:'2',data:b}],3,cutoff);
  expect(r.selected.map(s=>s.match_id)).toEqual(['101','102','104']);expect(r.selected[0]!.discoveryTeamIds).toEqual(['1','2']);
  expect(selectCurrentTeamMaps([{teamId:'1',data:a.map(m=>({...m,radiant_win:false}))},{teamId:'2',data:b}],3,cutoff).selected).toEqual(r.selected);
});
it('accounts for duplicates and excludes future, unfinished and missing completion summaries',()=>{
  const r=selectCurrentTeamMaps([{teamId:'1',data:[summary(),summary(),{...summary('102'),duration:0},summary('103',1767225600)]}],5,cutoff);
  expect(r).toMatchObject({candidates:1,duplicates:1,invalid:1,outsideCohort:1});expect(r.selected).toHaveLength(1);
});
it('keeps outcome eligibility independent from missing identities, heroes, roles, series and patch',()=>{
  const r=validateCurrentHistoryCapture(capture(),captured);expect(r.matches[0]).toMatchObject({matchId:'101',eligible:true,reasons:[]});
});
it('rejects substituted raw bytes/endpoints/clocks and incomplete or duplicate map inventories',()=>{
  const a=capture();a.matches[0]!.rawBody+=' ';expect(()=>validateCurrentHistoryCapture(a,captured)).toThrow('history_source_binding');
  const b=capture();b.discoveries[0]!.source.endpoint='/teams/2/matches';expect(()=>validateCurrentHistoryCapture(b,captured)).toThrow();
  const c=capture();c.matches=[];expect(()=>validateCurrentHistoryCapture(c,captured)).toThrow('history_match_inventory');
  const d=capture();d.matches.push(d.matches[0]!);expect(()=>validateCurrentHistoryCapture(d,captured)).toThrow();
  expect(()=>validateCurrentHistoryCapture(capture(),cutoff)).toThrow('history_capture_clocks');
});
it('blocks unknown/amateur leagues, target mismatch and discovery/detail corrections before import',()=>{
  for(const tier of ['amateur',null]){const c=capture();c.leagues=source('/leagues',[{leagueid:9,tier}]);
    expect(validateCurrentHistoryCapture(c,captured).matches[0]!.reasons).toContain('PRO_LEAGUE_REQUIRED');}
  const c=capture();c.matches=[source('/matches/101',{...map(),radiant_team_id:3})];
  expect(validateCurrentHistoryCapture(c,captured).matches[0]!.reasons).toContain('TARGET_ORGANIZATION_MISSING');
  for(const change of [{radiant_win:false},{duration:999},{dire_team_id:3},{start_time:1767139201}]){
    const d=capture();d.matches=[source('/matches/101',{...map(),...change})];
    expect(validateCurrentHistoryCapture(d,captured).matches[0]!.reasons).toContain('DISCOVERY_DETAIL_CONFLICT');}
});
it('records missing HTTP responses as explicit errors without making eligible substitute matches',()=>{
  const c={...capture(),matches:[],errors:[{matchId:'101',code:'source_timeout',status:null}]};
  expect(validateCurrentHistoryCapture(c,captured).matches).toHaveLength(0);
});
it('rejects synthetic payloads and bigint ID substitution',()=>{
  const c=capture();c.matches=[source('/matches/101',{...map(),synthetic:true})];expect(()=>validateCurrentHistoryCapture(c,captured)).toThrow();
  const d=capture();d.matches=[source('/matches/101',{...map(),match_id:'9007199254740993'})];expect(()=>validateCurrentHistoryCapture(d,captured)).toThrow('source_id_mismatch');
});
it('requests team history on the fixed provider host and preserves native side/IDs',async()=>{
  const client=new OpenDotaClient({maxRequests:1},{fetch:async url=>{expect(url.href).toBe('https://api.opendota.com/api/teams/1/matches');
    return new Response(JSON.stringify([summary()]));}});
  expect((await client.getTeamMatches('1')).data[0]).toMatchObject({match_id:'101',radiant:true,opposing_team_id:'2'});
});
