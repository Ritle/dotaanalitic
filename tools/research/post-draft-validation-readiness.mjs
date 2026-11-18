/** Read-only preregistration inventory. Never registers a window or evaluates real outcomes. */
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {createDatabase,sql} from '../../packages/db/dist/index.js';
import {prepareIndependentValidationPlan} from './player-hero-independent-plan.mjs';
import {sha} from '../audits/draft-native-export-core.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const Time=z.string().datetime().refine(v=>new Date(v).toISOString()===v);
const Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Series=z.string().refine(v=>{try{const x=JSON.parse(v);return Array.isArray(x)&&x.length===2&&x[0]==='opendota'&&Id.safeParse(x[1]).success&&JSON.stringify(x)===v;}catch{return false;}});
const Input=z.object({preparedAt:Time,readAt:Time,candidateSha256:Hash,
  previousExposure:z.object({mapIds:z.array(Id).max(100000),canonicalSeriesKeys:z.array(Series).max(100000)}).strict(),
  maps:z.array(z.object({matchId:Id,seriesKey:Series.nullable()}).strict()).max(100000),
  observations:z.object({captures:z.number().int().nonnegative(),history:z.number().int().nonnegative(),links:z.number().int().nonnegative(),bindings:z.number().int().nonnegative()}).strict(),
  cachedSchedule:z.array(z.object({page:z.number().int().min(1).max(50),expiresAt:Time.nullable()}).strict()).max(50),
  catalogueScopes:z.array(z.object({leagueId:Id,eventName:z.string().max(512),fromAt:Time,until:Time,recordSha256:Hash}).strict()).max(1000)
}).strict();
const numeric=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const unique=(xs,reason)=>assert.equal(new Set(xs).size,xs.length,reason);
export function buildValidationReadiness(raw){
  const input=Input.parse(raw);assert(input.readAt<=input.preparedAt,'read_after_preparation');
  unique(input.maps.map(m=>m.matchId),'duplicate_map');unique(input.cachedSchedule.map(p=>p.page),'duplicate_page');
  unique(input.previousExposure.mapIds,'duplicate_prior_map');unique(input.previousExposure.canonicalSeriesKeys,'duplicate_prior_series');
  const mapIds=[...new Set([...input.previousExposure.mapIds,...input.maps.map(m=>m.matchId)])].sort(numeric);
  const seriesKeys=[...new Set([...input.previousExposure.canonicalSeriesKeys,...input.maps.flatMap(m=>m.seriesKey?[m.seriesKey]:[])])].sort();
  const reasons=['GLOBAL_EXPOSURE_INVENTORY_NOT_CERTIFIED','VERIFIED_PROSPECTIVE_BUNDLE_ADAPTER_NOT_IMPLEMENTED',
    'DURABLE_PRESTART_SCORE_PERSISTENCE_NOT_IMPLEMENTED','GAMEPLAY_START_EVIDENCE_NOT_ESTABLISHED',
    'FIXED_FUTURE_SCOPE_AND_WINDOW_NOT_REGISTERED','FULL_DENOMINATOR_COLLECTOR_NOT_IMPLEMENTED','BUDGET_AND_FEASIBILITY_NOT_ESTABLISHED'];
  if(!input.observations.captures||!input.observations.history||!input.observations.links)reasons.push('REAL_DRAFT_SNAPSHOT_PATH_NOT_EXERCISED');
  const futureScopes=input.catalogueScopes.filter(s=>s.fromAt>input.preparedAt&&s.until>s.fromAt);
  const ongoingScopes=input.catalogueScopes.filter(s=>s.fromAt<=input.preparedAt&&s.until>input.preparedAt);
  const body={format:'post-draft-validation-readiness-v1',preparedAt:input.preparedAt,candidateSha256:input.candidateSha256,
    status:'not_ready_for_registration',featurePolicy:'selected-ten-and-known-series-exclusion-v1',
    evaluator:{status:'synthetic_numerical_kernel_only',realSourceAdapter:false,allowRealEvaluation:false},
    exposure:{mapIds,canonicalSeriesKeys:seriesKeys,unresolvedLocalMapIds:input.maps.filter(m=>m.seriesKey===null).map(m=>m.matchId).sort(numeric),
      maps:mapIds.length,knownSeries:seriesKeys.length,completeGlobalInventory:false,
      scope:'union_of_current_database_and_frozen_H2_exposure_only;other_artifacts_and_aliases_require_review'},
    observations:input.observations,
    scope:{catalogueEntries:input.catalogueScopes.length,futureCandidates:futureScopes,ongoingCandidates:ongoingScopes,
      registeredEditionIds:[],from:null,until:null,assessmentAt:null,
      catalogueIsNotIndependentRegistration:true,ongoingEditionRequiresFutureSeriesWindowAndExposureReview:true},
    schedule:{cachedPages:input.cachedSchedule.map(p=>({...p,fresh:p.expiresAt!==null&&p.expiresAt>input.preparedAt})),fullPaginationEstablished:false},
    blockers:reasons.sort(),registrationAllowed:false,collectionAllowed:false,trainingPerformed:false,
    scoringPerformed:false,releaseGatePassed:false,deployable:false};
  return {...body,fingerprint:sha(JSON.stringify(body))};
}

export async function readValidationInventory(db){
  return db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
    await sql`SET TRANSACTION READ ONLY`.execute(tx);await sql`SET LOCAL statement_timeout='30s'`.execute(tx);
    const n=(await sql`SELECT count(*)::int AS n FROM matches`.execute(tx)).rows[0].n;assert(n<=100000,'map_limit');
    const maps=(await sql`SELECT m.id::text AS "matchId",CASE WHEN s.provider='opendota' AND s.provider_series_id ~ '^[1-9][0-9]{0,18}$'
      THEN json_build_array('opendota',s.provider_series_id)::text ELSE NULL END AS "seriesKey"
      FROM matches m LEFT JOIN series s ON s.id=m.series_id ORDER BY m.id`.execute(tx)).rows
      .map(m=>({...m,seriesKey:m.seriesKey===null?null:JSON.stringify(JSON.parse(m.seriesKey))}));
    const observations=(await sql`SELECT (SELECT count(*)::int FROM owner_draft_captures) AS captures,
      (SELECT count(*)::int FROM owner_draft_history_observations) AS history,
      (SELECT count(*)::int FROM owner_draft_history_links) AS links,(SELECT count(*)::int FROM owner_draft_native_bindings) AS bindings`.execute(tx)).rows[0];
    const cachedSchedule=(await sql`SELECT 1 AS page,expires_at AS "expiresAt" FROM upcoming_source_cache WHERE cache_key='schedule'
      UNION ALL SELECT page,expires_at AS "expiresAt" FROM upcoming_page_cache ORDER BY page`.execute(tx)).rows
      .map(p=>({...p,expiresAt:p.expiresAt?.toISOString()??null}));
    const catalogueScopes=(await sql`SELECT record_text::jsonb#>>'{request,scope,leagueId}' AS "leagueId",
      record_text::jsonb#>>'{request,scope,eventName}' AS "eventName",record_text::jsonb#>>'{request,scope,fromAt}' AS "fromAt",
      record_text::jsonb#>>'{request,scope,until}' AS until,record_sha256 AS "recordSha256"
      FROM (SELECT DISTINCT ON (owner_user_id,scope_id) enabled,record_text,record_sha256 FROM owner_tier1_scopes
        ORDER BY owner_user_id,scope_id,revision DESC) latest WHERE enabled ORDER BY "leagueId","fromAt"`.execute(tx)).rows;
    const readAt=(await sql`SELECT clock_timestamp() AS at`.execute(tx)).rows[0].at.toISOString();
    return {readAt,maps,observations,cachedSchedule,catalogueScopes};
  });
}
const files=['tools/research/post-draft-validation-readiness.mjs','tools/research/post_draft_independent_evaluate.py',
  'tools/research/player_hero_evaluate.py','tools/research/post_draft_evaluate.py','tools/research/post_draft_fit.py',
  'tools/research/player-hero-independent-policy.json','tools/research/player-hero-experiment-policy.json',
  'tools/audits/draft-shadow-core.mjs','tools/audits/draft-shadow-features-core.mjs','tools/research/player-hero-shadow-feature.mts',
  'tests/research/test_post_draft_independent_evaluate.py','tests/node/post-draft-validation-readiness.test.mjs','pnpm-lock.yaml'];
async function environment(){const code={};for(const file of files)code[file]=sha(await readFile(resolve(root,file)));return {node:process.version,code};}
function local(path){const file=resolve(root,path??''),rel=relative(resolve(root,'.tools'),file);
  assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&rel.endsWith('.json'),'local_output_required');return file;}
export async function writeReadiness(input,path){
  const result=buildValidationReadiness(input),report={format:'post-draft-validation-readiness-file-v1',environment:await environment(),input,result};
  const bytes=JSON.stringify(report,null,2)+'\n';assert(Buffer.byteLength(bytes)<=32*1024*1024,'file_limit');
  await writeFile(local(path),bytes,{flag:'wx'});return {sha256:sha(bytes),result};
}
export async function verifyReadiness(path,expected){
  Hash.parse(expected);const file=local(path);assert((await stat(file)).size<=32*1024*1024,'file_limit');
  const bytes=await readFile(file);assert.equal(sha(bytes),expected,'external_sha_mismatch');const report=JSON.parse(bytes);
  assert.deepEqual(Object.keys(report).sort(),['environment','format','input','result']);assert.equal(report.format,'post-draft-validation-readiness-file-v1');
  assert.deepEqual(report.environment,await environment(),'environment_changed');assert.deepEqual(report.result,buildValidationReadiness(report.input),'replay_mismatch');
  return report.result;
}
async function main(){
  const [mode,path,expected,...extra]=process.argv.slice(2);assert(!extra.length);let result;
  if(mode==='verify')result=await verifyReadiness(path,expected);
  else{
    assert.equal(mode,'prepare');assert.equal(expected,undefined);local(path);
    const preparedAt=new Date().toISOString(),plan=await prepareIndependentValidationPlan(preparedAt),db=createDatabase(process.env.DATABASE_URL);
    let inventory;try{inventory=await readValidationInventory(db);}finally{await db.destroy();}
    const saved=await writeReadiness({...inventory,preparedAt:new Date().toISOString(),candidateSha256:plan.candidate.artifactSha256,
      previousExposure:{mapIds:plan.minimumExposureBlocklist.mapIds,canonicalSeriesKeys:plan.minimumExposureBlocklist.canonicalSeriesKeys}},path);
    console.log(JSON.stringify({sha256:saved.sha256}));result=saved.result;
  }
  console.log(JSON.stringify({status:result.status,maps:result.exposure.maps,series:result.exposure.knownSeries,observations:result.observations,
    futureCatalogueScopes:result.scope.futureCandidates.length,blockers:result.blockers,registrationAllowed:false,collectionAllowed:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
  console.error('Проверка готовности отклонена: проверьте источники, сборку, SHA и новый путь .tools; перезапись запрещена.');process.exitCode=1;
});
