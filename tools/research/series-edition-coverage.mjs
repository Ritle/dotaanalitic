import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CatalogIdSchema} from '../../packages/contracts/dist/catalog.js';
import {createDatabase,sql} from '../../packages/db/dist/index.js';
import {registrySha} from '../../packages/db/dist/v1-registry.js';
import {reviewRehearsalTiming} from './series-forecast-postgres.mjs';
import {assembleEditionPages,compareEditionHttpPasses,comparisonFormat,pageFormat} from './series-edition-pages.mjs';

const {z}=createRequire(new URL('../../packages/contracts/package.json',import.meta.url))('zod');
const Inventory=z.object({
  format:z.literal('synthetic-edition-inventory-v1'),
  leagueId:CatalogIdSchema,editionId:CatalogIdSchema,complete:z.boolean(),
  matches:z.array(z.object({
    matchId:CatalogIdSchema,stageId:CatalogIdSchema,bestOf:z.number().int().positive().nullable(),
    status:z.enum(['played','cancelled','unknown'])
  }).strict())
}).strict();

// The inventory is a separate, outcome-free fixture. A digest binds the chosen bytes,
// while completeness is an explicit property of the source, never inferred from forecast rows.
export async function reviewEditionCoverage(db,inventoryText,expectedSha) {
  assert.equal(registrySha(inventoryText),expectedSha,'inventory digest mismatch');
  const source=JSON.parse(inventoryText);
  const assembled=source?.format===pageFormat ? assembleEditionPages(source) : null;
  const compared=source?.format===comparisonFormat ? compareEditionHttpPasses(source) : null;
  const inventory=Inventory.parse(assembled?.inventory ?? compared?.inventory ?? source);
  const inventorySha256=assembled || compared ? registrySha(JSON.stringify(inventory)) : expectedSha;
  const ids=inventory.matches.map(m=>m.matchId);
  const members=new Set(ids);
  assert.equal(members.size,ids.length,'duplicate inventory match');
  return db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
    const {rows}=await sql`WITH forecasts AS (
      SELECT match_id, receipt_text::jsonb #> '{observation,match}' AS match FROM bo3_rehearsal.forecasts
    ) SELECT match_id::text AS id, match #>> '{league,providerLeagueId}' AS league,
      match #>> '{eventSeries,providerEventSeriesId}' AS edition,
      match #>> '{tournament,providerTournamentId}' AS stage FROM forecasts
      WHERE match_id=ANY(${ids}::bigint[]) OR (match #>> '{league,providerLeagueId}'=${inventory.leagueId}
        AND match #>> '{eventSeries,providerEventSeriesId}'=${inventory.editionId})
      ORDER BY match_id`.execute(tx);
    const forecasts=new Map(rows.map(row=>[row.id,row]));
    const journalOnly=rows.map(row=>row.id).filter(id=>!members.has(id));
    const played=[], outside=[], unresolved=[];
    for(const match of inventory.matches) {
      const {matchId,stageId,bestOf,status}=match;
      if(status==='cancelled' || (bestOf!==null && bestOf!==3)) {
        outside.push({matchId,reason:status==='cancelled'?'CANCELLED':'OTHER_FORMAT'});
        continue;
      }
      if(status==='unknown' || bestOf===null) {
        unresolved.push(matchId);
        continue;
      }
      const forecast=forecasts.get(matchId);
      let timing='NO_FORECAST_ATTEMPT';
      if(forecast) {
        const sameScope=forecast.league===inventory.leagueId && forecast.edition===inventory.editionId &&
          forecast.stage===stageId;
        timing=sameScope ? await reviewRehearsalTiming(tx,matchId) : 'FORECAST_SCOPE_MISMATCH';
      }
      played.push({matchId,timing});
    }
    const complete=inventory.complete && unresolved.length===0 && journalOnly.length===0;
    const timely=played.filter(row=>row.timing==='BEFORE_FIRST_MAP').length;
    const denominator=complete ? played.length : null;
    return {syntheticOnly:true,leagueId:inventory.leagueId,editionId:inventory.editionId,inventorySha256,
      ...(assembled ? {pagesSha256:expectedSha,pageIssues:assembled.issues} : {}),
      ...(compared ? {comparisonSha256:expectedSha,comparison:compared.comparison} : {}),
      sourceComplete:inventory.complete,denominatorComplete:complete,denominator,timely,
      coverage:denominator===null || denominator===0 ? null : timely/denominator,
      played,outside,unresolved,journalOnly};
  });
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [path,sha,...extra]=process.argv.slice(2);
  assert(path && /^[a-f0-9]{64}$/.test(sha) && !extra.length,'usage: series-edition-coverage.mjs SYNTHETIC_SOURCE.json SHA256');
  assert(process.env.DATABASE_URL,'DATABASE_URL required for the rehearsal database');
  const inventoryText=await readFile(path,'utf8');
  const db=createDatabase(process.env.DATABASE_URL);
  try { console.log(JSON.stringify(await reviewEditionCoverage(db,inventoryText,sha),null,2)); }
  finally { await db.destroy(); }
}
