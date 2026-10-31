import {test,expect} from 'vitest';
import {HeroMatchupQuerySchema,type ScenarioSnapshot,type StoredContextObservation} from '@dota/contracts';
import {buildHeroMatchupReport} from '../src/hero-matchups.js';
import type {ProMapCandidate} from '../src/pro-maps.js';
import {pairInput} from '../../../tests/helpers/hero-matchups.js';
import {patchRegistry,policy} from './patch-fixtures.js';
const from='2024-01-01T00:00:00.000Z',cutoff='2024-01-03T00:00:00.000Z',now='2026-10-31T00:00:00.000Z';
const snapshot:ScenarioSnapshot={id:'00000000-0000-4000-8000-000000000001',revision:1,input:pairInput(),inputHash:'synthetic',source:'manual',recordedAt:now,knownAt:now,eventAt:null,warnings:[],predictionEligibility:'not_assessed'};
function map(id='1',overrides:Partial<ProMapCandidate>={}):ProMapCandidate{
  const seriesId=`00000000-0000-4000-8000-${id.padStart(12,'0')}`;
  const observation:StoredContextObservation={id,matchId:id,fact:{field:'series_id',value:seriesId},eventAt:null,knownAt:null,fetchedAt:now,provider:'synthetic',providerRecordId:null,evidenceRef:'synthetic:series',adapterVersion:'v1',reviewState:'accepted',availability:'retrospective_fact',earliestStage:'post_match'};
  return {matchId:id,startedAt:'2024-01-02T00:00:00.000Z',isPro:true,conflict:false,completed:true,radiantWin:true,durationSeconds:1800,radiantTeamId:null,direTeamId:null,leagueId:'1',seriesId,source:'synthetic',syncedAt:now,sourceFetchedAt:now,dataRevision:'1',players:Array.from({length:10},(_,i)=>({heroId:i+1,playerSlot:i<5?i:i+123,sourceAccountId:null})),observations:[observation],...overrides};
}
function registry(){const r=patchRegistry();r.patches=r.patches.slice(0,1).map(p=>({...p,coverageUntil:'2025-01-01T00:00:00.000Z'}));r.heroRules=[1,2,6,7].map(heroId=>({...r.heroRules[1]!,id:String(heroId),heroId,validTo:null}));return r;}
const prior=()=>[map('11',{startedAt:'2023-12-01T00:00:00.000Z'}),map('12',{startedAt:'2023-12-02T00:00:00.000Z',radiantWin:false})];
function report(maps=[map()],refs:ProMapCandidate[]|null=prior(),query={},r=registry(),s=snapshot){return buildHeroMatchupReport(s,HeroMatchupQuerySchema.parse({expectedRevision:1,...query}),from,cutoff,now,maps,refs,r,new Map());}
test('known pair counts survive partial drafts and absent accounts; native directions invert',()=>{
  const r=report([map('1',{players:map().players.slice(0,7)})]);expect(r.allies[0]).toMatchObject({nRaw:1,wins:1,winRate:1});expect(r.enemies[0]).toMatchObject({nRaw:1,wins:1});expect(r.coverage.partialHeroMaps).toBe(1);
  const s=structuredClone(snapshot);s.input.draft!.assignments.forEach(h=>h.teamSlot=h.teamSlot==='A'?'B':'A');expect(report([map()],prior(),{},registry(),s).enemies[0]?.winRate).toBe(0);
});
test('zero is null; pro, conflict, exact cutoff and unfinished maps are excluded',()=>{
  const r=report([map('1',{isPro:null}),map('2',{isPro:false}),map('3',{conflict:true}),map('4',{startedAt:cutoff}),map('5',{durationSeconds:90000})]);
  expect(r.allies[0]).toMatchObject({nRaw:0,winRate:null});expect(r.coverage).toMatchObject({unknownPro:1,nonPro:1,conflict:1,outsideWindow:1,unfinished:1});expect(r.teamAWinProbability).toBeNull();
});
test('duplicate heroes or native slots invalidate affected pairs, never all unaffected heroes',()=>{
  const m=map();m.players.push({...m.players[0]!,playerSlot:127});const r=report([m]);expect(r.allies[0]?.nRaw).toBe(0);expect(r.allies[1]?.nRaw).toBe(1);
  const d=map();d.players.push({...d.players[0]!,heroId:14});expect(report([d]).enemies[0]?.nRaw).toBe(0);expect(()=>report([map(),map()])).toThrow('duplicate_pair_map');
});
test('empirical prior uses only earlier same-patch pair maps outside target series',()=>{
  const r=report();expect(r.allies[0]?.smoothing).toMatchObject({status:'available',estimate:2/3,prior:{alpha:1,beta:1,mass:2,matchIds:['11','12']}});
  const same=map('11',{startedAt:'2023-12-01T00:00:00.000Z'});const target=map();target.seriesId=same.seriesId;target.observations=same.observations.map(p=>({...p,matchId:'1'}));
  expect(report([target],[same,prior()[1]!]).allies[0]?.smoothing.reason).toBe('REFERENCE_HAS_ONLY_ONE_OUTCOME');
  expect(report([map('1',{observations:[]})]).allies[0]?.smoothing.reason).toBe('TARGET_SERIES_UNVERIFIED');
  expect(report([map()],null).allies[0]?.winRate).toBe(1);expect(report([map()],null).allies[0]?.smoothing.reason).toBe('REFERENCE_TOO_LARGE');
});
test('prior-only requires explicit patch; unknown patch never borrows a prior',()=>{
  expect(report([]).allies[0]?.smoothing.status).toBe('unavailable');expect(report([],prior(),{patchScope:'specific',patchId:'1'}).allies[0]?.smoothing).toMatchObject({priorOnly:true,estimate:0.5});
  const r=registry();r.patches=[];expect(report([map()],prior(),{},r).allies[0]?.smoothing.reason).toBe('CONTEXT_NOT_SPECIFIC');
});
test('weights default off; explicit per-pair policy computes Kish N and fails closed on missing eligibility',()=>{
  expect(report().allies[0]?.weighted.status).toBe('disabled');const weights={version:policy.version,validation:policy.validation,draft:policy.draft};
  const r=report([map()],prior(),{weights});expect(r.allies[0]?.weighted).toMatchObject({status:'computed_candidate',rate:1,nEff:1,nMissing:0});
  const reg=registry();reg.heroRules=reg.heroRules.filter(p=>p.heroId!==2);const missing=report([map()],prior(),{weights},reg);
  expect(missing.allies[0]?.weighted).toMatchObject({status:'unavailable',rate:null,nEff:null});expect(missing.allies[1]?.weighted.status).toBe('computed_candidate');
});
test('fingerprint changes for registry, policy, rejected map coverage and data revisions',()=>{
  const base=report().fingerprint;expect(report([map(),map('2',{isPro:null})]).fingerprint).not.toBe(base);expect(report([map('1',{dataRevision:'2'})]).fingerprint).not.toBe(base);
  const r=registry();r.revision='99';expect(report([map()],prior(),{},r).fingerprint).not.toBe(base);
});
test('patch transfer uses the two relevant heroes; zero impact is known, missing impact withholds the entire weighted rate',()=>{
  const r=patchRegistry();r.heroRules=r.heroRules.flatMap(p=>[1,2,6,7].map(heroId=>({...p,id:p.id+heroId,heroId})));
  r.heroImpacts=[1,2,6,7].map(heroId=>({...r.heroImpacts[0]!,id:String(heroId),heroId,impactLevel:heroId===1?'rework':'minor'}));
  const weights={version:policy.version,validation:policy.validation,draft:policy.draft};
  const maps=[map('1',{startedAt:'2023-12-30T00:00:00.000Z',radiantWin:false}),map('2')];
  const run=()=>buildHeroMatchupReport(snapshot,HeroMatchupQuerySchema.parse({expectedRevision:1,weights}),'2023-12-29T00:00:00.000Z',cutoff,now,maps,[],r,new Map());
  const result=run();expect(result.allies[0]?.weighted).toMatchObject({rate:1,nEff:1,nKnown:2,nPositive:1,nMissing:0});
  expect(result.allies[1]!.weighted.rate).toBeLessThan(1);expect(result.allies[1]!.weighted.nEff).toBeGreaterThan(1);
  r.heroImpacts=r.heroImpacts.filter(p=>p.heroId!==2);expect(run().allies[0]?.weighted).toMatchObject({status:'unavailable',rate:null,nEff:null,nKnown:1,nMissing:1});
});
test('league and patch filters apply to target and reference; mixed patch raw stays separate from smoothing',()=>{
  expect(report([map()],prior(),{leagueId:'999'}).allies[0]?.nRaw).toBe(0);
  const r=registry();r.patches=[];const filtered=report([map()],prior(),{patchScope:'specific',patchId:'1'},r);
  expect(filtered.coverage).toMatchObject({unknownPatchMaps:1,filterMismatch:1});expect(filtered.allies[0]?.winRate).toBeNull();
  const patches=patchRegistry();const result=buildHeroMatchupReport(snapshot,HeroMatchupQuerySchema.parse({expectedRevision:1}),'2023-12-01T00:00:00.000Z',cutoff,now,[map('1',{startedAt:'2023-12-30T00:00:00.000Z'}),map('2')],[],patches,new Map());
  expect(result.allies[0]?.nRaw).toBe(2);expect(result.allies[0]?.smoothing.reason).toBe('CONTEXT_NOT_SPECIFIC');
});
test('proofs fetched after report snapshot cannot enable candidate weights',()=>{
  const r=registry();r.heroRules=r.heroRules.map(p=>({...p,fetchedAt:'2027-01-01T00:00:00.000Z'}));
  const weights={version:policy.version,validation:policy.validation,draft:policy.draft};
  expect(report([map()],prior(),{weights},r).allies[0]?.weighted).toMatchObject({status:'unavailable',rate:null,nEff:null});
});
