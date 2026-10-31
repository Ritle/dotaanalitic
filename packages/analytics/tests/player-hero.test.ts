import {expect,it} from 'vitest';
import {playerHeroSample,type PlayerHeroObservation} from '../src/player-hero.js';
const map=(matchId='1',change:Partial<PlayerHeroObservation>={}):PlayerHeroObservation=>({matchId,heroId:'1',rolePos:1,won:true,
  startedAt:'2024-01-01T00:00:00.000Z',syncedAt:'2026-10-31T00:00:00.000Z',kills:4,deaths:0,assists:6,gpm:400,xpm:null,...change});
it('zero observations give null rates and all nullable metrics with zero denominators',()=>{
  const r=playerHeroSample([]);expect(r).toMatchObject({nRaw:0,wins:0,winRate:null,lastPlayedAt:null,dataUpdatedAt:null});
  for(const metric of [r.kda,r.meanKills,r.meanDeaths,r.meanAssists,r.meanGpm,r.meanXpm])expect(metric).toEqual({value:null,nMaps:0});
});
it('KDA uses only complete triplets; each mean has its own denominator and true zeros remain data',()=>{
  const r=playerHeroSample([map(),map('2',{kills:10,deaths:2,assists:null,gpm:null,xpm:600,won:false})]);
  expect(r).toMatchObject({nRaw:2,wins:1,winRate:0.5,kda:{value:10,nMaps:1},meanKills:{value:7,nMaps:2},meanDeaths:{value:1,nMaps:2},
    meanAssists:{value:6,nMaps:1},meanGpm:{value:400,nMaps:1},meanXpm:{value:600,nMaps:1}});
  expect(playerHeroSample([map('1',{kills:0,deaths:0,assists:0,gpm:0,xpm:0})]).meanGpm).toEqual({value:0,nMaps:1});
});
it('aggregate KDA divides summed kills+assists by summed deaths instead of averaging map ratios',()=>{
  expect(playerHeroSample([map(),map('2',{kills:0,assists:0,deaths:10})]).kda).toEqual({value:1,nMaps:2});
});
it('duplicate map input fails closed and most recent play/sync dates are independent',()=>{
  expect(()=>playerHeroSample([map(),map()])).toThrow('duplicate_player_map');
  const r=playerHeroSample([map(),map('2',{startedAt:'2024-02-01T00:00:00.000Z',syncedAt:'2025-01-01T00:00:00.000Z'})]);
  expect(r.lastPlayedAt).toBe('2024-02-01T00:00:00.000Z');expect(r.dataUpdatedAt).toBe('2026-10-31T00:00:00.000Z');
});
