import {expect,it} from 'vitest';
import {ProMapQuerySchema,type StoredAccountEvidence} from '@dota/contracts';
import {selectProMaps,type ProMapCandidate} from '../src/pro-maps.js';
import {knownPlayers,retrospective,registry,start,snapshotAt} from './readiness-fixtures.js';
const cutoffAt='2024-01-02T00:00:00.000Z';
const query={...ProMapQuerySchema.parse({}),cutoffAt};
const proofs=():StoredAccountEvidence[]=>knownPlayers.map((playerId,i)=>({observationId:String(i+1),playerId,externalAccountId:String(100+i),
  provider:'opendota',status:'verified',eventAt:null,knownAt:null,fetchedAt:snapshotAt,evidenceRef:'synthetic:verified-current-account',source:'synthetic'}));
function map(overrides:Partial<ProMapCandidate>={}):ProMapCandidate{return {matchId:'1',startedAt:start,isPro:true,conflict:false,completed:true,
  radiantWin:true,durationSeconds:1800,radiantTeamId:'11',direTeamId:'22',leagueId:null,seriesId:null,source:'synthetic',syncedAt:snapshotAt,
  sourceFetchedAt:snapshotAt,dataRevision:'1',players:knownPlayers.map((_,i)=>({playerSlot:i<5?i:i+123,sourceAccountId:String(100+i)})),
  observations:retrospective().map(r=>({...r,matchId:'1'})),...overrides};}
const assess=(maps=[map()],overrides:Partial<typeof query>={},evidence=proofs(),kind:'teams'|'players'='teams',id='11',game=registry())=>
  selectProMaps(kind,id,{...query,...overrides},snapshotAt,maps,game,evidence,'1',2);
it('counts each map once, separates raw WR from prediction, and preserves late-source provenance',()=>{
  const r=assess();expect(r.summary).toMatchObject({nRaw:1,wins:1,losses:0,winRate:1,meanDurationSeconds:1800});
  expect(r.scope).toBe('retrospective_descriptive');expect(r.predictionEligibility).toBe('not_assessed');
  expect(r.maps[0]).toMatchObject({side:'radiant',completeCanonicalRoster:true,rolePos:null,seriesStatus:'unknown',sourceFetchedAt:snapshotAt});
  expect(r.coverage).toMatchObject({lateFetchedMaps:1,knownPatch:1,knownSeries:0,unattributedOrganizationMapsInWindow:2});
  expect(()=>assess([map(),map()])).toThrow('duplicate_canonical_map');
});
it('unknown/non-pro/conflict/unfinished outcomes are separate exclusions, n=0 gives null metrics',()=>{
  const r=assess([map({matchId:'1',isPro:null}),map({matchId:'2',isPro:false}),map({matchId:'3',conflict:true}),map({matchId:'4',completed:false})]);
  expect(r.coverage).toMatchObject({unknownPro:1,nonPro:1,conflict:1,unfinished:1});
  expect(r.summary).toMatchObject({nRaw:0,winRate:null,meanDurationSeconds:null,dataUpdatedAt:null});expect(r.status).toBe('insufficient_data');
});
it('Radiant/Dire swapping inverts the same result and filters opponent/side independently',()=>{
  const dire=assess([map()],{},proofs(),'teams','22');expect(dire.summary.winRate).toBe(0);expect(dire.maps[0]?.opponentId).toBe('11');
  expect(assess([map()],{side:'dire'}).summary.nRaw).toBe(0);expect(assess([map()],{opponentId:'22'}).summary.nRaw).toBe(1);
  expect(assess([map()],{leagueId:'99'}).summary.nRaw).toBe(0);
});
it('missing organizations/series/roster do not invalidate an identified player outcome or an organization known side',()=>{
  const r=assess([map({direTeamId:null})],{},proofs(),'players',knownPlayers[0]!);
  expect(r.summary.nRaw).toBe(1);expect(r.maps[0]?.opponentId).toBeNull();expect(r.maps[0]?.seriesStatus).toBe('unknown');
  expect(assess([map({players:[]})]).summary.nRaw).toBe(1);
});
it('requires verified source-account identity and rejects ambiguity and duplicate canonical appearances',()=>{
  const id=knownPlayers[0]!;
  expect(assess([map()],{},[],'players',id).summary.nRaw).toBe(0);
  const conflicting=[...proofs(),{...proofs()[0]!,observationId:'99',playerId:knownPlayers[1]!}];
  expect(assess([map()],{},conflicting,'players',id).coverage.identityUnresolved).toBe(1);
  const duplicate=[...proofs().slice(0,1),{...proofs()[1]!,playerId:id}];
  expect(assess([map()],{},duplicate,'players',id).summary.nRaw).toBe(0);
});
it('history follows the same verified player across organizations without inheriting an organization score',()=>{
  const r=assess([map(),map({matchId:'2',radiantTeamId:'33'})],{},proofs(),'players',knownPlayers[0]!);
  expect(r.summary.nRaw).toBe(2);expect(new Set(r.maps.map(m=>m.organizationId))).toEqual(new Set(['11','33']));
});
it('confirmed roles match native slot and verified identity; inferred/low confidence/conflicts remain null',()=>{
  const id=knownPlayers[0]!;expect(assess([map()],{rolePos:1},proofs(),'players',id).summary.nRaw).toBe(1);
  for(const change of [{basis:'estimated' as const},{confidence:0.5},{playerId:knownPlayers[1]!}]){
    const m=map();const roles=m.observations.find(r=>r.fact.field==='roles')!;
    if(roles.fact.field==='roles')roles.fact.value![0]={...roles.fact.value![0]!,...change};
    // A mismatched identity must not duplicate another player in the fact schema.
    if('playerId' in change && roles.fact.field==='roles')roles.fact.value=roles.fact.value!.slice(0,1);
    expect(assess([m],{},proofs(),'players',id).maps[0]?.rolePos).toBeNull();
  }
  const m=map();m.observations.push({...m.observations.find(r=>r.fact.field==='roles')!,id:'99',reviewState:'conflict'});
  expect(assess([m],{rolePos:1},proofs(),'players',id).summary.nRaw).toBe(0);
  const duplicatedPosition=map(),roles=duplicatedPosition.observations.find(r=>r.fact.field==='roles')!;
  if(roles.fact.field==='roles')roles.fact.value![1]!.rolePos=1;
  expect(assess([duplicatedPosition],{},proofs(),'players',id).maps[0]?.rolePos).toBeNull();
});
it('cross-map and future role facts never fill roles',()=>{
  const m=map();m.observations=m.observations.map(r=>({...r,matchId:'99'}));
  expect(assess([m],{},proofs(),'players',knownPlayers[0]!).maps[0]?.rolePos).toBeNull();
  m.observations=map().observations.map(r=>({...r,fetchedAt:'2027-01-01T00:00:00.000Z'}));
  expect(assess([m],{},proofs(),'players',knownPlayers[0]!).maps[0]?.rolePos).toBeNull();
});
it('patch display uses reviewed current registry, never the source patch code or default label',()=>{
  const game=registry();game.patches=[];
  expect(assess([map()],{},proofs(),'teams','11',game).maps[0]?.patchId).toBeNull();
  expect(assess([map()],{patchId:'1'},proofs(),'teams','11',game).summary.nRaw).toBe(0);
  const late=registry();late.patches[0]!.knownAt='2025-01-01T00:00:00.000Z';
  expect(assess([map()],{patchId:'1'},proofs(),'teams','11',late).summary.nRaw).toBe(1);
});
it('series FK alone is not verified series evidence; reviewed contradictions remain orthogonal',()=>{
  const seriesId='00000000-0000-4000-8000-000000000001',m=map({seriesId});
  expect(assess([m]).coverage.knownSeries).toBe(0);
  m.observations.push({...m.observations[0]!,id:'77',fact:{field:'series_id',value:seriesId}});
  expect(assess([m]).coverage.knownSeries).toBe(1);
  m.observations.push({...m.observations.at(-1)!,id:'78',reviewState:'conflict'});
  expect(assess([m]).maps[0]?.seriesStatus).toBe('conflict');expect(assess([m]).summary.nRaw).toBe(1);
});
it('filters run before last-N selection; tied timestamps use bigint ordering',()=>{
  const maps=Array.from({length:11},(_,i)=>map({matchId:String(9007199254740993n+BigInt(i))}));
  const r=assess(maps,{limit:10});expect(r.summary.nRaw).toBe(10);expect(r.coverage.eligibleBeforeLimit).toBe(11);
  expect(r.maps[0]?.matchId).toBe('9007199254741003');
  expect(()=>assess([map({startedAt:cutoffAt})])).toThrow('candidate_outside_window');
});
