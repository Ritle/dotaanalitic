import { describe, expect, it } from 'vitest';
import { aggregateKda, allyHeroPairKey, enemyMatchupKey, winRate } from '../src/index.js';
describe('descriptive statistics', () => {
  it('keeps a missing rate null', () => expect(winRate([])).toEqual({ games: 0, wins: 0, winRate: null }));
  it('calculates team win rate from maps', () => expect(winRate([{ won: true }, { won: false }]).winRate).toBe(0.5));
  it('calculates aggregated KDA and handles zero deaths', () => {
    expect(aggregateKda([{ kills: 4, assists: 6, deaths: 0 }])).toBe(10);
    expect(aggregateKda([])).toBeNull();
  });
  it('deduplicates unordered ally pairs', () => expect(allyHeroPairKey(3, 7)).toBe(allyHeroPairKey(7, 3)));
  it('preserves direction of enemy matchup', () => expect(enemyMatchupKey(3, 7)).not.toBe(enemyMatchupKey(7, 3)));
});
