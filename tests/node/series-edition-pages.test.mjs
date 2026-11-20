import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {assembleEditionPages} from '../../tools/research/series-edition-pages.mjs';

const fixture=async name=>JSON.parse(await readFile(new URL('../fixtures/'+name,import.meta.url),'utf8'));
const original=await fixture('bo3-edition-pages.json');
const expected=await fixture('bo3-edition-inventory.json');

test('all numbered pages reconstruct the independent inventory in source order',()=>{
  const bundle=structuredClone(original);
  bundle.pages.reverse();
  assert.deepEqual(assembleEditionPages(bundle),{inventory:expected,issues:[]});
  bundle.pages[0].matches.pop();
  bundle.pages.forEach(page=>{page.total=5;});
  assert.deepEqual(assembleEditionPages(bundle),{inventory:{...expected,matches:expected.matches.slice(0,5)},issues:[]});
});

test('missing pages at either end or in the middle and a short response leave the inventory incomplete',()=>{
  for(const number of [1,2,3]) {
    const bundle=structuredClone(original);
    bundle.pages.splice(number-1,1);
    const {inventory,issues}=assembleEditionPages(bundle);
    assert.equal(inventory.complete,false);
    assert.deepEqual(issues,[{code:'MISSING_PAGES',from:number,to:number}]);
  }
  const bundle=structuredClone(original);
  bundle.pages[2].matches.pop();
  assert.deepEqual(assembleEditionPages(bundle).issues,[{code:'PAGE_LENGTH',page:3,expected:2,received:1}]);
});

test('page count, snapshot and repeated pages are checked even if match IDs look valid',()=>{
  for(const [modify,code] of [
    [pages=>{pages[1].total=5;},'CHANGED_SOURCE'],
    [pages=>{pages[2].snapshot='new';},'CHANGED_SOURCE'],
    [pages=>pages.push(pages[1]),'DUPLICATE_PAGE'],
    [pages=>pages.push({...pages[2],number:4,matches:[]}),'UNEXPECTED_PAGE']
  ]) {
    const bundle=structuredClone(original);
    modify(bundle.pages);
    const {inventory,issues}=assembleEditionPages(bundle);
    assert.equal(inventory.complete,false);
    assert.equal(issues[0].code,code);
  }
});

test('duplicate match IDs and matches outside the reviewed league, edition or stages block completeness',()=>{
  for(const [patch,code] of [[{id:'8801'},'DUPLICATE_MATCH'],[{league_id:'99'},'OUTSIDE_SCOPE'],
    [{serie_id:'881'},'OUTSIDE_SCOPE'],[{tournament_id:'99'},'OUTSIDE_SCOPE']]) {
    const bundle=structuredClone(original);
    Object.assign(bundle.pages[1].matches[0],patch);
    const {inventory,issues}=assembleEditionPages(bundle);
    assert.equal(inventory.complete,false);
    assert.equal(inventory.matches.length,5);
    assert.equal(issues[0].code,code);
    assert.equal(issues[0].page,2);
  }
});

test('only an observed empty page confirms a zero total',()=>{
  const bundle={...original,pages:[]};
  assert.equal(assembleEditionPages(bundle).inventory.complete,false);
  bundle.pages=[{number:1,snapshot:'empty',total:0,matches:[]}];
  assert.deepEqual(assembleEditionPages(bundle),{inventory:{...expected,matches:[]},issues:[]});
});

test('preserves exact provider IDs and unknowns and rejects unexpected fields including outcomes',()=>{
  const bundle=structuredClone(original);
  const row=bundle.pages[0].matches[0];
  Object.assign(row,{id:'9007199254740993',number_of_games:null,status:'unknown'});
  assert.deepEqual(assembleEditionPages(bundle).inventory.matches[0],
    {matchId:'9007199254740993',stageId:'71',bestOf:null,status:'unknown'});
  row.winner_id='74';
  assert.throws(()=>assembleEditionPages(bundle));
});
