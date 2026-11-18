#!/usr/bin/env node
/** Offline replay. Checks saved evidence, never scores or contacts a provider/database. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {auditSeriesCorpus} from './series-corpus-core.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const [path,expectedSha,exposurePath,...extra]=process.argv.slice(2);
try{
  assert(path&&exposurePath&&/^[a-f0-9]{64}$/.test(expectedSha)&&!extra.length,'usage');
  const bytes=await readFile(path);assert.equal(sha(bytes),expectedSha,'export_sha');
  const saved=JSON.parse(bytes);assert.equal(saved.format,'series-corpus-export-v1','format');
  const exposureBytes=await readFile(exposurePath);assert.equal(sha(exposureBytes),saved.exposure.sha256,'exposure_sha');
  for(const p of saved.plans)assert.equal(p.request.snapshotAt,saved.snapshotAt,'snapshot_binding');
  assert.deepEqual(auditSeriesCorpus(saved.plans,JSON.parse(exposureBytes).result.ledger),saved.audit,'audit_replay');
  console.log(JSON.stringify({verified:true,...saved.audit.summary,deployable:false}));
}catch(e){console.error('Series corpus replay failed: '+(e?.message??'unknown'));process.exitCode=1;}
