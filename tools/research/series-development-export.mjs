#!/usr/bin/env node
/** Canonical local inventory only. Existing verifier uses SHARE locks; no business writes. */
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createDatabase} from '../../packages/db/dist/index.js';
import {V1DataRepository} from '../../packages/db/dist/v1-data-repository.js';
const [output,...extra]=process.argv.slice(2),sha=b=>createHash('sha256').update(b).digest('hex');
let db;
try{
  assert(output&&/^\.tools\/[a-zA-Z0-9_-]+\.json$/.test(output)&&!extra.length,'output_scope');
  const files=['tools/research/series-development-export.mjs','package.json','pnpm-lock.yaml'];
  for(const dir of ['packages/contracts/dist','packages/db/dist','packages/db/migrations'])for(const name of (await readdir(dir)).sort())
    if(name.endsWith('.js')||name.endsWith('.sql'))files.push(dir+'/'+name);
  const code=await Promise.all(files.sort().map(async path=>({path,sha256:sha(await readFile(path))})));
  const snapshotAt=new Date().toISOString();db=createDatabase(process.env.DATABASE_URL);
  const inventory=await new V1DataRepository(db).exportReleaseInventory({fromAt:'2024-01-01T00:00:00.000Z',toAt:snapshotAt,snapshotAt,maxMaps:5000},code);
  const bytes=JSON.stringify(inventory)+'\n';assert(Buffer.byteLength(bytes)<=128*1024**2,'inventory_limit');
  await writeFile(output,bytes,{flag:'wx'});console.log(JSON.stringify({sha256:sha(bytes),snapshotAt,maps:inventory.source.candidates.length,providerHttp:0,businessWrites:0}));
}catch(e){console.error(e?.code==='EEXIST'?'Output exists; choose a new path.':'Series development export failed: '+(e?.code??'invalid_input_or_database'));process.exitCode=1;}
finally{await db?.destroy();}
