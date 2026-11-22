import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sha} from '../../tools/research/exposure-ledger-core.mjs';
import {inventoryFromReview,reconcile,wallachiaInventory} from '../../tools/research/reconcile-dl30-pc-inventories.mjs';

const key=(provider,id)=>JSON.stringify([provider,id]);
function review() {
  return {format:'series-exposure-review-v1',capturedAt:'2026-11-22T10:00:00.000Z',registrationAllowed:false,completeGlobalInventory:false,
    mapIds:['9007199254740993'],seriesKeys:[key('opendota','123'),key('pandascore','123')],
    summary:{maps:1,openDotaSeries:1,pandaScoreSeries:1}};
}
function file(name,body) {
  const content=JSON.stringify(body);
  return {path:'.tools/s309-wallachia-'+name+'.json',content,sha256:sha(content)};
}
function inputs() {
  const native=file('opendota-123',{source:'opendota',rows:[{map:'80',seriesId:'100'}]});
  const valve=file('valve-123',{source:'valve',rows:[{maps:['77'],seriesId:'100'},{maps:['88'],seriesId:'200'}]});
  const graph=file('series-graph',{opendota:{rows:[]},snapshots:[{series:[{match_ids:['80'],series_id:100}],graph:[{games:[{id:'82'}]}]}]});
  const panda=file('edition-registers',[{edition:'42',total:1,rows:[{id:'200',edition:'42'}]}]);
  const raw=JSON.stringify({rows:[{match_id:'91'}]});
  return [[native,valve],[graph,panda],{format:'wallachia-extra-priors-v1',rows:[{match_id:'92'}],receipts:[{raw,sha256:sha(raw)}]}];
}
test('same number in different namespaces remains distinct and bigint maps stay exact',()=>{
  const base=inventoryFromReview(review()),peer={...base,mapIds:[...base.mapIds,'11']};
  const result=reconcile(base,{local:base,peer});
  assert.deepEqual(result.added,{mapIds:['11'],openDotaSeriesIds:[],pandaScoreMeetingIds:[]});
  assert.deepEqual(result.total,{mapIds:2,openDotaSeriesIds:1,pandaScoreMeetingIds:1});
  assert.equal(result.unionSha256,reconcile(base,{peer,local:base}).unionSha256);
  assert.deepEqual(base.mapIds,['9007199254740993']);
});
test('review rejects duplicate IDs, bad counts, unscoped or noncanonical series keys',()=>{
  for(const modify of [r=>r.mapIds.push(r.mapIds[0]),r=>r.summary.maps++,r=>r.seriesKeys.push(r.seriesKeys[0]),
    r=>r.seriesKeys[0]=key('valve','123'),r=>r.seriesKeys[0]='["opendota", "123"]',r=>r.mapIds=[9007199254740992]]){
    const r=review();modify(r);assert.throws(()=>inventoryFromReview(r));
  }
});
test('whole series via verified sibling and all observed prior maps, even when absent from selected history',()=>{
  const args=inputs(),result=wallachiaInventory(...args);
  assert.deepEqual(result.inventory,{mapIds:['77','80','82','88','91','92'],openDotaSeriesIds:['100'],pandaScoreMeetingIds:['200']});
  assert.deepEqual(result.valveSeriesWithoutVerifiedOpenDotaLink,['200']);
  assert.equal(result.mapsWithoutSeriesInTheseArchives,4);
  assert.deepEqual(wallachiaInventory(args[0].reverse(),args[1].reverse(),args[2]),result);
});
test('contradictory map/series links, edited bytes and incomplete source pages fail closed',()=>{
  for(const modify of [a=>a[0].push(file('opendota-124',{source:'opendota',rows:[{map:'80',seriesId:'101'}]})),
    a=>a[0].push(file('valve-124',{source:'valve',rows:[{maps:['88'],seriesId:'300'}]})),
    a=>a[0].push(file('valve-124',{source:'valve',rows:[{maps:['80'],seriesId:'300'}]})),
    a=>a[0][0].content+=' ',a=>a[2].receipts[0].raw+=' ',
    a=>a[1][1]=file('edition-registers',[{edition:'42',total:2,rows:[]}]),
    a=>a[1][1]=file('edition-registers',[{edition:'42',total:2,rows:[{edition:'42',id:'5'},{edition:'42',id:'5'}]}])]){
    const args=inputs();modify(args);assert.throws(()=>wallachiaInventory(...args));
  }
});
