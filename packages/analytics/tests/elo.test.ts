import {expect,it} from 'vitest';
import {replayElo,type EloMap} from '../src/elo.js';
const five=(n:number)=>Array.from({length:5},(_,i)=>String(n+i));
const map=(id:string,start:number,radiant=five(1),dire=five(11),won=true,known=start+10):EloMap=>({matchId:id,startedAtUs:String(start),endedAtUs:String(start+10),availableAtUs:String(known),radiantPlayerIds:radiant,direPlayerIds:dire,radiantWin:won});
it('freezes prior strength before outcome updates, with one map observation and ten participant states',()=>{
  const r=replayElo([map('1',100)],'200');expect(r.observations).toHaveLength(1);expect(r.players).toHaveLength(10);
  expect(r.observations[0]?.radiant).toMatchObject({ratingBefore:1500,priorPlayers:5,ratingDelta:16});
  expect(r.observations[0]?.dire.ratingDelta).toBe(-16);expect(r.players[0]?.rating).toBe(1516);
});
it('import order is irrelevant and future outcomes cannot change earlier opponent strength',()=>{
  const one=map('1',100),two=map('2',200),future=map('3',300);
  const r=replayElo([two,future,one],'500');expect(r).toEqual(replayElo([one,two,future],'500'));
  expect(r.observations[0]?.radiant.ratingBefore).toBe(1500);expect(r.observations[1]?.dire.ratingBefore).toBe(1484);
  expect(replayElo([one,two],'250').observations[0]).toEqual(r.observations[0]);
});
it('simultaneous starts freeze the same state independently of bigint ID ordering',()=>{
  const r=replayElo([map('9007199254740994',100),map('9007199254740993',100)],'200');
  expect(r.observations.every(m=>m.radiant.ratingBefore===1500&&m.dire.ratingBefore===1500)).toBe(true);
  expect(r.players[0]?.rating).toBe(1532);
});
it('overlapping and delayed-result maps cannot teach the next start before availability',()=>{
  const r=replayElo([map('1',100,five(1),five(11),true,300),map('2',200)],'250');
  expect(r.observations[1]?.radiant.ratingBefore).toBe(1500);expect(r.observations[0]?.updateApplied).toBe(false);
  expect(r.players[0]?.maps).toBe(1);expect(replayElo([map('1',100,five(1),five(11),true,300)],'299').players).toEqual([]);
});
it('availability at the exact next start is usable, one microsecond later is not',()=>{
  const one=map('1',100,five(1),five(11),true,200);
  expect(replayElo([one,map('2',200)],'250').observations[1]?.radiant.ratingBefore).toBe(1516);
  expect(replayElo([{...one,availableAtUs:'201'},map('2',200)],'250').observations[1]?.radiant.ratingBefore).toBe(1500);
  expect(replayElo([one,map('2',200)],'200').observations).toHaveLength(1);
});
it('new five starts from its player histories and replacement is not a fixed penalty',()=>{
  const first=map('1',100),fresh=map('2',200,five(21),five(31)),partial=map('3',300,['1','2','3','4','41'],five(51));
  const r=replayElo([first,fresh,partial],'400');expect(r.observations[1]?.radiant.ratingBefore).toBe(1500);
  expect(r.observations[2]?.radiant.ratingBefore).toBeCloseTo((4*1516+1500)/5);
  expect(r.observations[2]?.radiant.priorPlayers).toBe(1);
});
it('same win rate against strong and weak opponents gives distinct opponent-adjusted changes',()=>{
  const strong=five(1),weak=five(11),a=five(21),b=five(31);
  const r=replayElo([map('1',100,strong,weak),map('2',200,a,strong),map('3',300,b,weak)],'400');
  const x=r.observations[1]!,y=r.observations[2]!;
  expect(x.dire.ratingBefore).toBeGreaterThan(y.dire.ratingBefore);expect(x.radiant.ratingDelta).toBeGreaterThan(y.radiant.ratingDelta);
});
it('side swap reverses result orientation but preserves every participant rating',()=>{
  const one=map('1',100);const swapped={...one,radiantPlayerIds:one.direPlayerIds,direPlayerIds:one.radiantPlayerIds,radiantWin:false};
  expect(replayElo([one],'200').players).toEqual(replayElo([swapped],'200').players);
});
it('duplicate maps, duplicate identities and impossible outcome clocks fail closed',()=>{
  expect(()=>replayElo([map('1',100),map('1',100)],'300')).toThrow();
  expect(()=>replayElo([map('1',100,five(1),five(1))],'300')).toThrow('invalid_canonical_fives');
  expect(()=>replayElo([map('1',100,five(1),five(11),true,99)],'300')).toThrow('invalid_map_clocks');
  expect(replayElo([],'100').players).toEqual([]);
});
