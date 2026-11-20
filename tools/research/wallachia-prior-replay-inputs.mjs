import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {createDatabase,sql,readAccountEvidence,resolveIdentity} from '../../packages/db/dist/index.js';
import {createProviderRuntime,HeroesSchema,LeaguesSchema,MatchSourceSchema} from '../../packages/ingestion/dist/index.js';

export const cache = '.tools/s309-wallachia-prior-replay';
export const sha = b=>createHash('sha256').update(b).digest('hex');
export async function publicInputs(scope='original') {
  assert(['original','extended'].includes(scope));
  const bytes = await readFile('docs/evidence/s3-09-wallachia-public-inputs.json.gz');
  assert.equal(sha(bytes),'eabf0361d8183fd9969e9b05bd950350292965dd6deb4565fbb6912dc4185e0e');
  const archive = JSON.parse(gunzipSync(bytes));
  const targets = new Set(), priors = new Map();
  for (const item of archive) {
    assert.equal(sha(item.content),item.sha256);
    const {rows} = JSON.parse(item.content);
    if (item.path.includes('-valve-')) for (const row of rows) for (const id of row.maps) targets.add(id);
    if (item.path.includes('-prior-lineups-')) for (const row of rows) {
      assert(!['17891','18058','18358'].includes(row.leagueid));
      if (!priors.has(row.match_id)) priors.set(row.match_id,[]);
      priors.get(row.match_id).push(row);
    }
  }
  assert.equal(priors.size,204);
  if (scope==='extended') {
    const extra=await readFile('docs/evidence/s3-09-wallachia-extended-priors.json.gz');
    assert.equal(sha(extra),'33f92636e328062180ce46d0ba42041bbe333aa3bcfacf63bce3920721b575e7');
    const extension=JSON.parse(gunzipSync(extra));
    assert.equal(extension.format,'wallachia-extra-priors-v1');
    const original=new Set(priors.keys());
    for (const row of extension.rows) {
      assert(!original.has(row.match_id) && !['17891','18058','18358'].includes(row.leagueid));
      if (!priors.has(row.match_id)) priors.set(row.match_id,[]);
      priors.get(row.match_id).push(row);
    }
  }
  for (const id of priors.keys()) assert(!targets.has(id));
  return {priors,archive};
}

const gapFile='docs/evidence/s3-09-wallachia-account-gaps.json';
export async function profileScope() {
  const gaps=JSON.parse(await readFile(gapFile)).gaps;
  const targets=gaps.filter(g=>g.target).map(g=>g.account);
  const {priors,archive}=await publicInputs();
  const starts=archive.filter(r=>r.path.includes('-opendota-')).flatMap(r=>JSON.parse(r.content).rows);
  const cutoffs=new Map(targets.map(a=>[a,Math.min(...starts.filter(p=>p.account===a).map(p=>p.start))]));
  assert(targets.length===3 && [...cutoffs.values()].every(Number.isSafeInteger));
  const maps=[...priors].filter(([,rows])=>rows.some(p=>p.end_time<cutoffs.get(p.account_id)));
  const participants=new Set(maps.flatMap(([,rows])=>rows.map(r=>r.account_id)));
  const accounts=gaps.filter(g=>g.target||participants.has(g.account)).map(g=>g.account).sort();
  return {accounts,maps:maps.map(([id])=>id).sort()};
}

export async function plan(db,priors) {
  return db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
    await sql`SET TRANSACTION READ ONLY`.execute(tx);
    const accounts=[...new Set([...priors.values()].flat().map(r=>r.account_id))];
    const evidence=await readAccountEvidence(tx,accounts);
    const verified=new Map();
    for (const account of accounts) {
      const identity=resolveIdentity(evidence,account,null);
      if (identity.status==='verified') verified.set(account,identity.playerId);
    }
    const existing=new Set((await sql`SELECT id::text FROM matches WHERE id=ANY(${[...priors.keys()]}::bigint[])`.execute(tx)).rows.map(r=>r.id));
    const missing=[], unbound=[];
    for (const [id,rows] of priors) {
      if (existing.has(id)) continue;
      if (rows.every(r=>verified.has(r.account_id)) && new Set(rows.map(r=>verified.get(r.account_id))).size===10) missing.push(id);
      else unbound.push(id);
    }
    return {existing:[...existing].sort(), missing:missing.sort(),unbound:unbound.sort(),verifiedAccounts:verified.size,accounts:accounts.length};
  });
}

export async function cached(key) {
  const bytes=await readFile(`${cache}/${key}.json.gz`);
  const obs=JSON.parse(gunzipSync(bytes));
  assert.equal(sha(obs.rawBody),obs.source.payloadSha256);
  const schema=key==='heroes'?HeroesSchema:key==='leagues'?LeaguesSchema:MatchSourceSchema;
  assert.equal(obs.source.endpoint,key==='heroes'||key==='leagues'?'/'+key:'/matches/'+key);
  assert.deepEqual(schema.parse(JSON.parse(obs.rawBody)),obs.data);
  return obs;
}

export function verifyPrior(id, observation, priors) {
  const match=JSON.parse(observation.rawBody), rows=priors.get(id);
  assert(rows && String(match.match_id)===id && String(match.leagueid)===rows[0].leagueid);
  assert.equal(match.start_time,rows[0].start_time);
  assert.equal(match.start_time+match.duration,rows[0].end_time);
  assert.equal(match.players.length,10);
  for (const row of rows) assert(match.players.some(p=>p.player_slot===row.player_slot && String(p.account_id)===row.account_id));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const mode=process.argv[2];
  assert(['plan','capture'].includes(mode));
  const profileMode=process.argv[3]==='profiles';
  const {priors}=await publicInputs(profileMode?'extended':process.argv[3]);
  const db=createDatabase(process.env.DATABASE_URL);
  let selection;
  try {selection=await plan(db,priors);} finally {await db.destroy();}
  if (profileMode) {
    selection.missing=(await profileScope()).maps.filter(id=>!selection.existing.includes(id));
  }
  console.log(JSON.stringify({existing:selection.existing.length,missing:selection.missing.length,
    unresolved:selection.unbound.length,verifiedAccounts:selection.verifiedAccounts,accounts:selection.accounts}));
  if (mode==='capture') {
    await mkdir(cache,{recursive:true});
    const runtime=createProviderRuntime(process.env,200);
    try {
      for (const key of ['leagues','heroes',...selection.missing]) {
        let obs;
        try {obs=await cached(key);}
        catch(error) {
          if(error.code!=='ENOENT') throw error;
          const load=()=>key==='leagues'?runtime.client.getLeagues():key==='heroes'?runtime.client.getHeroes():runtime.client.getMatchSource(key);
          try {obs=await load();}
          catch (reason) {
            if (reason.code!=='source_rate_limited' || !Number.isFinite(reason.retryAfterMs) || reason.retryAfterMs<=0 || reason.retryAfterMs>60000) throw reason;
            await wait(reason.retryAfterMs+100);
            obs=await load();
          }
          assert.equal(sha(obs.rawBody),obs.source.payloadSha256);
          if(priors.has(key)) verifyPrior(key,obs,priors);
          await writeFile(`${cache}/${key}.json.gz`,gzipSync(JSON.stringify(obs)),{flag:'wx'});
        }
        if(priors.has(key)) verifyPrior(key,obs,priors);
      }
    } finally {await runtime.close();}
  }
}
