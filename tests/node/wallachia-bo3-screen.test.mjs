import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {gunzipSync} from 'node:zlib';

const evidence = new URL('../../docs/evidence/',import.meta.url);
const read = async name=>JSON.parse(await readFile(new URL(name,evidence)));
const screen = await read('s3-09-wallachia-bo3-input-screen.json');
const prior = await read('s3-09-wallachia-prior-map-discovery.json');
const checked = await read('s3-09-wallachia-prior-lineups.json');
const archive = JSON.parse(gunzipSync(await readFile(new URL('s3-09-wallachia-public-inputs.json.gz',evidence))));
const source = path=>JSON.parse(archive.find(row=>row.path===path).content);

test('retained metadata accounts for the Valve-only BO3, conflicting map lists and exposed series',()=>{
  const all = screen.editions.flatMap(e=>e.rows);
  assert.equal(new Set(all.map(s=>s.seriesId)).size,140);
  assert.equal(all.filter(s=>s.overlap).length,20);
  assert(all.find(s=>s.seriesId==='987711').issues.includes('MAP_LIST_DIFFERS'));
  assert(all.find(s=>s.seriesId==='969607').issues.includes('MAP_COUNT_REQUIRES_REVIEW'));
  assert.equal(all.filter(s=>!s.overlap && s.issues.length===0 && s.observedFirstMap).length,115);
  assert.equal(screen.scoredSeries,0);
  for (const e of screen.editions) {
    const nodes = source(`.tools/s309-wallachia-valve-${e.edition}.json`).rows;
    assert.deepEqual(new Set(nodes.filter(n=>n.type===1).map(n=>n.seriesId)),new Set(e.rows.map(r=>r.seriesId)));
    for (const n of nodes) assert.deepEqual(Object.keys(n).sort(),['maps','seriesId','type']);
  }
});

test('source bytes replay exact checksums and every candidate precedes its player’s earliest target cutoff',()=>{
  const pinned = [...screen.sources.filter(s=>/wallachia-(valve|opendota)-/.test(s.path)),...prior.receipts,...checked.receipts];
  assert.equal(pinned.length,archive.length);
  const cutoffs = new Map();
  const targetMaps = new Set();
  for (const {path,sha256} of pinned) {
    const text = archive.find(row=>row.path===path).content;
    assert.equal(createHash('sha256').update(text).digest('hex'),sha256);
  }
  for (const e of screen.editions) {
    const matched = new Set(e.rows.filter(r=>!r.overlap && !r.issues.length && r.observedFirstMap).map(r=>r.observedFirstMap));
    for (const n of source(`.tools/s309-wallachia-valve-${e.edition}.json`).rows) for (const id of n.maps) targetMaps.add(id);
    for (const p of source(`.tools/s309-wallachia-opendota-${e.edition}.json`).rows) {
      if (matched.has(p.map)) cutoffs.set(p.account,Math.min(cutoffs.get(p.account)??Infinity,p.start));
    }
  }
  const ids = new Set();
  for (const {path} of prior.receipts) for (const p of source(path).rows) {
    assert(p.end_time < cutoffs.get(p.account) && !targetMaps.has(p.match_id));
    ids.add(p.match_id);
  }
  assert.equal(ids.size,204);
  assert.deepEqual(new Set(checked.receipts.flatMap(r=>source(r.path).rows.map(p=>p.match_id))),ids);
  assert.equal(checked.editions.reduce((n,e)=>n+e.earlierLineupsFoundForAllTen,0),114);
  assert.equal(checked.canonicalEloHistoryBuilt,false);
});
