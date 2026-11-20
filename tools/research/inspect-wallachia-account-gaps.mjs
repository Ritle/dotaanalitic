import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createProviderRuntime} from '../../packages/ingestion/dist/index.js';
import {createDatabase,readAccountEvidence,resolveIdentity} from '../../packages/db/dist/index.js';
import {publicInputs,sha} from './wallachia-prior-replay-inputs.mjs';

const report=JSON.parse(await readFile('docs/evidence/s3-09-wallachia-isolated-elo-replay.json'));
const target=report.replay.filter(r=>!r.membershipHeld);
const targetUnbound=new Set(target.flatMap(r=>r.unboundAccounts??[]));
const {priors}=await publicInputs();
const accounts=[...new Set([...targetUnbound,...[...priors.values()].flat().map(r=>r.account_id)])];
const db=createDatabase(process.env.DATABASE_URL);
let absent;
try {
  const evidence=await readAccountEvidence(db,accounts);
  absent=accounts.filter(a=>resolveIdentity(evidence,a,null).status!=='verified');
} finally {await db.destroy();}
const runtime=createProviderRuntime(process.env,3);
try {
  const obs=await runtime.client.getProPlayers();
  assert.equal(sha(obs.rawBody),obs.source.payloadSha256);
  const registry=JSON.parse(obs.rawBody);
  const gaps=absent.sort().map(account=>{
    const rows=registry.filter(p=>String(p.account_id)===account);
    const numericProof=rows.length===1 && String(rows[0].steamid)===String(76561197960265728n+BigInt(account));
    return {account,target:targetUnbound.has(account),affectedTargets:target.filter(r=>r.unboundAccounts?.includes(account)).map(r=>r.seriesId),
      registryRows:rows.length,steamIdMatches:numericProof,alias:numericProof?rows[0].name??null:null};
  });
  const result={format:'wallachia-account-gaps-v1',endpoint:obs.source.endpoint,fetchedAt:obs.source.fetchedAt,
    payloadSha256:obs.source.payloadSha256,gaps,changedIdentities:0};
  await writeFile('docs/evidence/s3-09-wallachia-account-gaps.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({gaps:gaps.length,numericMatches:gaps.filter(p=>p.steamIdMatches).length,target:gaps.filter(p=>p.target)}));
} finally {await runtime.close();}
