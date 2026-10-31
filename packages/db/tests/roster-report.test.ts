import {expect,it} from 'vitest';
import {RosterRequestSchema,type StoredAccountEvidence} from '@dota/contracts';
import {buildRosterReport} from '../src/roster-report.js';
import type {ProMapCandidate} from '../src/pro-maps.js';
import {knownPlayers,retrospective,registry,start,snapshotAt} from './readiness-fixtures.js';
const cutoff='2024-01-02T00:00:00.000Z';
const lineup=knownPlayers.slice(0,5).map((playerId,i)=>({playerId,rolePos:i+1,isStandin:false}));
const input=RosterRequestSchema.parse({lineup});
const proofs=():StoredAccountEvidence[]=>knownPlayers.map((playerId,i)=>({observationId:String(i+1),playerId,externalAccountId:String(100+i),provider:'opendota',
  status:'verified',eventAt:null,knownAt:null,fetchedAt:snapshotAt,evidenceRef:'synthetic:identity',source:'synthetic'}));
const map=(change:Partial<ProMapCandidate>={}):ProMapCandidate=>({matchId:'1',startedAt:start,isPro:true,conflict:false,completed:true,radiantWin:true,
  durationSeconds:1800,radiantTeamId:'11',direTeamId:'22',leagueId:null,seriesId:null,source:'synthetic',syncedAt:snapshotAt,sourceFetchedAt:snapshotAt,dataRevision:'1',
  players:knownPlayers.map((_,i)=>({playerSlot:i<5?i:i+123,sourceAccountId:String(100+i)})),observations:retrospective().map(r=>({...r,matchId:'1'})),...change});
const report=(maps=[map()],request=input,evidence=proofs())=>buildRosterReport('11',request,cutoff,snapshotAt,maps,evidence,registry(),'7');
it('keeps exact five and ten pairs across organizations, with raw outcomes, patch counts and freshness',()=>{
  const r=report([map(),map({matchId:'2',radiantTeamId:'33'})]);
  expect(r.actual.exactFive).toMatchObject({nRaw:2,wins:2,recentMaps:2,firstAt:start,lastAt:start});
  expect(r.actual.exactFiveOrganizationMaps).toBe(1);expect(r.actual.pairs).toHaveLength(10);
  expect(r.actual.pairs.every(p=>p.nRaw===2&&p.organizationMaps===1)).toBe(true);
  expect(r.actual.players[0]?.organizations.map(o=>o.organizationId)).toEqual(['11','33']);
  expect(r.actual.exactFive.patchDistribution).toEqual([{patchId:'1',maps:2}]);
  expect(r.model).toBeNull();expect(r.predictionEligibility).toBe('not_assessed');expect(r.coverage.lateFetchedMaps).toBe(2);
});
it('one replacement retains four players and six links without inheriting organization wins or assigning a penalty',()=>{
  const selected=[...lineup.slice(0,4),{...lineup[4]!,playerId:knownPlayers[5]!,isStandin:true}];
  const r=report([map()],{...input,lineup:selected,expectedLineup:lineup});
  expect(r.comparison).toEqual({retainedPlayers:4,changedPlayers:1,retainedPairLinks:6,lostPairLinks:4,addedPairLinks:4,roleChanges:0});
  expect(r.actual.exactFive).toMatchObject({nRaw:0,winRate:null});expect(r.expected?.exactFive.nRaw).toBe(1);
  expect(r.actual.pairs.filter(p=>p.nRaw===1)).toHaveLength(6);expect(r.actual.pairs.filter(p=>p.nRaw===0)).toHaveLength(4);
  expect(r.warnings).toContain('STANDIN_DECLARED');
  expect(report([map()],{...input,lineup:selected.map(p=>({...p,isStandin:false}))}).actual.exactFive).toEqual(r.actual.exactFive);
});
it('returning player restores history and role swaps change role matching without changing fingerprint',()=>{
  const swapped=lineup.map((p,i)=>({...p,rolePos:i===0?2:i===1?1:p.rolePos}));
  const base=report(),r=report([map()],{...input,lineup:swapped,expectedLineup:lineup});
  expect(r.actual.fingerprint).toBe(base.actual.fingerprint);expect(r.actual.exactFive.nRaw).toBe(1);
  expect(r.comparison).toMatchObject({retainedPlayers:5,retainedPairLinks:10,roleChanges:2});
  expect(base.actual.players[0]?.selectedRoleMaps).toBe(1);expect(r.actual.players[0]?.selectedRoleMaps).toBe(0);
});
it('unknown identities and partial baseline are null, while verified zero-history identities have zero observations',()=>{
  const unknown=report([map()],input,proofs().slice(1));expect(unknown.actual.exactFive.nRaw).toBeNull();
  expect(unknown.actual.players[0]?.nRaw).toBeNull();expect(unknown.actual.pairs.filter(p=>p.nRaw===null)).toHaveLength(4);
  const empty=report([]);expect(empty.actual.exactFive).toMatchObject({nRaw:0,winRate:null,lastAt:null});
  const partial=lineup.map((p,i)=>({...p,playerId:i===0?null:p.playerId}));
  expect(report([map()],{...input,expectedLineup:partial}).comparison).toBeNull();
  expect(report().comparison).toBeNull();
});
it('churn does not bridge an incomplete middle map and distinguishes no transitions from zero changes',()=>{
  const middle=map({matchId:'2',startedAt:'2024-01-01T13:00:00.000Z',players:map().players.slice(1)});
  const r=report([map(),middle,map({matchId:'3',startedAt:'2024-01-01T14:00:00.000Z'})]);
  expect(r.churn).toMatchObject({maps:3,completeMaps:2,uniqueFives:null,changedTransitions:null,knownTransitions:0});
  expect(r.churn.transitions.every(t=>t.retainedPlayers===null)).toBe(true);expect(r.actual.exactFive.nRaw).toBe(2);
  expect(report().churn.changedTransitions).toBeNull();
  expect(report([map(),map({matchId:'2'})]).churn).toMatchObject({uniqueFives:1,changedTransitions:0,knownTransitions:1});
});
it('duplicate canonical identities, conflicting mappings and future evidence cannot create complete sides',()=>{
  const duplicate=proofs();duplicate[5]!.playerId=knownPlayers[0]!;
  expect(report([map()],input,duplicate).coverage.duplicateIdentityMaps).toBe(1);
  expect(report([map()],input,duplicate).actual.exactFive.nRaw).toBe(0);
  const conflict=[...proofs(),{...proofs()[0]!,observationId:'99',playerId:knownPlayers[1]!}];
  expect(report([map()],input,conflict).actual.exactFive.nRaw).toBeNull();
  expect(report([map()],input,proofs().map(p=>({...p,fetchedAt:'2999-01-01T00:00:00.000Z'}))).actual.exactFive.nRaw).toBeNull();
  expect(()=>report([map(),map()])).toThrow('duplicate_canonical_map');
});
it('only completed pro maps count; strict cutoff, native sides and recent window remain independent',()=>{
  const r=report([map({isPro:null}),map({matchId:'2',isPro:false}),map({matchId:'3',conflict:true}),map({matchId:'4',completed:false})]);
  expect(r.coverage).toMatchObject({unknownPro:1,nonPro:1,conflict:1,unfinished:1,eligibleMaps:0});
  expect(r.actual.exactFive.nRaw).toBe(0);expect(()=>report([map({startedAt:cutoff})])).toThrow('candidate_outside_window');
  const dire=report([map()],{...input,lineup:knownPlayers.slice(5).map((playerId,i)=>({playerId,rolePos:i+1,isStandin:false}))});
  expect(dire.actual.exactFive).toMatchObject({nRaw:1,wins:0,winRate:0});
  expect(report([map({startedAt:'2023-01-01T00:00:00.000Z'})]).actual.exactFive.recentMaps).toBe(0);
});
it('estimated, duplicate-role and conflicting role proofs stay unknown independently of exact-five counts',()=>{
  for(const change of ['estimated','duplicate','conflict'] as const){
    const m=map(),roles=m.observations.find(o=>o.fact.field==='roles')!;
    if(change==='conflict')roles.reviewState='conflict';
    else if(roles.fact.field==='roles'&&roles.fact.value){if(change==='estimated')roles.fact.value[0]!.basis='estimated';else roles.fact.value[1]!.rolePos=1;}
    const r=report([m]);expect(r.actual.exactFive.nRaw).toBe(1);expect(r.actual.players[0]?.confirmedRoleMaps).toBe(0);
  }
});
it('strict lineup contract rejects duplicate roles/IDs, malformed bigint and extra fields, allows explicit unknown slots',()=>{
  for(const bad of [lineup.map(()=>lineup[0]),lineup.map(p=>({...p,rolePos:1})),lineup.map(p=>({...p,playerId:'1e3'}))])expect(RosterRequestSchema.safeParse({lineup:bad}).success).toBe(false);
  expect(RosterRequestSchema.safeParse({lineup,penalty:0.1}).success).toBe(false);
  expect(RosterRequestSchema.safeParse({lineup:lineup.map(p=>({...p,playerId:null}))}).success).toBe(true);
});
it('incoming player keeps earlier cooperation elsewhere; pair observations are not ten independent maps',()=>{
  const selected=lineup.map((p,i)=>i===4?{...p,playerId:knownPlayers[5]!}:p);
  const transferred=map({matchId:'2',radiantTeamId:'33',players:map().players.map(p=>({...p,
    sourceAccountId:p.sourceAccountId==='104'?'105':p.sourceAccountId==='105'?'104':p.sourceAccountId}))});
  const history=Array.from({length:80},(_,i)=>({...transferred,matchId:String(i+2)}));
  const r=report([map(),...history],{...input,lineup:selected,expectedLineup:lineup});
  expect(r.actual.exactFive.nRaw).toBe(80);expect(r.actual.exactFiveOrganizationMaps).toBe(0);
  expect(r.actual.pairs.filter(p=>p.nRaw===80)).toHaveLength(4);expect(r.actual.pairs.filter(p=>p.nRaw===81)).toHaveLength(6);
  expect(r.coverage.eligibleMaps).toBe(81);expect(r.expected?.exactFive.nRaw).toBe(1);
});
it('known adjacent lineup changes have four retained players and a separate organization churn count',()=>{
  const changed=map({matchId:'2',startedAt:'2024-01-01T14:00:00.000Z',players:map().players.map(p=>({...p,
    sourceAccountId:p.sourceAccountId==='104'?'105':p.sourceAccountId==='105'?'104':p.sourceAccountId}))});
  const r=report([map(),changed]);expect(r.churn).toMatchObject({maps:2,uniqueFives:2,changedTransitions:1,knownTransitions:1,meanRetainedPlayers:4});
  expect(r.actual.exactFive.nRaw).toBe(1);expect(r.warnings).toContain('ROSTER_CHURN');
});
