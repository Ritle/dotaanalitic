import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const metadata = 'docs/evidence/s3-09-bo3-scope-metadata.csv';
const ledgerPath = '.tools/s304-series-reconciliation-r1.json';
const baseline = '525110947ad71771229ca7a43369e77154ec01ac';
const windows = new Map([
  ['17891', ['2025-03-08', '2025-03-17']],
  ['18058', ['2025-04-19', '2025-04-28']],
  ['18358', ['2025-06-21', '2025-06-30']]
]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function parseMetadata(csv) {
  const [header, ...lines] = csv.trimEnd().split('\n');
  assert.equal(header, 'leagueid,match_id,series_id,series_type,start_time');
  const maps = new Set();
  const series = new Map();
  for (const line of lines) {
    assert.match(line, /^\d+,[1-9]\d*,[1-9]\d*,[12],[1-9]\d*$/);
    const [league, map, id, type, started] = line.split(',');
    const window = windows.get(league);
    assert(window && Number(started) * 1000 >= Date.parse(window[0]) &&
      Number(started) * 1000 < Date.parse(window[1]), 'outside edition');
    assert(!maps.has(map), 'duplicate map');
    maps.add(map);
    const group = series.get(id) ?? {id, league, type, maps:[]};
    assert(group.type === type && group.league === league, 'inconsistent series');
    group.maps.push(map);
    series.set(id, group);
  }
  return [...series.values()];
}

// Baseline documents can contain bare numeric references in another namespace.
// Treat a hit as requiring review. It cannot establish an alias.
function baselineMentions(ids) {
  const result = spawnSync('git', ['grep','-I','-o','-h','-w','-F','-f','-',baseline,'--','docs','reports'],
    {input:ids.join('\n')+'\n', encoding:'utf8', maxBuffer:16*1024*1024});
  if (result.error) throw result.error;
  assert(result.status === 0 || result.status === 1, 'baseline search failed');
  return new Set(result.stdout.trim().split(/\s+/).filter(Boolean));
}

async function oldLedger() {
  let bytes;
  try { bytes = await readFile(ledgerPath); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  assert.equal(sha(bytes), 'ddffc46af97c411bba20e5d3c407a30584f8be076e8511f866df3eb73173c9e3', 'archive checksum');
  const {maps,canonicalSeriesKeys} = JSON.parse(bytes).result.ledger;
  return {maps:new Set(maps.map(m=>m.matchId)), series:new Set(canonicalSeriesKeys)};
}

export function summarize(groups, local, mentions, ledger) {
  return [...windows.keys()].map(league => {
    const selected = groups.filter(g=>g.league === league);
    const bo3 = selected.filter(g=>g.type === '1');
    const localHit = g => local.series.has(g.id) || g.maps.some(m=>local.maps.has(m));
    const textHit = g => mentions.has(g.id) || g.maps.some(m=>mentions.has(m));
    const ledgerHit = g => ledger && (ledger.series.has(JSON.stringify(['opendota',g.id])) ||
      g.maps.some(m=>ledger.maps.has(m)));
    return {league, bo3:bo3.length, bo5:selected.length-bo3.length,
      localHits:bo3.filter(localHit).length, baselineTextHits:bo3.filter(textHit).length,
      archivedHits:ledger ? bo3.filter(ledgerHit).length : null,
      remainingCandidates:bo3.filter(g=>!localHit(g) && !textHit(g) && !ledgerHit(g)).length};
  });
}

async function main() {
  const bytes = await readFile(metadata);
  assert.equal(sha(bytes), '6d8a7e9691e36770fe4f0b137434d3c6d8707ab5243ac82fa3bf18e36ebf8b1f');
  const groups = parseMetadata(bytes.toString('utf8'));
  const mentions = baselineMentions(groups.flatMap(g=>[g.id,...g.maps]));
  const ledger = await oldLedger();
  const db = new pg.Client({connectionString:process.env.DATABASE_URL});
  await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const maps = await db.query(`SELECT id::text AS id FROM matches UNION
      SELECT provider_match_id FROM provider_ingest_receipts WHERE provider='opendota'`);
    const series = await db.query(`SELECT provider_series_id AS id FROM series WHERE provider='opendota' UNION
      SELECT source_payload->>'series_id' FROM provider_ingest_receipts WHERE provider='opendota' AND source_payload ? 'series_id'`);
    const local = {maps:new Set(maps.rows.map(r=>r.id)), series:new Set(series.rows.map(r=>r.id).filter(id=>/^[1-9]\d*$/.test(id)))};
    await db.query('COMMIT');
    const events = summarize(groups,local,mentions,ledger);
    console.log(JSON.stringify({status:'candidate_scope_only', archivedLedgerAvailable:ledger !== null,
      checkedMapIds:local.maps.size, checkedOpendotaSeriesIds:local.series.size, events}, null, 2));
  } finally { await db.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
