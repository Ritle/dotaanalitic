/** Deterministic descriptive metrics: all samples MUST already be filtered to pro-only, point-in-time observations. */
export interface BinaryRecord { won: boolean }
export interface Rate { games: number; wins: number; winRate: number | null }

export function winRate(records: readonly BinaryRecord[]): Rate {
  const games = records.length;
  const wins = records.filter(row => row.won).length;
  return { games, wins, winRate: games === 0 ? null : wins / games };
}
export function aggregateKda(records: readonly { kills: number; assists: number; deaths: number }[]): number | null {
  if (records.length === 0) return null;
  const killsAndAssists = records.reduce((sum, row) => sum + row.kills + row.assists, 0);
  const deaths = records.reduce((sum, row) => sum + row.deaths, 0);
  return killsAndAssists / Math.max(1, deaths);
}
/** Stable unordered hero pair key (hero IDs are safe positive 32-bit ints). */
export function allyHeroPairKey(a: number, b: number): string {
  if (a === b) throw new Error('A hero cannot be paired with itself');
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) throw new Error('Invalid hero ID');
  return `${Math.min(a, b)}:${Math.max(a, b)}`;
}
export function enemyMatchupKey(heroA: number, heroB: number): string {
  if (heroA === heroB) throw new Error('Duplicate hero in same match');
  return `${heroA}:${heroB}`;
}

export { rosterOverlap, rosterCoplay } from './roster.js';
export type { HistoricProSide } from './roster.js';
export { predictLogistic } from './model-inference.js';
export type { LogisticArtifact } from './model-inference.js';
