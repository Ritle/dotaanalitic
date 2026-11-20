import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import test from 'node:test';
import {editionHttpComparison} from '../fixtures/bo3-edition-http-comparison.mjs';
import {compareEditionHttpPasses} from '../../tools/research/series-edition-pages.mjs';

test('two local HTTP passes with equal totals report both IDs in a one-match substitution',async t=>{
  const source=editionHttpComparison();
  source.passes[1][1].body[1].id='8807';
  const server=createServer((req,res)=>{
    const query=new URL(req.url,'http://127.0.0.1').searchParams;
    const {headers,body}=source.passes[Number(query.get('pass'))][Number(query.get('page'))-1];
    res.writeHead(200,{'content-type':'application/json',...headers});
    res.end(JSON.stringify(body));
  });
  const listening=once(server,'listening');
  server.listen(0,'127.0.0.1');
  await listening;
  t.after(()=>new Promise((resolve,reject)=>server.close(error=>error ? reject(error) : resolve())));
  const base='http://127.0.0.1:'+server.address().port;
  const passes=[];
  for(const [pass,pages] of source.passes.entries()) {
    const captured=[];
    for(const {headers} of pages) {
      const response=await fetch(base+'/?pass='+pass+'&page='+headers['x-page']);
      assert.equal(response.status,200);
      captured.push({headers:Object.fromEntries(Object.keys(headers).map(name=>[name,response.headers.get(name)])),
        body:await response.json()});
    }
    passes.push(captured);
  }
  const {inventory,comparison}=compareEditionHttpPasses({...source,passes});
  assert.equal(inventory.complete,false);
  assert.deepEqual(comparison,{passes:[{total:6,issues:[]},{total:6,issues:[]}],
    firstOnly:['8804'],secondOnly:['8807'],changedMatches:[]});
});

test('reordered pages and rows agree, while an unchanged ID with a new format disagrees',()=>{
  const source=editionHttpComparison();
  source.passes[1].reverse();
  source.passes[1][0].body.reverse();
  assert.equal(compareEditionHttpPasses(source).inventory.complete,true);
  source.passes[1][0].body[1].number_of_games=3;
  const {inventory,comparison}=compareEditionHttpPasses(source);
  assert.equal(inventory.complete,false);
  assert.deepEqual(comparison.changedMatches,['8805']);
});

test('missing pages, changed totals and wrong per-page headers block comparison completeness',()=>{
  const source=editionHttpComparison();
  source.passes[0][1].headers['x-total']='7';
  source.passes[1][0].headers['x-per-page']='3';
  source.passes[1].pop();
  const {inventory,comparison}=compareEditionHttpPasses(source);
  assert.equal(inventory.complete,false);
  assert.deepEqual(comparison.passes.map(pass=>pass.issues.map(issue=>issue.code)),[
    ['CHANGED_SOURCE'],['MISSING_PAGES','PAGE_SIZE_HEADER']
  ]);
  delete source.passes[0][0].headers['x-page'];
  assert.throws(()=>compareEditionHttpPasses(source),/x-page/);
});
