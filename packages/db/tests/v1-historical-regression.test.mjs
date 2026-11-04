import {expect,it} from 'vitest';
import {mkdtemp,readFile,writeFile,readdir,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {prepareV1Data} from '../src/v1-data.js';
import {buildV1DevelopmentFeatures} from '../src/v1-features.js';
import {v1Fixture} from './v1-data-fixtures.js';
import {checkV1HistoricalRegression} from '../../../scripts/lib/v1-historical-regression.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const root=fileURLToPath(new URL('../../../',import.meta.url));
function fixture(){const dataset=prepareV1Data(v1Fixture()),sourceSha=sha(JSON.stringify(dataset));
  return {dataset,sourceSha,reference:{...buildV1DevelopmentFeatures(dataset),sourceFileSha256:sourceSha,code:[]}};}
it('replays verified development rows with strict completed-history links and preserves synthetic provenance',()=>{
  const {dataset,sourceSha,reference}=fixture(),before=JSON.stringify({dataset,reference});
  expect(checkV1HistoricalRegression(dataset,reference,sourceSha,sha(JSON.stringify(reference)))).toMatchObject({
    status:'passed',summary:{maps:6,featureReady:1,unavailable:5},matchedRows:6,runtimeParityRows:6,
    syntheticOnly:true,evaluation:'not_performed',deployable:false,teamAWinProbability:null});
  expect(JSON.stringify({dataset,reference})).toBe(before);
});
it('rejects an unbound or altered reference and replays dataset eligibility instead of trusting saved summaries',()=>{
  const {dataset,sourceSha,reference}=fixture(),check=(d,g)=>checkV1HistoricalRegression(d,g,sourceSha,'a'.repeat(64));
  expect(()=>check(dataset,{...reference,sourceFileSha256:'b'.repeat(64)})).toThrow('REFERENCE_SOURCE_MISMATCH');
  expect(()=>check(dataset,{...reference,summary:{maps:0}})).toThrow('FEATURE_REPLAY_MISMATCH');
  expect(()=>check(dataset,{...reference,teamAWinProbability:0.5})).toThrow('FEATURE_REPLAY_MISMATCH');
  const changed=structuredClone(dataset);changed.report.summary.eligibleMaps++;
  expect(()=>check(changed,reference)).toThrow('v1_dataset_fingerprint_mismatch');
});
it('CLI is deterministic offline, refuses overwrites and SHA tampering without leaking private payloads',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dota-historical-')),source=join(dir,'source.json'),golden=join(dir,'golden.json');
  const {dataset,sourceSha,reference}=fixture(),goldenBytes=JSON.stringify(reference),referenceSha=sha(goldenBytes);
  const invoke=(out,digest=sourceSha,ref=referenceSha)=>spawnSync(process.execPath,[join(root,'scripts/check-v1-historical-regression.mjs'),
    'verify',source,digest,golden,ref,join(dir,out)],{cwd:root,encoding:'utf8',timeout:15000,windowsHide:true,
    env:{...process.env,DATABASE_URL:'invalid-offline-sentinel',OPENDOTA_API_KEY:'synthetic-private-sentinel'}});
  try{
    await writeFile(source,JSON.stringify(dataset));await writeFile(golden,goldenBytes);
    const a=invoke('a.json');expect(a.error).toBeUndefined();expect(a.status).toBe(0);
    expect(JSON.parse(a.stdout)).toMatchObject({status:'passed',evaluation:'not_performed',deployable:false,teamAWinProbability:null});
    expect(invoke('b.json').status).toBe(0);const bytes=await readFile(join(dir,'a.json'));
    expect(await readFile(join(dir,'b.json'))).toEqual(bytes);
    expect(invoke('a.json').stderr).toContain('OUTPUT_EXISTS');expect(await readFile(join(dir,'a.json'))).toEqual(bytes);
    await writeFile(source,'synthetic-private-sentinel invalid JSON');
    const invalid=invoke('bad.json');expect(invalid.status).toBe(1);expect(invalid.stderr).toContain('SOURCE_SHA_MISMATCH');
    expect(invalid.stderr).not.toContain('synthetic-private-sentinel');expect(await readdir(dir)).not.toContain('bad.json');
    await writeFile(source,JSON.stringify(dataset));expect(invoke('wrong-ref.json',sourceSha,'0'.repeat(64)).stderr).toContain('REFERENCE_SHA_MISMATCH');
    expect(await readdir(dir)).not.toContain('wrong-ref.json');
  }finally{for(const name of await readdir(dir))await unlink(join(dir,name));await rmdir(dir);}
},60000);
