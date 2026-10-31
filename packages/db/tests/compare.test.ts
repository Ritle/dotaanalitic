import {expect,it} from 'vitest';
import {CompareRequestSchema,type StoredAccountEvidence} from '@dota/contracts';
import {buildCompareReport} from '../src/compare-report.js';
import type {ProMapCandidate} from '../src/pro-maps.js';
import {knownPlayers,registry,snapshotAt} from './readiness-fixtures.js';
const lineup=(ids:string[])=>ids.map((playerId,i)=>({playerId,rolePos:i+1,isStandin:false}));
const input=()=>({...CompareRequestSchema.parse({teamAId:'11',teamBId:'22',lineupA:lineup(knownPlayers.slice(0,5)),lineupB:lineup(knownPlayers.slice(5,10))}),fromAt:'2024-01-01T00:00:00.000Z',cutoffAt:'2024-01-03T00:00:00.000Z'});
const evidence=():StoredAccountEvidence[]=>knownPlayers.map((playerId,i)=>({observationId:String(i+1),playerId,externalAccountId:String(100+i),provider:'opendota',status:'verified',
  eventAt:null,knownAt:'2023-01-01T00:00:00.000Z',fetchedAt:snapshotAt,evidenceRef:'synthetic:comparison-identity',source:'synthetic'}));
function map(id='1',reverse=false):ProMapCandidate{return {matchId:id,startedAt:`2024-01-0${id}T12:00:00.000Z`,isPro:true,conflict:false,completed:true,radiantWin:true,durationSeconds:1800,
  radiantTeamId:reverse?'22':'11',direTeamId:reverse?'11':'22',leagueId:'99',seriesId:null,source:'synthetic',syncedAt:snapshotAt,sourceFetchedAt:snapshotAt,dataRevision:'1',observations:[],
  players:knownPlayers.map((_,i)=>({playerSlot:i<5?(reverse?128+i:i):(reverse?i-5:123+i),sourceAccountId:String(100+i)})).reverse()};}
const report=(maps=[map(),map('2',true)],q=input(),links=evidence())=>buildCompareReport(q,snapshotAt,maps,links,registry(),'1',new Map([['11','Synthetic A'],['22','Synthetic B']]),null);
it('organizations and exact fives are distinct, native slots survive reversed array and A/B swaps',()=>{
  const r=report();expect(r.teamA.organization).toMatchObject({nRaw:2,wins:1,winRate:0.5});expect(r.teamA.sides.radiant.winRate).toBe(1);expect(r.teamA.sides.dire.winRate).toBe(0);
  expect(r.h2h.maps[0]).toMatchObject({teamASide:'dire',won:false,matchesSelectedFives:true});expect(r.h2h.selectedFives.nRaw).toBe(2);
  const q=input();[q.teamAId,q.teamBId]=[q.teamBId,q.teamAId];[q.lineupA,q.lineupB]=[q.lineupB,q.lineupA];
  const swap=report(undefined,q);expect(swap.h2h.maps[0]?.won).toBe(true);expect(swap.h2h.maps[0]?.teamASide).toBe('radiant');
});
it('old organization wins do not belong to a new five; exact cohort is unknown with unresolved identity',()=>{
  const q=input();q.lineupA[4]!.playerId='123';const links=[...evidence(),{...evidence()[0]!,observationId:'100',playerId:'123',externalAccountId:'900'}];
  const changed=report(undefined,q,links);expect(changed.teamA.organization.nRaw).toBe(2);expect(changed.teamA.selectedFiveOrganization).toMatchObject({nRaw:0,winRate:null});
  expect(changed.h2h.selectedFives.nRaw).toBe(0);q.lineupA[4]!.playerId=null;
  expect(report(undefined,q).h2h.selectedFives.nRaw).toBeNull();
});
it('cross-organization personal/co-play history remains separate from H2H organization tags',()=>{
  const m=map();m.radiantTeamId='33';const r=report([m,map('2',true)]);
  expect(r.teamA.organization.nRaw).toBe(1);expect(r.teamA.cohesion.actual.exactFive.nRaw).toBe(2);expect(r.h2h.organizations.nRaw).toBe(1);
});
it('pro/completion/conflict gates and duplicate map guard protect raw rates; empty known cohort has nullable WR',()=>{
  const maps=[{...map(),isPro:false},{...map('2'),isPro:null},{...map(),matchId:'3',conflict:true},{...map(),matchId:'4',completed:false}];
  const r=report(maps);expect(r.h2h.organizations).toMatchObject({nRaw:0,winRate:null});expect(r.coverage).toMatchObject({nonPro:1,unknownPro:1,conflict:1,unfinished:1});
  expect(()=>report([map(),map()])).toThrow('duplicate_canonical_map');
});
it('missing historical canonical identities never fall back to array index, player projection or inferred lineup',()=>{
  const m=map();m.players[0]!.sourceAccountId=null;const r=report([m]);expect(r.h2h.maps[0]?.matchesSelectedFives).toBeNull();
  expect(r.h2h.organizations.nRaw).toBe(1);expect(r.coverage.h2hIncompleteFives).toBe(1);
});
it('patch/league filters and strict start cutoff remain explicit; strength unavailable never hides raw data',()=>{
  const q=input();q.patchId='999';const r=report(undefined,q);expect(r.teamA.organization.nRaw).toBe(0);expect(r.teamA.strength.status).toBe('unavailable');
  expect(r.teamAWinProbability).toBeNull();expect(()=>report([{...map(),startedAt:q.cutoffAt}])).toThrow('candidate_outside_window');
});
