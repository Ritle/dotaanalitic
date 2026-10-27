import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=(p)=>JSON.parse(fs.readFileSync(new URL(p,import.meta.url),'utf8'));
test('complete synthetic match has 10 unique participant slots, 5 per side',()=>{
 const m=read('../fixtures/opendota/synthetic-pro-map.json');
 assert.match(m._fixture_notice,/SYNTHETIC/);
 assert.equal(m.players.length,10);
 const slots=m.players.map(p=>p.player_slot);
 assert.equal(new Set(slots).size,10);
 assert.deepEqual(slots.filter(x=>x<128),[0,1,2,3,4]);
 assert.deepEqual(slots.filter(x=>x>=128),[128,129,130,131,132]);
});
test('partial fixture cannot accidentally be considered a complete pro game',()=>{
 const m=read('../fixtures/opendota/incomplete-map.json');
 assert.ok(m.players.length<10 || m.duration<=0 || m.radiant_win===null);
});
test('roster fixtures contain consistent combinatorial counts',()=>{
 const d=read('../fixtures/roster-scenarios.json');
 for(const c of d.cases){
  const common=c.before.filter(x=>c.after.includes(x)).length;
  assert.equal(common,c.retainedPlayers);
  assert.equal((common < 2 ? 0 : common*(common-1)/2),c.retainedPairLinks);
 }
});
test('metric golden results are reproducible',()=>{
 for(const c of read('../golden/metric-cases.json').cases){
  const actual=c.wins.length?c.wins.filter(Boolean).length/c.wins.length:null;
  assert.equal(actual,c.expectedRate);
 }
});
