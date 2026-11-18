#!/usr/bin/env node
/** No remote calls or business writes. Existing verifier takes short SHARE locks. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createDatabase,sql} from '../../packages/db/dist/index.js';
import {SeriesProvisionRepository} from '../../packages/db/dist/series-provision.js';
import {auditSeriesCorpus} from './series-corpus-core.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const [exposurePath,expectedSha,output,...extra]=process.argv.slice(2);
let db;
try{
  assert(exposurePath&&/^[a-f0-9]{64}$/.test(expectedSha)&&output&&!extra.length,'usage');
  const bytes=await readFile(exposurePath);assert.equal(sha(bytes),expectedSha,'exposure_sha');
  const exposure=JSON.parse(bytes).result.ledger;
  db=createDatabase(process.env.DATABASE_URL);
  const result=await db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
    await sql`SET LOCAL lock_timeout='5s'`.execute(tx);
    await sql`SET LOCAL statement_timeout='120s'`.execute(tx);
    const snapshotAt=(await sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`.execute(tx)).rows[0].now;
    const ids=(await sql`SELECT DISTINCT s.provider_series_id AS id FROM series s JOIN matches m ON m.series_id=s.id
      WHERE m.is_pro IS TRUE AND s.provider='opendota' ORDER BY s.provider_series_id`.execute(tx)).rows.map(r=>r.id);
    const ungrouped=(await sql`SELECT count(*)::int AS n FROM matches WHERE is_pro IS TRUE AND series_id IS NULL`.execute(tx)).rows[0].n;
    // preview opens its own read transaction; use a facade so all batches share this snapshot.
    const repo=new SeriesProvisionRepository({transaction:()=>({setIsolationLevel:()=>({execute:fn=>fn(tx)})})});
    const plans=[];for(let offset=0;offset<ids.length;offset+=50)plans.push(await repo.preview({providerSeriesIds:ids.slice(offset,offset+50),snapshotAt}));
    const audit=auditSeriesCorpus(plans,exposure);
    return {format:'series-corpus-export-v1',snapshotAt,exposure:{path:exposurePath,sha256:expectedSha},ungroupedProMaps:ungrouped,
      sourceBasis:'canonical_database_outcome_verifier_and_reviewed_series_preview',providerHttp:0,businessWrites:0,
      plans,audit};
  });
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({snapshotAt:result.snapshotAt,ungroupedProMaps:result.ungroupedProMaps,...result.audit.summary}));
}catch(e){console.error(e?.code==='EEXIST'?'Output exists; choose a new path.':'Series corpus export failed: '+(e?.message??'unknown'));process.exitCode=1;}
finally{await db?.destroy();}
