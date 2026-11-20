import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';

const read=name=>readFileSync(new URL('../../docs/evidence/s3-09-wallachia-'+name,import.meta.url));
const json=name=>JSON.parse(read(name));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ext=json('extended-elo.json'),profiles=json('profile-elo.json');
const registers=JSON.parse(gunzipSync(read('series-registers.json.gz')));
const graph=JSON.parse(registers[0].content);
const targetMaps=new Set(graph.snapshots.flatMap(s=>s.series.flatMap(r=>r.match_ids.map(String))));
const available=rows=>rows.filter(r=>!r.membershipHeld && r.status==='ready').map(r=>r.seriesId);

test('additional observations have complete numeric slots and finish before a screened player’s earliest cutoff',()=>{
  const archive=JSON.parse(gunzipSync(read('extended-priors.json.gz')));
  assert.equal(archive.receipts.length,4);
  for (const receipt of archive.receipts) assert.equal(sha(receipt.raw),receipt.sha256);
  const ids=new Set(archive.rows.map(p=>p.match_id));
  assert.equal(ids.size,28);
  for (const id of ids) {
    assert(!targetMaps.has(id));
    const rows=archive.rows.filter(p=>p.match_id===id);
    assert.deepEqual(rows.map(p=>p.player_slot),[0,1,2,3,4,128,129,130,131,132]);
    assert.equal(new Set(rows.map(p=>p.account_id)).size,10);
    assert(rows.some(p=>p.end_time<archive.cutoffs[p.account_id]));
  }
});

test('same 114 first-map lineups progress from 80 to 110 to 113 without opening held-out outcomes',()=>{
  assert.deepEqual(available(ext.replay),available(profiles.baseline));
  assert.deepEqual([ext.baseline,ext.replay,profiles.replay].map(rows=>available(rows).length),[80,110,113]);
  for (const rows of [ext.baseline,ext.replay,profiles.baseline,profiles.replay]) {
    assert.equal(new Set(rows.filter(r=>!r.membershipHeld).map(r=>r.seriesId)).size,114);
    assert(rows.filter(r=>r.status==='ready').every(r=>r.minimumMaps>=5));
  }
  assert.deepEqual(profiles.replay.filter(r=>!r.membershipHeld && r.status!=='ready').map(r=>r.seriesId),['955802']);
  for (const report of [ext,profiles]) {
    assert.equal(report.targetSeriesScored,0);
    assert.equal(report.registered,false);
    assert.equal(report.import.before.predictions,report.import.after.predictions);
  }
});

test('each completed bracket node uses the same map IDs as the native series and historic Git screen remains scoped',()=>{
  for (const s of graph.snapshots) for (const n of s.graph.filter(n=>n.type===2 && n.completed && n.started)) {
    const native=s.series.find(r=>String(r.series_id)===n.seriesId);
    assert.deepEqual(n.games.map(g=>g.id).sort(),native.match_ids.map(String).sort());
  }
  const git=json('git-exposure.json');
  assert.deepEqual(git.gitBlobs,{text:3406});
  assert.equal(git.hits.length,0);
  assert.equal(git.globalInventoryComplete,false);
});
