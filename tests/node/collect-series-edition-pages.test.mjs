import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {collectEditionPages} from '../../tools/research/collect-series-edition-pages.mjs';
import {assembleEditionPages} from '../../tools/research/series-edition-pages.mjs';

const {pages,...scope}=JSON.parse(await readFile(new URL('../fixtures/bo3-edition-pages.json',import.meta.url),'utf8'));
const inventory=JSON.parse(await readFile(new URL('../fixtures/bo3-edition-inventory.json',import.meta.url),'utf8'));
const cli=fileURLToPath(new URL('../../tools/research/collect-series-edition-pages.mjs',import.meta.url));

async function withSource(t,respond) {
  const root=await mkdtemp(join(tmpdir(),'bo3-http-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const requests=[];
  const server=createServer((req,res)=>{
    const query=new URL(req.url,'http://127.0.0.1').searchParams;
    const request={number:Number(query.get('page')),snapshot:query.get('snapshot'),pageSize:Number(query.get('per_page')),
      at:performance.now()};
    requests.push(request);
    respond(res,request);
  });
  const listening=once(server,'listening');
  server.listen(0,'127.0.0.1');
  await listening;
  t.after(()=>new Promise((resolve,reject)=>server.close(error=>error ? reject(error) : resolve())));
  const directory=join(root,'checkpoint');
  const output=join(root,'pages.json');
  const plan={endpoint:'http://127.0.0.1:'+server.address().port+'/edition',...scope};
  const planPath=join(root,'source.json');
  await writeFile(planPath,JSON.stringify(plan));
  return {requests,plan,directory,output,
    run:()=>promisify(execFile)(process.execPath,[cli,planPath,directory,output],{timeout:10000})};
}

function send(res,page) {
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify(page));
}

test('CLI resumes a saved prefix across processes, waits on 429 and produces the original inventory',async t=>{
  let interrupted=true,limited=false;
  const {run,requests,output,directory}=await withSource(t,(res,{number})=>{
    if(number===2 && interrupted) return res.destroy();
    if(number===2 && !limited) {
      limited=true;
      return res.writeHead(429,{'retry-after':'1'}).end();
    }
    send(res,pages[number-1]);
  });
  await assert.rejects(run(),/fetch failed/);
  assert.deepEqual(JSON.parse(await readFile(join(directory,'page-1.json'),'utf8')),pages[0]);
  await assert.rejects(readFile(output),{code:'ENOENT'});
  requests.length=0;
  interrupted=false;
  const {stdout}=await run();
  assert.deepEqual(requests.map(r=>[r.number,r.snapshot,r.pageSize]),[
    [2,'fixture-v1',2],[2,'fixture-v1',2],[3,'fixture-v1',2]
  ]);
  assert(requests[1].at-requests[0].at>=990,'retry must respect the one-second pause');
  const bytes=await readFile(output,'utf8');
  assert.deepEqual(assembleEditionPages(JSON.parse(bytes)),{inventory,issues:[]});
  assert.deepEqual(JSON.parse(stdout),{pages:3,sha256:createHash('sha256').update(bytes).digest('hex')});
  await run();
  assert.equal(requests.length,3);
});

test('resume rejects a changed snapshot and preserves the earlier checkpoint',async t=>{
  let unavailable=true;
  const {plan,directory,output,requests}=await withSource(t,(res,{number})=>{
    if(number===1) return send(res,pages[0]);
    if(unavailable) return res.writeHead(503).end();
    send(res,{...pages[number-1],snapshot:'fixture-v2'});
  });
  await assert.rejects(collectEditionPages(plan,directory,output),/HTTP 503/);
  unavailable=false;
  await assert.rejects(collectEditionPages(plan,directory,output),/CHANGED_SOURCE/);
  assert.deepEqual(requests.map(r=>[r.number,r.snapshot]),[[1,null],[2,'fixture-v1'],[2,'fixture-v1']]);
  assert.deepEqual(JSON.parse(await readFile(join(directory,'page-1.json'),'utf8')),pages[0]);
  await assert.rejects(readFile(join(directory,'page-2.json')),{code:'ENOENT'});
  await assert.rejects(readFile(output),{code:'ENOENT'});
  await assert.rejects(collectEditionPages({...plan,scope:{...scope.scope,editionId:'881'}},directory,output),
    /conflicting saved file/);
  assert.equal(requests.length,3);
});

test('a persistent 429 caps retries and never publishes a bundle',async t=>{
  const {plan,directory,output,requests}=await withSource(t,res=>res.writeHead(429,{'retry-after':'0'}).end());
  await assert.rejects(collectEditionPages(plan,directory,output),/paused at HTTP 429/);
  assert.deepEqual(requests.map(r=>r.number),[1,1,1]);
  await assert.rejects(readFile(output),{code:'ENOENT'});
});
