import {expect,it} from 'vitest';
import {PlayerHeroQuerySchema,type StoredAccountEvidence} from '@dota/contracts';
import {buildPlayerHeroReport} from '../src/player-hero-report.js';
import type {ProMapCandidate} from '../src/pro-maps.js';
import {knownPlayers,retrospective,registry,start,snapshotAt} from './readiness-fixtures.js';
const query={...PlayerHeroQuerySchema.parse({patchScope:'all'}),fromAt:'2023-01-01T00:00:00.000Z',cutoffAt:'2024-01-02T00:00:00.000Z'};
const proofs=():StoredAccountEvidence[]=>knownPlayers.map((playerId,i)=>({observationId:String(i+1),playerId,externalAccountId:String(100+i),provider:'opendota',
  status:'verified',eventAt:null,knownAt:null,fetchedAt:snapshotAt,evidenceRef:'synthetic:identity',source:'synthetic'}));
const map=(change:Partial<ProMapCandidate>={}):ProMapCandidate=>({matchId:'1',startedAt:start,isPro:true,conflict:false,completed:true,radiantWin:true,
  durationSeconds:1800,radiantTeamId:'11',direTeamId:'22',leagueId:null,seriesId:null,source:'synthetic',syncedAt:snapshotAt,sourceFetchedAt:snapshotAt,dataRevision:'1',
  players:knownPlayers.map((_,i)=>({playerSlot:i<5?i:i+123,sourceAccountId:String(100+i),heroId:i+1,kills:4,deaths:0,assists:6,gpm:400,xpm:null})),
  observations:retrospective().map(r=>({...r,matchId:'1'})),...change});
const report=(maps=[map()],input=query,evidence=proofs(),game=registry())=>buildPlayerHeroReport(knownPlayers[0]!,input,snapshotAt,maps,evidence,game,'9',new Map([['1','Synthetic Hero']]));
function ready(r:ReturnType<typeof report>){if(r.status==='unavailable')throw new Error(r.reason);return r;}
it('combines same hero with distinct confirmed roles as separate samples and independent field coverage',()=>{
  const m=map({matchId:'2',radiantTeamId:'33'});m.observations=m.observations.map(r=>({...r,matchId:'2'}));
  const roles=m.observations.find(r=>r.fact.field==='roles')!;
  if(roles.fact.field==='roles'){roles.fact.value![0]!.rolePos=2;roles.fact.value![1]!.rolePos=1;}
  m.players[0]!.assists=null;m.players[0]!.xpm=600;m.players[0]!.gpm=null;
  const r=ready(report([map(),m]));expect(r.summary).toMatchObject({nRaw:2,kda:{nMaps:1},meanGpm:{nMaps:1},meanXpm:{nMaps:1}});
  expect(r.groups.map(g=>g.rolePos)).toEqual([1,2]);expect(r.groups.every(g=>g.heroId==='1'&&g.heroPickRate===1)).toBe(true);
  expect(r.coverage).toMatchObject({confirmedRole:2,knownHero:2,lateFetchedMaps:2});expect(r.warnings).toContain('METRIC_COVERAGE_PARTIAL');
});
it('hero pick-rate denominator retains other heroes within exactly the same role/time/patch filters',()=>{
  const m=map({matchId:'2'});m.players[0]!.heroId=11;
  const r=ready(report([map(),m],{...query,heroId:'1'}));expect(r.summary.nRaw).toBe(1);expect(r.playerMapsInScope).toBe(2);
  expect(r.selectedHeroShare).toBe(0.5);expect(r.groups[0]?.heroPickRate).toBe(0.5);expect(r.coverage.heroFilterMismatch).toBe(1);
});
it('unverified/estimated/conflicting role stays in null group and is excluded by explicit role filter',()=>{
  const m=map();m.observations=m.observations.map(r=>r.fact.field==='roles'?{...r,reviewState:'conflict'}:r);
  expect(ready(report([m])).groups[0]?.rolePos).toBeNull();expect(ready(report([m],{...query,rolePos:1})).summary.nRaw).toBe(0);
  expect(ready(report([map()],{...query,rolePos:2})).summary.winRate).toBeNull();
});
it('uses current reviewed patch registry and never silently broadens an unknown default patch',()=>{
  const game=registry();game.patches=[];
  expect(report([map()],{...query,patchScope:'current'},proofs(),game)).toMatchObject({status:'unavailable',reason:'CURRENT_PATCH_UNKNOWN'});
  expect(ready(report([map()],query,proofs(),game)).groups[0]?.heroId).toBe('1');
  expect(ready(report([map()],{...query,patchScope:'specific',patchId:'99'})).summary.nRaw).toBe(0);
  expect(ready(report([map()],{...query,patchScope:'specific',patchId:'1'})).coverage.knownPatch).toBe(1);
});
it('strict time boundary, pro-only gate and zero-sample nulls hold before individual metrics',()=>{
  const r=ready(report([map({isPro:null}),map({matchId:'2',isPro:false}),map({matchId:'3',conflict:true}),map({matchId:'4',completed:false})]));
  expect(r.coverage).toMatchObject({unknownPro:1,nonPro:1,conflict:1,unfinished:1});expect(r.summary).toMatchObject({nRaw:0,winRate:null,kda:{value:null,nMaps:0}});
  expect(()=>report([map({startedAt:query.cutoffAt})])).toThrow('candidate_outside_window');
  expect(()=>report([map(),map()])).toThrow('duplicate_canonical_map');
});
it('conflicting identities and duplicated target appearances cannot create player metrics',()=>{
  const conflict=[...proofs(),{...proofs()[0]!,observationId:'99',playerId:knownPlayers[1]!}];
  expect(ready(report([map()],query,conflict)).coverage.identityUnresolved).toBe(1);
  const duplicate=proofs();duplicate[5]!.playerId=knownPlayers[0]!;
  expect(ready(report([map()],query,duplicate)).summary.nRaw).toBe(0);
});
it('missing/duplicate hero and invalid metric values remain unknown without inventing zero',()=>{
  const m=map();m.players[0]!.heroId=null;m.players[0]!.kills=-1;m.players[0]!.gpm=Infinity;
  const r=ready(report([m]));expect(r.groups[0]).toMatchObject({heroId:null,heroName:null});expect(r.summary.meanKills).toEqual({value:null,nMaps:0});
  expect(r.summary.meanGpm).toEqual({value:null,nMaps:0});expect(r.coverage.knownHero).toBe(0);
  m.players[0]!.heroId=2;expect(ready(report([m])).maps[0]?.heroId).toBeNull();
});
it('native player slot determines Dire win/loss even if input rows are reversed',()=>{
  const m=map();[m.players[0]!.sourceAccountId,m.players[5]!.sourceAccountId]=[m.players[5]!.sourceAccountId,m.players[0]!.sourceAccountId];m.players.reverse();
  const r=ready(report([m]));expect(r.summary).toMatchObject({nRaw:1,wins:0,winRate:0});expect(r.maps[0]?.side).toBe('dire');expect(r.maps[0]?.heroId).toBe('6');
});
