// Discover earlier history by metadata only. Resume from retained successful batches.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

const audit = JSON.parse(await readFile('docs/evidence/s3-09-wallachia-bo3-input-screen.json'));
const cutoff = new Map();
const lineups = [];
for (const edition of audit.editions) {
  const path = `.tools/s309-wallachia-opendota-${edition.edition}.json`;
  const bytes = await readFile(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), audit.sources.find(s=>s.path===path).sha256);
  const roster = JSON.parse(bytes).rows;
  for (const row of edition.rows.filter(r=>!r.overlap && !r.issues.length && r.observedFirstMap)) {
    const slots = roster.filter(p=>p.seriesId===row.seriesId && p.map===row.observedFirstMap);
    assert.equal(new Set(slots.map(p=>p.account)).size,10);
    for (const p of slots) {
      assert.match(p.account,/^[1-9]\d*$/);
      assert(Number.isSafeInteger(p.start) && p.start>0);
      cutoff.set(p.account,Math.min(p.start,cutoff.get(p.account)??Infinity));
    }
    lineups.push(slots.map(p=>p.account));
  }
}
const accounts = [...cutoff.keys()].sort();
const byAccount = new Map();
const receipts = [];
for (let i=0; i<accounts.length; i+=20) {
  const batch = accounts.slice(i,i+20);
  const values = batch.map(a=>`(${a}::bigint,${cutoff.get(a)})`).join(',');
  const query = `SELECT a.account::text AS account,m.match_id::text,m.leagueid::text,m.start_time,m.end_time
    FROM (VALUES ${values}) AS a(account,cutoff)
    CROSS JOIN LATERAL (SELECT DISTINCT p.match_id,g.leagueid,g.start_time,g.start_time+g.duration AS end_time
      FROM player_matches p JOIN matches g ON g.match_id=p.match_id JOIN leagues l ON l.leagueid=g.leagueid
      WHERE p.account_id=a.account AND l.tier IN ('professional','premium') AND g.leagueid NOT IN (17891,18058,18358)
      AND g.start_time>=1704067200 AND g.duration>0 AND g.start_time+g.duration<a.cutoff
      ORDER BY p.match_id DESC LIMIT 5) m ORDER BY a.account,m.match_id`;
  const url = new URL('https://api.opendota.com/api/explorer');
  url.searchParams.set('sql',query);
  const path = `.tools/s309-wallachia-prior-${i}.json`;
  let bytes;
  try { bytes = await readFile(path); }
  catch (error) {
    if (error.code!=='ENOENT') throw error;
    const response = await fetch(url,{redirect:'error',signal:AbortSignal.timeout(40000)});
    const body = Buffer.from(await response.arrayBuffer());
    assert(body.length<1_000_000);
    if (response.status!==200) throw new Error('prior metadata HTTP '+response.status+' '+body.toString('utf8').slice(0,320));
    const result = JSON.parse(body);
    assert.equal(result.err,null);
    assert(Array.isArray(result.rows));
    bytes = Buffer.from(JSON.stringify({query,fetchedAt:new Date().toISOString(),
      payloadSha256:createHash('sha256').update(body).digest('hex'),rows:result.rows})+'\n');
    await writeFile(path,bytes,{flag:'wx'});
    await delay(3000);
  }
  const snapshot = JSON.parse(bytes);
  assert.equal(snapshot.query,query);
  assert(snapshot.rows.length<=batch.length*5);
  for (const r of snapshot.rows) {
    assert.deepEqual(Object.keys(r).sort(),['account','end_time','leagueid','match_id','start_time']);
    assert(batch.includes(r.account) && Number.isSafeInteger(r.end_time) && Number.isSafeInteger(r.start_time));
    assert(r.start_time>=1704067200 && r.end_time>r.start_time && r.end_time<cutoff.get(r.account));
    assert.match(r.match_id,/^[1-9]\d*$/); assert.match(r.leagueid,/^[1-9]\d*$/);
    assert(!audit.editions.some(e=>e.edition===r.leagueid));
    if (!byAccount.has(r.account)) byAccount.set(r.account,new Set());
    const ids = byAccount.get(r.account);
    assert(!ids.has(r.match_id) && ids.size<5);
    ids.add(r.match_id);
  }
  receipts.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),fetchedAt:snapshot.fetchedAt});
}
const maps = new Set([...byAccount.values()].flatMap(ids=>[...ids]));
console.log(JSON.stringify({format:'wallachia-prior-map-discovery-v1',receipts,
  uniqueAccounts:accounts.length, accountsWithFive:accounts.filter(a=>byAccount.get(a)?.size===5).length,
  uniqueEarlierMapIds:maps.size, matchedSeries:lineups.length,
  seriesWithFiveCandidatesPerAccount:lineups.filter(players=>players.every(a=>byAccount.get(a)?.size===5)).length,
  verifiedForElo:false, registered:false, scoredSeries:0},null,2));
