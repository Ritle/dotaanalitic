import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

const sha = bytes=>createHash('sha256').update(bytes).digest('hex');
const json = async path=>JSON.parse(await readFile(path));
const report = await json('docs/evidence/s3-09-wallachia-prior-map-discovery.json');
const scope = await json('docs/evidence/s3-09-wallachia-bo3-input-screen.json');
const targetLeagues = new Set(scope.editions.map(e=>e.edition));
const candidates = new Map();
for (const receipt of report.receipts) {
  const bytes = await readFile(receipt.path);
  assert.equal(sha(bytes),receipt.sha256);
  for (const row of JSON.parse(bytes).rows) {
    assert.match(row.match_id,/^[1-9]\d*$/);
    assert(!targetLeagues.has(row.leagueid));
    const previous = candidates.get(row.match_id) ?? [];
    previous.push(row);
    candidates.set(row.match_id,previous);
  }
}
const ids = [...candidates.keys()].sort();
const receipts = [], rejected = [], counts = new Map();
for (let i=0;i<ids.length;i+=65) {
  const batch = ids.slice(i,i+65);
  const query = `SELECT m.match_id::text,m.leagueid::text,m.start_time,m.start_time+m.duration AS end_time,
    l.tier,p.player_slot,p.account_id::text FROM matches m JOIN leagues l ON l.leagueid=m.leagueid
    LEFT JOIN player_matches p ON p.match_id=m.match_id WHERE m.match_id IN (${batch.join(',')})
    ORDER BY m.match_id,p.player_slot LIMIT 990`;
  const path = `.tools/s309-wallachia-prior-lineups-${i}.json`;
  let bytes;
  try {bytes = await readFile(path);}
  catch (error) {
    if (error.code!=='ENOENT') throw error;
    const url = new URL('https://api.opendota.com/api/explorer');
    url.searchParams.set('sql',query);
    const response = await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
    assert.equal(response.status,200);
    const raw = Buffer.from(await response.arrayBuffer());
    assert(raw.length<1_000_000);
    const body = JSON.parse(raw);
    assert.equal(body.err,null);
    bytes = Buffer.from(JSON.stringify({query, fetchedAt:new Date().toISOString(),payloadSha256:sha(raw),rows:body.rows})+'\n');
    await writeFile(path,bytes,{flag:'wx'});
    await delay(3000);
  }
  const capture = JSON.parse(bytes);
  assert.equal(capture.query,query);
  assert(capture.rows.length<990 && capture.rows.every(r=>batch.includes(r.match_id)));
  receipts.push({path,sha256:sha(bytes),fetchedAt:capture.fetchedAt});
  for (const map of batch) {
    const rows = capture.rows.filter(r=>r.match_id===map);
    const slots = new Set(rows.map(r=>r.player_slot));
    const prior = candidates.get(map);
    const accounts = new Set(rows.map(r=>r.account_id));
    const valid = rows.length===10 && accounts.size===10 && [0,1,2,3,4,128,129,130,131,132].every(s=>slots.has(s)) &&
      rows.every(r=>typeof r.account_id==='string' && /^[1-9]\d*$/.test(r.account_id) && BigInt(r.account_id)<4294967295n &&
        !targetLeagues.has(r.leagueid) && ['professional','premium'].includes(r.tier) &&
        prior.every(p=>p.leagueid===r.leagueid && p.start_time===r.start_time && p.end_time===r.end_time)) &&
      prior.every(p=>accounts.has(p.account));
    if (!valid) {rejected.push(map); continue;}
    for (const p of prior) {
      if (!counts.has(p.account)) counts.set(p.account,new Set());
      counts.get(p.account).add(map);
    }
  }
}
const editions = [];
for (const edition of scope.editions) {
  const path = `.tools/s309-wallachia-opendota-${edition.edition}.json`;
  const bytes = await readFile(path);
  assert.equal(sha(bytes),scope.sources.find(s=>s.path===path).sha256);
  const players = JSON.parse(bytes).rows;
  const matched = edition.rows.filter(r=>!r.overlap && !r.issues.length && r.observedFirstMap);
  const ready = matched.filter(row=>{
    const slots = players.filter(p=>p.seriesId===row.seriesId && p.map===row.observedFirstMap);
    assert.equal(new Set(slots.map(p=>p.account)).size,10);
    return slots.every(p=>(counts.get(p.account)?.size??0)>=5);
  });
  editions.push({edition:edition.edition, matched:matched.length, earlierLineupsFoundForAllTen:ready.length});
}
console.log(JSON.stringify({format:'wallachia-prior-lineup-check-v1', receipts, uniqueEarlierMaps:ids.length,
  structurallyComplete:ids.length-rejected.length,rejected,editions,
  canonicalEloHistoryBuilt:false, registered:false, scoredSeries:0},null,2));
