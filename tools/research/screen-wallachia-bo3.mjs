import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {parseMetadata} from './series-independent-scope.mjs';
import {prepareReleaseHistory} from '../../packages/db/dist/v1-release-inventory.js';

const sources = [];
async function read(path, expected) {
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expected) assert.equal(sha256, expected, path);
  sources.push({path, sha256});
  return bytes.toString('utf8');
}
const csv = await read('docs/evidence/s3-09-bo3-scope-metadata.csv', '6d8a7e9691e36770fe4f0b137434d3c6d8707ab5243ac82fa3bf18e36ebf8b1f');
const groups = parseMetadata(csv);
const starts = new Map(csv.trimEnd().split('\n').slice(1).map(row => {
  const [, map, , , start] = row.split(',');
  return [map, Number(start)];
}));
const floor = JSON.parse(await read('.tools/s304-dl30-exposure-ids-r2.json','d59ce0535a1a522b7ba517d62bd85a6fa7059b6d6a465359892718ba7c46b8d7'));
const ledger = JSON.parse(await read('docs/evidence/s3-09-series-exposure-review-r3.json','86cee1b6ad83ab110f7f0bd4f3f4b898ff92057303601e4b5a424219d52a7b18'));
const inventory = JSON.parse(await read('.tools/s309-wallachia-local-inventory-r1.json'));
const exposed = new Set([...floor.mapIds,...ledger.mapIds,...inventory.source.candidates.map(m=>m.matchId)]);
const seriesKeys = new Set([...floor.canonicalSeriesKeys,...ledger.seriesKeys]);
const {history} = prepareReleaseHistory(inventory);
assert.equal(history.syntheticOnly, false);
const slots = [0,1,2,3,4,128,129,130,131,132];
const editions = [];
for (const edition of ['17891','18058','18358']) {
  const capture = async source => {
    const snapshot = JSON.parse(await read(`.tools/s309-wallachia-${source}-${edition}.json`));
    assert.equal(snapshot.source, source);
    assert.equal(snapshot.edition, edition);
    return snapshot.rows;
  };
  const nodes = await capture('valve');
  const players = await capture('opendota');
  const localGroups = groups.filter(g=>g.league===edition && g.type==='1');
  const archived = nodes.filter(n=>n.type===1);
  assert.equal(new Set(archived.map(n=>n.seriesId)).size, archived.length);
  const allMapIds = nodes.flatMap(n=>n.maps);
  assert.equal(new Set(allMapIds).size, allMapIds.length);
  const ids = new Set([...localGroups.map(g=>g.id), ...archived.map(n=>n.seriesId)]);
  const rows = [];
  for (const seriesId of [...ids].sort()) {
    const v = archived.find(n=>n.seriesId===seriesId)?.maps ?? [];
    const od = localGroups.find(g=>g.id===seriesId)?.maps ?? [];
    const maps = [...new Set([...v,...od])].sort();
    const overlap = maps.some(m=>exposed.has(m)) || seriesKeys.has(JSON.stringify(['opendota',seriesId]));
    const issues = [];
    if (v.length!==od.length || !v.every(m=>od.includes(m))) issues.push('MAP_LIST_DIFFERS');
    if (![2,3].includes(maps.length)) issues.push('MAP_COUNT_REQUIRES_REVIEW');
    const roster = players.filter(p=>p.seriesId===seriesId);
    const first = od.length ? Math.min(...od.map(m=>starts.get(m))) : null;
    const accounts = roster.map(p=>p.account);
    const distinctSlots = new Set(roster.map(p=>p.slot));
    const full = roster.length===10 && slots.every(s=>distinctSlots.has(s)) && new Set(accounts).size===10 &&
      accounts.every(a=>typeof a==='string' && /^[1-9]\d*$/.test(a) && BigInt(a)<4294967295n) &&
      roster.every(p=>od.includes(p.map) && p.map===roster[0].map && p.start===first && starts.get(p.map)===first) &&
      od.filter(m=>starts.get(m)===first).length===1;
    let minEarlierMaps = null;
    if (full) {
      const cutoff = BigInt(first)*1000000n;
      const counts = new Map(accounts.map(a=>[a, new Set()]));
      for (const m of history.maps) {
        if (maps.includes(m.matchId) || BigInt(m.completedAtUs)>=cutoff || BigInt(m.startedAtUs)>=cutoff) continue;
        for (const p of [...m.teamA,...m.teamB]) counts.get(p.accountId)?.add(m.matchId);
      }
      minEarlierMaps = Math.min(...Array.from(counts.values(), s=>s.size));
    }
    rows.push({seriesId, overlap, issues, observedFirstMap:full ? roster[0].map : null, minEarlierMaps});
  }
  const matched = rows.filter(r=>!r.overlap && !r.issues.length);
  editions.push({edition, openDotaBO3:localGroups.length, valveBO3:archived.length, union:rows.length,
    exposed:rows.filter(r=>r.overlap).length, matchedUnexposed:matched.length,
    tenObserved:matched.filter(r=>r.observedFirstMap!==null).length,
    localHistoryReady:matched.filter(r=>r.minEarlierMaps!==null && r.minEarlierMaps>=5).length, rows});
}
console.log(JSON.stringify({format:'wallachia-bo3-input-screen-v1',inventoryAsOf:inventory.source.request.snapshotAt,
  sources, editions, globalExposureComplete:false, scoredSeries:0, registered:false},null,2));
