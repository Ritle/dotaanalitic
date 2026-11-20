import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {createProviderRuntime,prepareCurrentProfile} from '../../packages/ingestion/dist/index.js';
import {profileScope,sha} from './wallachia-prior-replay-inputs.mjs';

async function loadProfile(id,runtime) {
  const path='.tools/s309-wallachia-prior-replay/profile-'+id+'.json';
  let bytes;
  try {bytes=await readFile(path);} catch(e) {
    if (e.code!=='ENOENT' || !runtime) throw e;
    let obs;
    try {obs=await runtime.client.getPlayer(id);} catch(err) {
      if(err.code!=='source_rate_limited' || !Number.isFinite(err.retryAfterMs) || err.retryAfterMs<1 || err.retryAfterMs>60000) throw err;
      await wait(err.retryAfterMs+100);
      obs=await runtime.client.getPlayer(id);
    }
    bytes=Buffer.from(JSON.stringify({schemaVersion:1,mode:'current_profile_capture',accountId:id,
      observation:{rawBody:obs.rawBody,source:obs.source}})+'\n');
    await writeFile(path,bytes,{flag:'wx'});
  }
  const capture=JSON.parse(bytes);
  const {source,rawBody}=capture.observation;
  assert.equal(source.endpoint,'/players/'+id);
  assert.equal(sha(rawBody),source.payloadSha256);
  const profile=JSON.parse(rawBody).profile;
  const ref={id,endpoint:source.endpoint,fetchedAt:source.fetchedAt,payloadSha256:source.payloadSha256,captureSha256:sha(bytes)};
  if (!profile) return {ref,review:null,reason:'PROFILE_MISSING'};
  if (String(profile.account_id)!==id || String(profile.steamid)!==String(76561197960265728n+BigInt(id))) {
    return {ref,review:null,reason:'NUMERIC_BINDING_UNVERIFIED'};
  }
  if (!(profile.name?.trim() || profile.personaname?.trim())) return {ref,review:null,reason:'PROFILE_ALIAS_MISSING'};
  const {review}=prepareCurrentProfile(capture,ref.captureSha256,{accountIds:[id],reviewedAt:source.fetchedAt});
  return {ref,review,reason:null};
}
export async function profileReviews(runtime) {
  const {accounts,maps}=await profileScope();
  const profiles=[];
  for (const id of accounts) profiles.push(await loadProfile(id,runtime));
  return {profiles,maps};
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const runtime=createProviderRuntime(process.env,10);
  try {
    const {profiles,maps}=await profileReviews(runtime);
    const report={format:'wallachia-numeric-profiles-v1',maps,profiles:profiles.map(p=>({...p.ref,verified:!!p.review,reason:p.reason}))};
    console.log(JSON.stringify(report,null,2));
  } finally {await runtime.close();}
}
