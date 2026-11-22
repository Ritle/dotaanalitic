import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {id,seriesKey,sha} from './exposure-ledger-core.mjs';
import {parseMetadata} from './series-independent-scope.mjs';
import {exposureSnapshot,fromKeys,sharedExposure} from './shared-exposure.mjs';

const root=new URL('../../',import.meta.url);
const sources={
  reconciliation:['docs/evidence/s3-04-series-projection-reconciliation.json','f0d8704b83f9ef639569fdd553f5bd7d68b4e4508646cf0cfb454833f3b76621'],
  development:['docs/evidence/s3-09-series-development-evaluation.json','59794592350a3ab77d40bbc67e6560ba537d61306226b9ec2df84b0a58816018'],
  providerReview:['docs/evidence/s3-09-series-foundation.json','b9d981ea04f42aff65832c5d8d3446b7349e3ffaa279611dc9e1840bb3b68aaa'],
  candidates:['docs/evidence/s3-09-bo3-scope-metadata.csv','6d8a7e9691e36770fe4f0b137434d3c6d8707ab5243ac82fa3bf18e36ebf8b1f'],
  essenceIII:['docs/evidence/s3-09-essence-iii-first-map-audit.json','eae48c4f34f1d3abc4c16456116c9316b9ffb9e255cde1fd7c8a92f35207128f'],
  previous:['docs/evidence/s3-09-series-exposure-review-r2.json','35e6b362a957485552696b869d49f95f1db114e7aa8df05533b14bf2f7427ef6'],
  leagueDiscovery:['docs/evidence/s3-01-league-discovery.json','ff2fcda0080602e0f0691032083d750c05e52c06386e40fba282acacf544af87']
};
const openDotaKey=value=>JSON.stringify(['opendota',id(value)]);
const pandaKey=value=>JSON.stringify(['pandascore',id(value)]);
const sorted=values=>[...new Set(values)].sort();

async function checkedSource([path,digest],optional=false) {
  let bytes;
  try {bytes=await readFile(new URL(path,root));}
  catch(error) {
    if(optional && error.code==='ENOENT') return null;
    throw error;
  }
  assert.equal(sha(bytes),digest,'evidence digest mismatch: '+path);
  return bytes.toString('utf8');
}

async function databaseIds(connectionString) {
  assert(connectionString,'DATABASE_URL required');
  const db=new pg.Client({connectionString});
  await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL statement_timeout='30s'");
    const maps=(await db.query(`SELECT id::text AS id FROM matches UNION
      SELECT provider_match_id FROM provider_ingest_receipts WHERE provider='opendota' ORDER BY id`)).rows.map(row=>id(row.id));
    const openDota=(await db.query(`SELECT provider_series_id AS id FROM series WHERE provider='opendota' UNION
      SELECT source_payload->>'series_id' FROM provider_ingest_receipts WHERE provider='opendota'
        AND source_payload->>'series_id' ~ '^[1-9][0-9]*$' ORDER BY id`)).rows.map(row=>openDotaKey(row.id));
    const panda=(await db.query(`SELECT DISTINCT provider_match_id::text AS id FROM journal_provider_result_receipts
      WHERE observation_text::jsonb #>> '{source,provider}'='pandascore'
        AND observation_text::jsonb #>> '{source,adapterVersion}'='pandascore-result-probe-v1' ORDER BY id`))
      .rows.map(row=>pandaKey(row.id));
    await db.query('COMMIT');
    return {maps,openDota,panda};
  } finally {await db.end();}
}

export function screenPriorSeries(groups,known) {
  const maps=new Set(known.mapIds),series=new Set(known.seriesKeys);
  const editions=new Map();
  for(const group of groups) {
    if(group.type!=='1') continue;
    const edition=editions.get(group.league)??{editionId:group.league,excluded:[],unresolved:0};
    const key=openDotaKey(group.id);
    const matchedMaps=group.maps.filter(map=>maps.has(id(map)));
    const matchedSeries=series.has(key);
    if(matchedSeries || matchedMaps.length>0) edition.excluded.push({seriesKey:key,matchedSeries,matchedMaps});
    else edition.unresolved++;
    editions.set(group.league,edition);
  }
  return [...editions.values()];
}

export function reviewedEssenceIIIKeys(review) {
  assert.equal(review.format,'s3-09-essence-iii-first-map-audit-v1');
  assert.equal(review.registrationAllowed,false);
  const {evaluationScope,rows}=review;
  assert.equal(evaluationScope.leagueId,'20486');
  assert.equal(evaluationScope.treatment,'development_only');
  const openDota=evaluationScope.removedFromFrozenAuditShortlist.map(openDotaKey);
  const reviewedOpenDota=rows.map(row=>openDotaKey(row.openDotaSeriesId));
  const pandaScore=rows.map(row=>pandaKey(row.pandaScoreMatchId));
  const excluded=new Set(openDota);
  assert(openDota.length>0 && excluded.size===openDota.length,'invalid historical exclusions');
  assert(reviewedOpenDota.length>0 && reviewedOpenDota.every(key=>excluded.has(key)),'reviewed series outside excluded selection');
  assert(new Set(reviewedOpenDota).size===rows.length && new Set(pandaScore).size===rows.length,'duplicate reviewed series');
  return {openDota,pandaScore};
}

export function reviewedLeagueDiscovery(report) {
  assert.equal(report.schema_version,1,'unsupported discovery report version');
  assert.equal(report.mode,'live_opendota','live OpenDota discovery required');
  assert(report.syntheticOnly!==true,'synthetic league discovery');
  const reportedAt=Date.parse(report.generated_at);
  assert(Number.isFinite(reportedAt),'invalid discovery report clock');
  assert(Array.isArray(report.cohorts)&&report.cohorts.length>0,'missing discovery cohorts');
  const maps=new Set(), series=new Set();
  for(const cohort of report.cohorts) {
    const leagueId=id(cohort.league_id);
    const source=cohort.source_evidence;
    assert.equal(source.endpoint,'/leagues/'+leagueId+'/matches','discovery league endpoint mismatch');
    assert.equal(source.adapter_version,'opendota-provider-v2','unexpected discovery adapter');
    assert.match(source.payload_sha256,/^[a-f0-9]{64}$/u,'invalid discovery payload digest');
    assert(Date.parse(source.fetched_at)<=reportedAt,'discovery receipt is later than its report');
    for(const map of cohort.matches) {
      assert.equal(id(map.leagueid),leagueId,'discovery map outside league');
      const matchId=id(map.match_id);
      if(typeof map.radiant_win!=='boolean') continue;
      assert(!maps.has(matchId),'duplicate discovery match');
      maps.add(matchId);
      if(map.series_id!==null && map.series_id!=='0') series.add(openDotaKey(map.series_id));
    }
  }
  return {mapIds:[...maps].sort(),seriesKeys:[...series].sort()};
}

export async function combineSeriesExposure(local,inputDigests,connectionString) {
  if (!connectionString) return {known:local};
  const snapshot=await exposureSnapshot('series-review',inputDigests,fromKeys(local.mapIds,local.seriesKeys));
  const {inventory,revisions}=await sharedExposure(connectionString,snapshot);
  return {known:{mapIds:inventory.mapIds,seriesKeys:sorted([
    ...inventory.openDotaSeriesIds.map(openDotaKey),...inventory.pandaScoreMeetingIds.map(pandaKey)])},revisions};
}

async function main(output) {
  const [reconciliation,development,providerReview,candidates,essenceReview,previousText,discoveryText]=await Promise.all(
    Object.values(sources).map(ref=>checkedSource(ref)));
  const archived=JSON.parse(reconciliation);
  assert.equal(archived.completeGlobalInventory,false);
  const archiveRef=[archived.artifact.path,archived.artifact.sha256];
  const archiveText=await checkedSource(archiveRef,true);
  const archiveLedger=archiveText===null ? null : JSON.parse(archiveText).result.ledger;
  const reconciledKeys=archived.expectedSeriesIds.map(openDotaKey);
  assert.equal(new Set(reconciledKeys).size,archived.newSeries,'reconciliation summary mismatch');
  const developmentKeys=JSON.parse(development).result.excluded.map(({seriesKey:key})=>{
    assert(key.startsWith('opendota:'),'unexpected development namespace');
    return openDotaKey(key.slice('opendota:'.length));
  });
  const providerKeys=JSON.parse(providerReview).outcomes.outcomes.map(row=>pandaKey(row.providerMatchId));
  const essence=reviewedEssenceIIIKeys(JSON.parse(essenceReview));
  const previous=JSON.parse(previousText);
  assert.equal(previous.format,'series-exposure-review-v1');
  assert.equal(previous.completeGlobalInventory,false);
  const discovery=reviewedLeagueDiscovery(JSON.parse(discoveryText));
  const db=await databaseIds(process.env.DATABASE_URL);
  const archivedKeys=(archiveLedger?.canonicalSeriesKeys??[]).map(seriesKey);
  const reportOpenDota=[...reconciledKeys,...developmentKeys,...essence.openDota];
  const reportPanda=[...providerKeys,...essence.pandaScore];
  const priorMaps=sorted([...previous.mapIds,...db.maps,...(archiveLedger?.maps??[]).map(row=>id(row.matchId))]);
  const priorSeries=sorted([...previous.seriesKeys,...db.openDota,...db.panda,...reportOpenDota,...reportPanda,...archivedKeys]);
  const priorMapSet=new Set(priorMaps), priorSeriesSet=new Set(priorSeries);
  const local={
    mapIds:sorted([...priorMaps,...discovery.mapIds]),
    seriesKeys:sorted([...priorSeries,...discovery.seriesKeys])
  };
  const databaseSeries=new Set(db.openDota);
  const inputDigests=Object.fromEntries(Object.entries(sources).map(([key,ref])=>[key,ref[1]]));
  inputDigests.database=sha(JSON.stringify(db));
  if(archiveText!==null) inputDigests.archive=archiveRef[1];
  const {known,revisions}=await combineSeriesExposure(local,inputDigests,process.env.RESEARCH_DATABASE_URL);
  const report={
    format:'series-exposure-review-v1',capturedAt:new Date().toISOString(),
    ...(revisions ? {sharedRegistry:{revisions}} : {}),
    completeGlobalInventory:false,registrationAllowed:false,
    sources:Object.values(sources).map(([path,sha256])=>({path,sha256})),
    archive:{path:archiveRef[0],sha256:archiveRef[1],available:archiveText!==null},
    database:{maps:db.maps.length,openDotaSeries:db.openDota.length,pandaScoreSeries:db.panda.length,
      projectionSha256:sha(JSON.stringify(db))},
    fromReports:{reconciledOpenDotaSeries:reconciledKeys.length,developmentOpenDotaSeries:developmentKeys.length,
      essenceIIIExcludedOpenDotaSeries:essence.openDota.length,essenceIIIReviewedPandaScoreSeries:essence.pandaScore.length,
      additionalOpenDotaSeries:sorted(reportOpenDota).filter(key=>!databaseSeries.has(key)).length,
      pandaScoreSeries:sorted(reportPanda).length},
    leagueDiscovery:{mapIds:discovery.mapIds.length,openDotaSeries:discovery.seriesKeys.length,
      additionalMapIds:discovery.mapIds.filter(matchId=>!priorMapSet.has(matchId)).length,
      additionalOpenDotaSeries:discovery.seriesKeys.filter(key=>!priorSeriesSet.has(key)).length},
    summary:{maps:known.mapIds.length,openDotaSeries:known.seriesKeys.filter(key=>key.startsWith('["opendota",')).length,
      pandaScoreSeries:known.seriesKeys.filter(key=>key.startsWith('["pandascore",')).length},
    historicalWallachia:screenPriorSeries(parseMetadata(candidates),known),
    ...known
  };
  const bytes=JSON.stringify(report,null,2)+'\n';
  await writeFile(output,bytes,{flag:'wx'});
  console.log(JSON.stringify({sha256:sha(bytes),...report.summary,archiveAvailable:report.archive.available,
    database:report.database,fromReports:report.fromReports,leagueDiscovery:report.leagueDiscovery,
    historicalWallachia:report.historicalWallachia,...(revisions ? {sharedRevisions:revisions.length} : {})}));
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [output,...extra]=process.argv.slice(2);
  assert(output && (!extra.length || (extra.length===1 && extra[0]==='--shared')),
    'usage: review-series-exposure.mjs NEW_REPORT.json [--shared]');
  if (extra.length) assert(process.env.RESEARCH_DATABASE_URL,'RESEARCH_DATABASE_URL required');
  await main(output);
}
