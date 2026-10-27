import { describe, expect, it } from 'vitest';
import { rosterCoplay, rosterOverlap } from '../src/index.js';
const five = ['1','2','3','4','5'];
const record = (matchId: string, startedAtMs: number, playerIds: string[], side: 'radiant' | 'dire' = 'radiant') =>
  ({ matchId, startedAtMs, playerIds, side });

describe('roster continuity — descriptive only', () => {
  it('retains 4/5 players and six of ten structural connections on substitution', () => {
    expect(rosterOverlap(five, ['1','2','3','4','6']))
      .toEqual({ retainedPlayers: 4, changedPlayers: 1, retainedPairLinks: 6, lostPairLinks: 4 });
  });
  it('preserves exact lineup and all pair links when player order changes', () => {
    expect(rosterOverlap(five, ['5','3','1','4','2']).retainedPairLinks).toBe(10);
  });
  it('counts same-side coplay across historical organizations without team_id', () => {
    const history = [
      record('10',100,five),
      record('11',150,['1','2','3','4','6']),
      record('12',200,['1','2','3','7','8']),
    ];
    const result = rosterCoplay(['1','2','3','4','6'],history,250);
    expect(result.exactFiveMaps).toBe(1);
    expect(result.pairMaps['1:2']).toBe(3);
    expect(result.pairMaps['1:6']).toBe(1);
    expect(result.pairMaps['4:6']).toBe(1);
  });
  it('excludes any side on/after cutoff, incomplete sides, duplicates', () => {
    const history = [
      record('10',100,five),
      record('10',100,five),
      record('11',200,five),
      record('12',210,five),
      record('13',150,['1','2','3','4']),
    ];
    const result = rosterCoplay(five,history,200);
    expect(result.exactFiveMaps).toBe(1);
    expect(result.usableHistoricSides).toBe(1);
    expect(result.pairMaps['1:2']).toBe(1);
  });
  it('never matches players across the same historic map on opposite sides', () => {
    const history = [
      record('10',100,['1','2','3','7','8'],'radiant'),
      record('10',100,['4','5','6','9','10'],'dire'),
    ];
    const result = rosterCoplay(five,history,300);
    expect(result.exactFiveMaps).toBe(0);
    expect(result.pairMaps['1:4']).toBe(0);
    expect(result.pairMaps['1:2']).toBe(1);
  });
  it('rejects ambiguous/duplicate identities', () => {
    expect(() => rosterCoplay(['1','2','3','4','4'],[],100)).toThrow();
    expect(() => rosterOverlap(['1','2','3','4','5'],['1','2','3','4','x'])).toThrow();
  });
});
