import {test,expect} from 'vitest';
import {heroMetaSample} from '../src/hero-meta.js';
const m=(matchId='1')=>({matchId,radiantWin:true,heroes:Array.from({length:10},(_,i)=>({heroId:i+1,side:i<5?'radiant' as const:'dire' as const})),patchId:'1',syncedAt:'2026-10-31T00:00:00.000Z'});
test('partial maps inform observed WR but never the complete-draft pick-share denominator',()=>{
  const partial={...m('2'),heroes:[{heroId:1,side:'dire' as const}]};
  expect(heroMetaSample([m(),partial],1)).toMatchObject({nRaw:2,wins:1,winRate:0.5,knownDraftPicks:1,completeDraftMaps:1,pickRate:1});
  expect(heroMetaSample([partial],1)).toMatchObject({nRaw:1,winRate:0,completeDraftMaps:0,pickRate:null});
});
test('zero and unknown patch stay nullable; native side determines hero wins',()=>{
  expect(heroMetaSample([],1)).toMatchObject({nRaw:0,winRate:null,pickRate:null,dataUpdatedAt:null});
  expect(heroMetaSample([{...m(),patchId:null}],6)).toMatchObject({wins:0,patchDistribution:[{patchId:null,nRaw:1}]});
});
test('duplicates cannot manufacture observations or pick shares',()=>{
  expect(()=>heroMetaSample([m(),m()],1)).toThrow('duplicate_meta_map');const bad=m();bad.heroes.push(bad.heroes[0]!);
  expect(()=>heroMetaSample([bad],1)).toThrow('ambiguous_meta_heroes');
});
