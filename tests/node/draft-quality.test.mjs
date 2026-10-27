import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inspectMatch} from '../../scripts/lib/match-quality.mjs';
const data=JSON.parse(readFileSync(new URL('../fixtures/opendota-audit-anomalies-synthetic.json',import.meta.url),'utf8'));
assert.match(data._fixture_notice,/SYNTHETIC/);
const cases=Object.values(data.details);
const byTag=tag=>cases.find(m=>m._case===tag);

test('valid final 10 heroes and timeline must be separate signals',()=>{
  const q=inspectMatch(byTag('clean'),99000001);
  assert.equal(q.flags.final_heroes_valid,true);
  assert.equal(q.flags.draft_structurally_consistent,true);
  assert.equal(q.flags.draft_order_valid,null,'no patch/mode validator has been executed');
});
test('extra two picked heroes do not invalidate final hero lineup',()=>{
  const q=inspectMatch(byTag('twelve_picks'),99000002);
  assert.equal(q.flags.final_heroes_valid,true);
  assert.equal(q.flags.draft_picks_exact,false);
  assert.equal(q.flags.draft_heroes_match,false);
  assert.deepEqual(q.diagnostics.extra_hero_ids,[31,107]);
  assert.ok(q.anomalies.includes('PICK_COUNT_EXTRA'));
});
test('one extra pick is not silently dropped or declared a valid draft',()=>{
  const q=inspectMatch(byTag('eleven_picks'),99000003);
  assert.equal(q.flags.final_heroes_valid,true);
  assert.equal(q.flags.draft_structurally_consistent,false);
  assert.deepEqual(q.diagnostics.extra_hero_ids,[31]);
});
test('zero picks with raw ban does not imply a full draft',()=>{
  const q=inspectMatch(byTag('zero_picks'),99000004);
  assert.equal(q.flags.final_heroes_valid,true);
  assert.equal(q.flags.draft_actions,true);
  assert.equal(q.flags.draft_picks_exact,false);
  assert.ok(q.anomalies.includes('PICK_COUNT_MISSING'));
});
test('unknown team and series are independent from valid final heroes',()=>{
  const q=inspectMatch(byTag('no_team_or_series'),99000005);
  assert.equal(q.flags.teams_2,false);
  assert.equal(q.flags.series,false);
  assert.equal(q.flags.final_heroes_valid,true);
  assert.equal(q.flags.draft_structurally_consistent,true);
  assert.ok(q.anomalies.includes('SERIES_ID_UNKNOWN'));
});
test('wrong draft side invalidates timeline even with matching hero set',()=>{
  const q=inspectMatch(byTag('wrong_side'),99000006);
  assert.equal(q.flags.draft_heroes_match,true);
  assert.equal(q.flags.draft_teams_match,false);
  assert.ok(q.anomalies.includes('DRAFT_SIDE_MISMATCH'));
});
