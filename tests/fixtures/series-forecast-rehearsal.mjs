import {featureFixture} from './conditional-future-holdout.mjs';

export function rehearsalInput() {
  const {history} = featureFixture();
  // Move the existing synthetic history to an earlier year, including observation clocks.
  const shift = 3n*365n*86400000000n;
  for (const m of history.maps) for (const key of ['startedAtUs','completedAtUs','fetchedAtUs','labelVerifiedAtUs'])
    m[key] = String(BigInt(m[key])-shift);
  for (const p of history.identities) p.fetchedAt = new Date(Date.parse(p.fetchedAt)-Number(shift/1000n)).toISOString();
  for (const key of ['snapshotAtUs','warmupFromAtUs']) history[key] = String(BigInt(history[key])-shift);
  const selectedAtUs = String(BigInt(history.snapshotAtUs)-1n);
  const {teamA,teamB} = history.maps[0];
  return {format:'synthetic-bo3-rehearsal-v1',
    target:{provider:'synthetic',seriesId:'12',editionId:'8',bestOf:3,teamAId:'3',teamBId:'8',
      scheduledAt:'2099-01-01T00:00:00.000Z',scheduleObservedAt:'2024-01-01T00:00:00.000Z'},
    history,scenario:{schemaVersion:1,cutoffAtUs:history.snapshotAtUs,targetMatchId:null,teamA,teamB,
      lineup:{basis:'manual',source:'synthetic:owner',selectedAtUs,revision:'1'}}};
}
