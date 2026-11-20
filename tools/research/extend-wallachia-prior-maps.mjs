import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {createDatabase} from '../../packages/db/dist/index.js';
import {plan,publicInputs,sha} from './wallachia-prior-replay-inputs.mjs';

const baseline=await readFile('docs/evidence/s3-09-wallachia-isolated-elo-replay.json');
assert.equal(sha(baseline),'c8a823c390af408a49947e36121424d200a88c3669af4616c3d43658dc740ef0');
const rows=JSON.parse(baseline).replay.filter(r=>!r.membershipHeld);
const accounts=[...new Set(rows.flatMap(r=>r.shortHistory??[]).map(p=>p.account))].sort();
assert.equal(accounts.length,16);
const {priors,archive}=await publicInputs();
const cutoffs=new Map(), targetIds=new Set();
for (const item of archive) {
  if (item.path.includes('-valve-')) {
    for (const r of JSON.parse(item.content).rows) for (const id of r.maps) targetIds.add(id);
  }
  if (item.path.includes('-opendota-')) {
    for (const p of JSON.parse(item.content).rows) {
      targetIds.add(p.map);
      if (accounts.includes(p.account)) cutoffs.set(p.account,Math.min(cutoffs.get(p.account)??Infinity,p.start));
    }
  }
}
const candidates=new Map(),receipts=[];
const slots=[0,1,2,3,4,128,129,130,131,132];
const excluded=new Set(['17891','18058','18358']);
for (let offset=0;offset<accounts.length;offset+=4) {
  const batch=accounts.slice(offset,offset+4);
  for (const a of batch) assert(/^\d+$/.test(a) && Number.isSafeInteger(cutoffs.get(a)));
  const values=batch.map(a=>'('+a+'::bigint,'+cutoffs.get(a)+')').join(',');
  const query=`WITH candidate AS (SELECT a.account,m.* FROM (VALUES ${values}) a(account,cutoff)
    CROSS JOIN LATERAL (SELECT g.match_id,g.leagueid,g.start_time,g.start_time+g.duration AS end_time,l.tier
    FROM player_matches p JOIN matches g ON p.match_id=g.match_id JOIN leagues l ON l.leagueid=g.leagueid
    WHERE p.account_id=a.account AND g.start_time>=1704067200 AND g.duration>0 AND g.start_time+g.duration<a.cutoff
    AND g.leagueid NOT IN (17891,18058,18358) AND l.tier IN ('professional','premium') AND g.series_id>0
    AND g.radiant_team_id>0 AND g.dire_team_id>0 AND g.radiant_team_id<>g.dire_team_id
    ORDER BY g.match_id DESC LIMIT 40) m)
    SELECT c.account::text,c.match_id::text,c.leagueid::text,c.start_time,c.end_time,c.tier,
    array_agg(p.account_id::text ORDER BY p.player_slot) AS players,array_agg(p.player_slot ORDER BY p.player_slot) AS slots
    FROM candidate c JOIN player_matches p ON p.match_id=c.match_id
    GROUP BY c.account,c.match_id,c.leagueid,c.start_time,c.end_time,c.tier ORDER BY c.account,c.match_id LIMIT 161`;
  const path='.tools/s309-wallachia-extra-candidates-'+offset+'.json';
  let receipt;
  try {receipt=JSON.parse(await readFile(path));}
  catch (e) {
    if (e.code!=='ENOENT') throw e;
    const url=new URL('https://api.opendota.com/api/explorer');
    url.searchParams.set('sql',query);
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(40000)});
    assert.equal(response.status,200);
    const raw=await response.text();
    assert(raw.length<1000000);
    const payload=JSON.parse(raw);
    assert.equal(payload.err,null);
    receipt={query,fetchedAt:new Date().toISOString(),sha256:sha(raw),raw};
    await writeFile(path,JSON.stringify(receipt)+'\n',{flag:'wx'});
    await delay(3000);
  }
  assert.equal(receipt.query,query);
  assert.equal(sha(receipt.raw),receipt.sha256);
  const data=JSON.parse(receipt.raw).rows;
  assert(data.length<=batch.length*40);
  receipts.push(receipt);
  for (const r of data) {
    assert.deepEqual(Object.keys(r).sort(),['account','end_time','leagueid','match_id','players','slots','start_time','tier']);
    assert(batch.includes(r.account) && /^\d+$/.test(r.match_id) && /^\d+$/.test(r.leagueid));
    assert(!excluded.has(r.leagueid) && !targetIds.has(r.match_id) && ['professional','premium'].includes(r.tier));
    assert(Number.isSafeInteger(r.start_time) && Number.isSafeInteger(r.end_time) && r.start_time>=1704067200 &&
      r.end_time>r.start_time && r.end_time<cutoffs.get(r.account));
    if (priors.has(r.match_id) || String(r.slots)!==String(slots) || r.players.length!==10 ||
        new Set(r.players).size!==10 || !r.players.includes(r.account) ||
        !r.players.every(a=>typeof a==='string' && /^[1-9]\d*$/.test(a) && BigInt(a)<4294967295n)) continue;
    const lineup=r.players.map((account_id,i)=>({match_id:r.match_id,leagueid:r.leagueid,tier:r.tier,
      start_time:r.start_time,end_time:r.end_time,account_id,player_slot:slots[i]}));
    if (candidates.has(r.match_id)) assert.deepEqual(lineup,candidates.get(r.match_id));
    candidates.set(r.match_id,lineup);
  }
}
const db=createDatabase(process.env.DATABASE_URL);
let selection;
try {selection=await plan(db,candidates);} finally {await db.destroy();}
const ordered=selection.missing.sort((a,b)=>candidates.get(b)[0].start_time-candidates.get(a)[0].start_time ||
  (BigInt(a)>BigInt(b)?-1:1));
const selected=new Set();
for (const account of accounts) {
  const earlier=ordered.filter(id=>candidates.get(id)[0].end_time<cutoffs.get(account) &&
    candidates.get(id).some(p=>p.account_id===account));
  for (const id of earlier.slice(0,7)) selected.add(id);
}
const extraRows=[...selected].sort().flatMap(id=>candidates.get(id));
const artifact={format:'wallachia-extra-priors-v1',baseReport:sha(baseline),cutoffs:Object.fromEntries(cutoffs),
  receipts,uniqueNewCandidates:candidates.size,alreadyPresent:selection.existing.length,unbound:selection.unbound.length,
  verifiedMissing:ordered.length,rows:extraRows};
const bytes=gzipSync(JSON.stringify(artifact));
const output='docs/evidence/s3-09-wallachia-extended-priors.json.gz';
try {await writeFile(output,bytes,{flag:'wx'});} catch (e) {if(e.code!=='EEXIST') throw e;assert.deepEqual(await readFile(output),bytes);}
console.log(JSON.stringify({accounts:accounts.length,candidates:candidates.size,existing:selection.existing.length,
  verifiedMissing:ordered.length,selected:selected.size,sha256:sha(bytes)}));
