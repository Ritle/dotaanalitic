import {expect,it} from 'vitest';
import {PlayerHeroQuerySchema,type StoredAccountEvidence} from '@dota/contracts';
import {buildReferencePool,referenceSmoothing} from '../src/reference-pool.js';
import type {ProMapCandidate} from '../src/pro-maps.js';
import {knownPlayers,retrospective,registry,snapshotAt} from './readiness-fixtures.js';
const before='2024-01-02T00:00:00.000Z',series='00000000-0000-4000-8000-000000000001';
const query=PlayerHeroQuerySchema.parse({patchScope:'all'});
const evidence:StoredAccountEvidence[]=knownPlayers.map((playerId,i)=>({observationId:String(i+1),playerId,externalAccountId:String(100+i),provider:'opendota',status:'verified',
  eventAt:null,knownAt:null,fetchedAt:snapshotAt,evidenceRef:'synthetic:account',source:'synthetic'}));
const map=(id='1',won=true):ProMapCandidate=>({matchId:id,startedAt:'2024-01-01T12:00:00.000Z',isPro:true,conflict:false,completed:true,radiantWin:won,durationSeconds:1800,
  radiantTeamId:'11',direTeamId:'22',leagueId:null,seriesId:series,source:'synthetic',syncedAt:snapshotAt,sourceFetchedAt:snapshotAt,dataRevision:'1',
  players:knownPlayers.map((_,i)=>({playerSlot:i<5?i:i+123,sourceAccountId:String(100+i),heroId:i+1})),
  observations:[...retrospective().map(r=>({...r,matchId:id})),{...retrospective()[0]!,id:'99',matchId:id,fact:{field:'series_id',value:series}}]});
const pool=(maps=[map('1',true),map('2',false)],game=registry())=>buildReferencePool(before,snapshotAt,{candidates:maps,evidence},game,query);
it('reference global/pro-patch counts use each map once per hero, preserving role/patch/series coverage',()=>{
  const r=pool();expect(r.report.coverage).toMatchObject({candidates:2,eligibleMaps:2,heroObservations:20,confirmedRoles:20,knownPatches:20,verifiedSeries:20});
  expect(r.report.buckets.find(b=>b.heroId==='1')).toMatchObject({nRaw:2,wins:1,winRate:0.5,rolePos:1,patchId:'1'});
  expect(r.report.globalBuckets.find(b=>b.heroId==='1')).toMatchObject({nRaw:2,wins:1});
  const s=referenceSmoothing(1,1,'1',1,'1',['00000000-0000-4000-8000-000000000002'],r);
  expect(s).toMatchObject({status:'available',smoothedObservedRate:2/3,priorOnly:false,prior:{alpha:1,beta:1,mass:2,mean:0.5}});
});
it('known target series are excluded and unknown target series cannot be asserted independent',()=>{
  expect(referenceSmoothing(1,1,'1',1,'1',[series],pool()).reasons).toEqual(['NO_COMPARABLE_REFERENCE_MAPS']);
  expect(referenceSmoothing(1,1,'1',1,'1',[null],pool()).reasons).toEqual(['TARGET_SERIES_UNVERIFIED']);
});
it('reference and observation windows must be disjoint, duplicate maps and incomplete outcomes do not count',()=>{
  const at=map();at.startedAt=before;expect(()=>pool([at])).toThrow('reference_overlaps_observation_window');
  expect(()=>pool([map(),map()])).toThrow('duplicate_reference_map');
  const missing=map();missing.completed=false;expect(pool([missing]).report.coverage.eligibleMaps).toBe(0);
});
it('proper prior requires both observed outcomes and specific hero-role-patch context',()=>{
  expect(referenceSmoothing(1,1,'1',1,'1',[],pool([map()])).reasons).toEqual(['REFERENCE_HAS_ONLY_ONE_OUTCOME']);
  for(const context of [[null,1,'1'],['1',null,'1'],['1',1,null]] as const)
    expect(referenceSmoothing(1,1,...context,[],pool()).reasons).toEqual(['CONTEXT_NOT_SPECIFIC']);
  expect(referenceSmoothing(0,0,'1',1,'1',[],pool())).toMatchObject({status:'available',smoothedObservedRate:0.5,priorOnly:true});
});
it('unverified roles and missing patch registry remain null, never a borrowed comparable prior',()=>{
  const m=map();m.observations=m.observations.map(p=>p.fact.field==='roles'?{...p,reviewState:'conflict'}:p);
  expect(pool([m]).report.buckets.find(b=>b.heroId==='1')?.rolePos).toBeNull();
  const game=registry();game.patches=[];expect(pool([map()],game).report.buckets.every(b=>b.patchId===null)).toBe(true);
});
it('reference overflow or absent inventory returns unavailable smoothing instead of truncated counts',()=>{
  const p=buildReferencePool(before,snapshotAt,null,registry(),query,'GLOBAL_REFERENCE_TOO_LARGE');
  expect(p.report.status).toBe('unavailable');expect(referenceSmoothing(1,1,'1',1,'1',[],p).smoothedObservedRate).toBeNull();
  expect(p.report.coverage.eligibleMaps).toBeNull();
});
