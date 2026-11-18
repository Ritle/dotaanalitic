import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalId,inspectMatch} from '../../scripts/lib/match-quality.mjs';

/** Diagnostic inventory only: never makes a training or deployment eligibility decision. */
export function summarizePostDraftRows(rows){
 const seen=new Set();
 const maps=rows.map(row=>{
  const id=canonicalId(row.matchId);if(!id||seen.has(id))throw new Error('invalid_or_duplicate_map');seen.add(id);
  const canonical=inspectMatch({match_id:id,players:row.players},id);
  const source=row.source===null?null:inspectMatch(row.source,id);
  const sameHeroes=source===null?null:source.flags.match_id_consistent&&source.flags.final_heroes_valid&&canonical.flags.final_heroes_valid&&
   row.players.every(p=>row.source.players.some(s=>s.player_slot===p.player_slot&&s.hero_id===p.hero_id));
  const identities=canonical.flags.players_10&&row.players.every(p=>canonicalId(p.player_id)!==null)&&new Set(row.players.map(p=>p.player_id)).size===10;
  return {matchId:id,startedAt:row.startedAt,dataRevision:row.dataRevision??null,sourceFetchedAt:row.sourceFetchedAt??null,qualityAssessmentId:row.qualityAssessmentId??null,
   lineupSha256:createHash('sha256').update(JSON.stringify([...row.players].sort((a,b)=>a.player_slot-b.player_slot))).digest('hex'),
   sourceSnapshotId:row.sourceSnapshotId,sourceSha256:row.sourceSha256,
   canonicalPatchId:row.canonicalPatchId,providerPatchId:row.source?.patch??null,leagueId:row.leagueId,
   finalHeroes:canonical.flags.final_heroes_valid,canonicalIdentities:identities,sourceHeroesAgree:sameHeroes,
   rawPicksExact:source?.flags.draft_picks_exact??null,rawHeroesMatch:source?.flags.draft_heroes_match??null,
   rawSidesMatch:source?.flags.draft_teams_match??null,rawStructureConsistent:source?.flags.draft_structurally_consistent??null,
   canonicalTeams:row.teamAId!==null&&row.teamBId!==null&&row.teamAId!==row.teamBId,
   canonicalSeries:row.seriesId!==null,sourceOutcomeEligible:row.outcomeStatus==='eligible',
   ingestConflict:row.ingestState==='conflict',draftDiagnostics:source?.diagnostics??null,
   draftAnomalies:source?.anomalies.filter(x=>x.startsWith('DRAFT_')||x.startsWith('PICK_'))??[],
   // Upper-bound inventory before time/patch/role/history/split evaluation, not an eligible dataset.
   researchInventoryCandidate:canonical.flags.final_heroes_valid&&identities&&sameHeroes===true&&row.outcomeStatus==='eligible'&&
    row.ingestState!=='conflict'&&row.teamAId!==null&&row.teamBId!==null&&row.teamAId!==row.teamBId&&row.seriesId!==null};
 }).sort((a,b)=>BigInt(a.matchId)<BigInt(b.matchId)?-1:1);
 const fields=['finalHeroes','canonicalIdentities','sourceHeroesAgree','rawPicksExact','rawHeroesMatch','rawSidesMatch','rawStructureConsistent','canonicalTeams','canonicalSeries','sourceOutcomeEligible','ingestConflict','researchInventoryCandidate'];
 const coverage=Object.fromEntries(fields.map(k=>{const yes=maps.filter(m=>m[k]===true),unknown=maps.filter(m=>m[k]===null),no=maps.filter(m=>m[k]===false);return [k,{count:yes.length,of:yes.length+no.length,ratio:yes.length+no.length?yes.length/(yes.length+no.length):null,unknown:unknown.length,missingMatchIds:no.map(m=>m.matchId)}];}));
 return {maps,coverage,trainingReady:false,deployable:false};
}

export async function auditPostDraft(db){
 const {sql}=await import('../../packages/db/dist/index.js');
 return db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
  await sql`SET TRANSACTION READ ONLY`.execute(tx);
  const rows=(await sql`SELECT m.id::text AS "matchId",m.started_at AS "startedAt",m.patch_id::text AS "canonicalPatchId",
   m.league_id::text AS "leagueId",m.series_id::text AS "seriesId",m.radiant_team_id::text AS "teamAId",m.dire_team_id::text AS "teamBId",
   m.ingest_state AS "ingestState",m.data_revision::text AS "dataRevision",q.id::text AS "qualityAssessmentId",s.fetched_at AS "sourceFetchedAt",
   q.outcome_status AS "outcomeStatus",s.id::text AS "sourceSnapshotId",s.payload_sha256 AS "sourceSha256",
   coalesce((SELECT jsonb_agg(jsonb_build_object('player_slot',p.player_slot,'hero_id',p.hero_id,'player_id',p.player_id::text) ORDER BY p.player_slot)
     FROM match_players p WHERE p.match_id=m.id),'[]'::jsonb) AS players,
   CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('match_id',r.source_payload->'match_id','patch',r.source_payload->'patch',
    'players',(SELECT jsonb_agg(jsonb_build_object('player_slot',p->'player_slot','hero_id',p->'hero_id'))
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.source_payload->'players')='array' THEN r.source_payload->'players' ELSE '[]'::jsonb END) p),
    'picks_bans',r.source_payload->'picks_bans') END AS source
   FROM matches m
   LEFT JOIN LATERAL (SELECT * FROM match_quality_assessments WHERE match_id=m.id ORDER BY assessed_at DESC,id DESC LIMIT 1) q ON true
   LEFT JOIN match_source_snapshots s ON s.id=q.source_snapshot_id AND s.match_id=m.id
   LEFT JOIN provider_ingest_receipts r ON r.id::text=q.metrics->>'receipt_id' AND r.canonical_match_id=m.id
    AND r.provider_match_id=m.id::text AND r.provider=s.provider AND r.payload_sha256=s.payload_sha256 AND s.provider_match_id=r.provider_match_id
   WHERE m.is_pro IS TRUE ORDER BY m.started_at,m.id LIMIT 5001`.execute(tx)).rows;
  if(rows.length>5000)throw new Error('inventory_limit_5000');
  const context=(await sql`SELECT field_name AS field,availability_class AS availability,earliest_stage AS stage,review_state AS review,
   count(*)::int observations,count(DISTINCT o.match_id)::int maps,
   count(*) FILTER(WHERE o.known_at IS NOT NULL AND o.known_at<=m.started_at)::int AS "knownByStart"
   FROM match_field_observations o JOIN matches m ON m.id=o.match_id WHERE m.is_pro IS TRUE AND o.context_sha256 IS NOT NULL
   GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`.execute(tx)).rows;
  const inventory=summarizePostDraftRows(rows);
  const body={policyVersion:'post-draft-readiness-inventory-v1',scope:'current_pro_corpus_inventory',...inventory,contextEvidence:context,
   caveats:['Source receipt is matched to the current quality assessment; this is not OutcomeVerifier or a frozen dataset.',
    'Raw structural consistency does not prove historical availability or patch-specific draft rules.',
    'Research inventory candidates still require explicit conditional policy, patch/role/history coverage and independent temporal validation.']};
  return {computedAt:new Date().toISOString(),...body,fingerprint:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [path,...extra]=process.argv.slice(2);let db;
 try{
  if(!path||extra.length||!process.env.DATABASE_URL)throw new Error('invalid_arguments');
  const {createDatabase}=await import('../../packages/db/dist/index.js');db=createDatabase(process.env.DATABASE_URL);
  const report=await auditPostDraft(db);await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:'complete',maps:report.maps.length,fingerprint:report.fingerprint,coverage:report.coverage,contextEvidence:report.contextEvidence,trainingReady:false,deployable:false}));
 }catch(error){console.error(error?.code==='EEXIST'?'Файл отчёта уже существует. Укажите новое имя.':'Аудит драфтов не выполнен. Проверьте путь отчёта, БД и миграции.');process.exitCode=1;}
 finally{await db?.destroy();}
}
