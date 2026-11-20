import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {link,mkdir,readFile,unlink,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {retryAfterMilliseconds} from '../../packages/ingestion/dist/opendota/client.js';
import {assembleEditionPages,pageFormat} from './series-edition-pages.mjs';

const maxPages=100;
const maxAttempts=3;
const maxRetryDelayMs=30_000;
const sha256=text=>createHash('sha256').update(text).digest('hex');
const serialize=value=>JSON.stringify(value)+'\n';

async function readIfPresent(path) {
  try {return await readFile(path,'utf8');}
  catch(error) {if(error.code!=='ENOENT') throw error;}
}

async function publish(path,bytes) {
  const temporary=join(dirname(path),randomUUID()+'.tmp');
  await writeFile(temporary,bytes,{flag:'wx',flush:true});
  try {
    await link(temporary,path);
  } catch(error) {
    if(error.code!=='EEXIST') throw error;
    assert(await readFile(path,'utf8')===bytes,'conflicting saved file: '+path);
  } finally {
    await unlink(temporary);
  }
}

async function fetchPage(url,number) {
  for(let attempt=1;attempt<=maxAttempts;attempt++) {
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(5000)});
    if(response.ok) return response.json();
    await response.body?.cancel();
    assert(response.status===429,'page '+number+' returned HTTP '+response.status);
    const delay=retryAfterMilliseconds(response.headers.get('retry-after'),Date.now());
    assert(delay!==null && delay<=maxRetryDelayMs && attempt<maxAttempts,
      'page '+number+' paused at HTTP 429 (Retry-After '+(delay===null?'unknown':delay+' ms')+')');
    await sleep(delay);
  }
}

// The rehearsal accepts only the synthetic page contract served on IPv4 loopback.
export async function collectEditionPages(plan,directory,output) {
  const {endpoint,...bundle}=plan;
  assert(!Object.hasOwn(bundle,'pages'),'plan must start without pages');
  const url=new URL(endpoint);
  assert(url.protocol==='http:' && url.hostname==='127.0.0.1' && !url.username && !url.password && !url.search && !url.hash,
    'synthetic source must be a plain loopback HTTP endpoint');
  bundle.pages=[];
  assembleEditionPages(bundle);
  await mkdir(directory,{recursive:true});
  await publish(join(directory,'plan.json'),serialize({endpoint:url.href,...bundle}));

  let last=1;
  for(let number=1;number<=last;number++) {
    const path=join(directory,'page-'+number+'.json');
    const saved=await readIfPresent(path);
    if(saved===undefined) {
      url.searchParams.set('page',String(number));
      url.searchParams.set('per_page',String(bundle.pageSize));
      if(number>1) url.searchParams.set('snapshot',bundle.pages[0].snapshot);
    }
    const page=saved===undefined ? await fetchPage(url,number) : JSON.parse(saved);
    assert(page?.number===number,'unexpected response number for page '+number);
    bundle.pages.push(page);
    const {issues}=assembleEditionPages(bundle);
    // A verified prefix can omit only the remaining suffix of the numbered pages.
    const issue=issues.find(item=>item.code!=='MISSING_PAGES' || item.from!==number+1);
    assert(!issue,'page '+number+' refused: '+JSON.stringify(issue));
    last=Math.max(1,Math.ceil(bundle.pages[0].total/bundle.pageSize));
    assert(last<=maxPages,'synthetic page count exceeds '+maxPages);
    if(saved===undefined) await publish(path,serialize(page));
  }
  const bytes=serialize(bundle);
  await publish(output,bytes);
  return {pages:bundle.pages.length,sha256:sha256(bytes)};
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [plan,directory,output,...extra]=process.argv.slice(2);
  assert(plan && directory && output && !extra.length,
    'usage: collect-series-edition-pages.mjs PLAN.json CHECKPOINT_DIR PAGES.json');
  const result=await collectEditionPages(JSON.parse(await readFile(plan,'utf8')),directory,output);
  console.log(JSON.stringify(result));
}
