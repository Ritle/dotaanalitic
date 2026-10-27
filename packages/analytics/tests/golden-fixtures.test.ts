import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { rosterOverlap, rosterCoplay, winRate } from '../src/index.js';
const load = (name: string) => JSON.parse(readFileSync(new URL(`../../../tests/${name}`, import.meta.url), 'utf8'));
describe('cross-project golden fixtures', () => {
 it('retained roster pairs match combinatorial truth', () => {
  for (const c of load('fixtures/roster-scenarios.json').cases) {
   expect(rosterOverlap(c.before,c.after)).toMatchObject({retainedPlayers:c.retainedPlayers,retainedPairLinks:c.retainedPairLinks});
  }
 });
 it('future maps excluded; previous team tags intentionally ignored', () => {
  const f=load('fixtures/roster-scenarios.json');
  const {expectedExactFiveMaps,expectedPair,expectedPairMaps}=f;
  const data=rosterCoplay(f.actual,f.history,f.cutoffAtMs);
  expect(data.exactFiveMaps).toBe(expectedExactFiveMaps);
  expect(data.pairMaps[expectedPair]).toBe(expectedPairMaps);
 });
 it('rate calculations match golden', () => {
  for(const c of load('golden/metric-cases.json').cases) {
   expect(winRate(c.wins.map((won:boolean)=>({won}))).winRate).toBe(c.expectedRate);
  }
 });
});
