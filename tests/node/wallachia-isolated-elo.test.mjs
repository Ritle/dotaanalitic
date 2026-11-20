import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const dir=new URL('../../docs/evidence/',import.meta.url);
const bytes=await readFile(new URL('s3-09-wallachia-series-registers.json.gz',dir));
const hash=b=>createHash('sha256').update(b).digest('hex');
const captures=JSON.parse(gunzipSync(bytes));
const [valve,panda]=captures.map(c=>{
  assert.equal(hash(c.content),c.sha256);
  return JSON.parse(c.content);
});
const result=JSON.parse(await readFile(new URL('s3-09-wallachia-isolated-elo-replay.json',dir)));

test('league series IDs outside a completed bracket node do not inflate the BO3 denominator',()=>{
  assert.equal(hash(bytes),'9a438091827ef04003face2cc5d4fa0119998b410bf10ea6dc6ec8ae8515c0d0');
  for (const [i,s] of result.summary.entries()) {
    const nodes=valve.snapshots[i].graph.filter(n=>n.type===2 && n.completed && n.started);
    assert.equal(nodes.length,46);
    assert.equal(s.valveNodes,nodes.length);
    const meetings=panda[i].rows.filter(m=>m.format===3 && m.status==='finished' && !m.forfeit);
    assert.equal(new Set(meetings.map(m=>m.id)).size,nodes.length);
    assert.equal(s.pandaScoreFinished,meetings.length);
    for(const row of meetings) for(const g of row.games) {
      assert.deepEqual(Object.keys(g).sort(),['beginAt','forfeit','nativeId','position','status']);
    }
  }
  const unlinked=result.summary.flatMap(s=>s.orphans);
  assert.deepEqual(unlinked.map(r=>[r.seriesId,r.sameDayNodes]),[['957770',['957814']],['987711',['987722']]]);
  assert(result.replay.find(r=>r.seriesId==='987722').membershipHeld);
});

test('both canonical Elo replays compare identical series and retain unresolved and short-history lineups',()=>{
  assert.deepEqual(result.baseline.map(r=>r.seriesId),result.replay.map(r=>r.seriesId));
  for (const [stage,expected] of [['baseline',13],['replay',80]]) {
    const rows=result[stage].filter(r=>!r.membershipHeld);
    assert.equal(rows.length,114);
    assert.equal(rows.filter(r=>r.status==='ready').length,expected);
    for(const row of rows.filter(r=>r.status==='ready')) {
      assert(row.minimumMaps>=5);
      assert.match(row.featureSha256,/^[a-f0-9]{64}$/);
    }
  }
  assert.equal(result.import.eligible,126);
  assert.equal(result.import.accepted,127);
  assert.equal(result.import.excluded.length,1);
  assert.equal(result.import.before.predictions,result.import.after.predictions);
  assert.equal(result.import.before.artifacts,result.import.after.artifacts);
  assert.equal(result.targetSeriesScored,0);
});
