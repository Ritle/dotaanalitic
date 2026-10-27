/**
 * Deterministic roster *descriptors* only; these are NOT trained predictor coefficients.
 * Inputs must be confirmed pro-map sides, with known five identities, and match-start epochs in ms.
 * Opaque string IDs prevent BIGINT loss. No team_id filter: previous organizations count.
 */
export interface HistoricProSide {
  readonly matchId: string;
  readonly startedAtMs: number;
  readonly playerIds: readonly string[];
  readonly side: 'radiant' | 'dire';
}

function validatedFive(ids: readonly string[]): Set<string> {
  if (ids.length !== 5 || ids.some(id => !/^\d+$/.test(id)) || new Set(ids).size !== 5) {
    throw new Error('Expected five unique canonical player IDs');
  }
  return new Set(ids);
}
function pairKeys(ids: readonly string[]): string[] {
  const sorted = [...ids].sort((a, b) => {
    const aa = BigInt(a), bb = BigInt(b);
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  });
  const keys: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) keys.push(`${sorted[i]}:${sorted[j]}`);
  }
  return keys;
}

export function rosterOverlap(expected: readonly string[], actual: readonly string[]) {
  const prev = validatedFive(expected);
  const next = validatedFive(actual);
  const retainedPlayers = [...next].filter(x => prev.has(x)).length;
  const retainedPairLinks = retainedPlayers * (retainedPlayers - 1) / 2;
  return { retainedPlayers, changedPlayers: 5 - retainedPlayers, retainedPairLinks, lostPairLinks: 10 - retainedPairLinks };
}

export function rosterCoplay(actual: readonly string[], history: readonly HistoricProSide[], cutoffAtMs: number) {
  validatedFive(actual);
  if (!Number.isFinite(cutoffAtMs)) throw new Error('Invalid cutoff');
  const pairMaps: Record<string, number> = Object.fromEntries(pairKeys(actual).map(p => [p, 0]));
  const target = new Set(actual);
  const seen = new Set<string>();
  let exactFiveMaps = 0;
  let usableHistoricSides = 0;
  for (const side of history) {
    if (!Number.isFinite(side.startedAtMs) || side.startedAtMs >= cutoffAtMs || side.startedAtMs < 0) continue;
    if (!/^[0-9]+$/.test(side.matchId)) continue;
    const sideKey = `${side.matchId}:${side.side}`;
    if (seen.has(sideKey)) continue;
    if (side.playerIds.length !== 5 || new Set(side.playerIds).size !== 5 || side.playerIds.some(id => !/^\d+$/.test(id))) continue;
    seen.add(sideKey);
    usableHistoricSides++;
    if (side.playerIds.every(id => target.has(id))) exactFiveMaps++;
    const participants = side.playerIds.filter(id => target.has(id));
    for (const key of pairKeys(participants)) pairMaps[key]++;
  }
  return { exactFiveMaps, pairMaps, usableHistoricSides };
}
