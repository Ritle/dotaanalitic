import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CatalogIdSchema} from '../../packages/contracts/dist/catalog.js';
import {parseMetadata} from './series-independent-scope.mjs';
import {screenPriorSeries} from './review-series-exposure.mjs';

const {z}=createRequire(new URL('../../packages/contracts/package.json',import.meta.url))('zod');
const root=new URL('../../',import.meta.url);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const time=z.iso.datetime();
const count=z.number().int().nonnegative().safe();
const id=CatalogIdSchema;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const evidenceRef=z.object({path:z.string().min(1),sha256:digest}).strict();
const planSchema=z.object({
  format:z.literal('bo3-prospective-scope-plan-v1'),
  exposure:z.object({inventory:evidenceRef,historicalWallachia:evidenceRef.optional()}).strict().optional(),
  editions:z.array(z.object({
    name:z.string().min(1),organizerSource:z.url(),windowStart:time,windowEnd:time,plannedBo3:count.nullable(),
    binding:z.object({
      leagueId:id,editionId:id,stageIds:z.array(id).nonempty(),catalogPath:z.string().min(1),catalogSha256:digest
    }).strict().nullable()
  }).strict()).nonempty()
}).strict();
const schedule={from:time.nullable(),until:time.nullable()};
const catalogSchema=z.object({
  format:z.literal('pandascore-edition-metadata-audit-v1'),
  results:z.array(z.object({
    complete:z.boolean(),
    pages:z.array(z.object({fetchedAt:time})).nonempty(),
    rows:z.array(z.object({
      id,leagueId:id.nullable(),...schedule,
      stages:z.array(z.object({id,name:z.string().nullable(),...schedule})).nullable()
    }))
  }))
});
const exposureSchema=z.object({
  format:z.literal('series-exposure-review-v1'),
  capturedAt:time,
  completeGlobalInventory:z.literal(false),
  registrationAllowed:z.literal(false),
  mapIds:z.array(id),
  seriesKeys:z.array(z.string().refine(key=>{
    const match=/^\["(?:opendota|pandascore)","([1-9]\d{0,18})"\]$/.exec(key);
    return match!==null && id.safeParse(match[1]).success;
  },'invalid exposure series key'))
});
const readEvidence=path=>readFile(resolve(fileURLToPath(root),path));
const millis=Date.parse;
const mustBeUnique=(values,message)=>assert.equal(new Set(values).size,values.length,message);

async function checkedEvidence(ref,loadEvidence) {
  const bytes=await loadEvidence(ref.path);
  assert(sha256(bytes)===ref.sha256,'evidence digest mismatch: '+ref.path);
  return bytes.toString('utf8');
}

async function reviewExposure(refs,asOf,loadEvidence) {
  if(!refs) return {status:'missing',issues:['EXPOSURE_INVENTORY_MISSING']};
  const inventory=exposureSchema.parse(JSON.parse(await checkedEvidence(refs.inventory,loadEvidence)));
  const {capturedAt,mapIds,seriesKeys}=inventory;
  if(millis(capturedAt)>asOf) {
    return {status:'unavailable_as_of',capturedAt,issues:['EXPOSURE_INVENTORY_FROM_FUTURE']};
  }
  mustBeUnique(mapIds,'duplicate exposure map ID');
  mustBeUnique(seriesKeys,'duplicate exposure series key');
  const historicalWallachia=refs.historicalWallachia
    ? screenPriorSeries(parseMetadata(await checkedEvidence(refs.historicalWallachia,loadEvidence)),inventory)
    : null;
  return {
    status:'partial',capturedAt,inventorySha256:refs.inventory.sha256,
    completeGlobalInventory:inventory.completeGlobalInventory,
    knownMapCount:mapIds.length,knownSeriesCount:seriesKeys.length,
    prospectiveStatus:'not_screened',
    historicalWallachiaSha256:refs.historicalWallachia?.sha256??null,
    historicalWallachia,
    issues:['EXPOSURE_INVENTORY_INCOMPLETE']
  };
}

async function reviewEdition(edition,asOf,loadCatalog) {
  const {binding,...plan}=edition;
  const base={...plan,leagueId:binding?.leagueId??null,editionId:binding?.editionId??null,stages:[]};
  if(!binding) return {...base,issues:['MAIN_EDITION_ID_UNCONFIRMED']};
  mustBeUnique(binding.stageIds,'duplicate reviewed stage ID');
  const bytes=await loadCatalog(binding.catalogPath);
  assert.equal(sha256(bytes),binding.catalogSha256,'catalog digest mismatch: '+edition.name);
  const {results}=catalogSchema.parse(JSON.parse(bytes.toString('utf8')));
  const observations=results.filter(result=>result.complete && result.pages.every(page=>millis(page.fetchedAt)<=asOf))
    .flatMap(result=>result.rows.filter(row=>row.id===binding.editionId));
  if(observations.length===0) return {...base,issues:['EDITION_NOT_IN_CATALOG_AS_OF']};
  const issues=[];
  if(observations.some(row=>row.leagueId!==binding.leagueId)) issues.push('LEAGUE_ID_MISMATCH');
  const sameStages=row=>row.stages?.length===binding.stageIds.length &&
    binding.stageIds.every(stageId=>row.stages.some(stage=>stage.id===stageId));
  if(!observations.every(sameStages)) issues.push('STAGE_IDS_MISMATCH');
  const withinWindow=row=>row.from!==null && row.until!==null && millis(row.from)>=millis(edition.windowStart) &&
    millis(row.from)<millis(row.until) && millis(row.until)<millis(edition.windowEnd);
  if(observations.some(row=>!withinWindow(row) || row.stages?.some(stage=>!withinWindow(stage)))) {
    issues.push('SCHEDULE_OUTSIDE_REVIEWED_WINDOW');
  }
  return {...base,stages:observations[0].stages??[],issues};
}

export async function reviewSeriesRegistration(rawPlan,policy,asOf,loadEvidence=readEvidence) {
  const plan=planSchema.parse(rawPlan);
  const checkedAt=millis(time.parse(asOf));
  const {registration,evaluation}=policy;
  assert.equal(policy.format,'series-validation-policy-v1');
  mustBeUnique(plan.editions.map(edition=>edition.name),'duplicate planned edition name');
  mustBeUnique(plan.editions.flatMap(({binding})=>binding ? [binding.editionId] : []),'duplicate provider edition ID');
  for(const edition of plan.editions) {
    assert(millis(edition.windowStart)<millis(edition.windowEnd),'invalid reviewed window: '+edition.name);
  }
  const [editions,exposure]=await Promise.all([
    Promise.all(plan.editions.map(edition=>reviewEdition(edition,checkedAt,loadEvidence))),
    reviewExposure(plan.exposure,checkedAt,loadEvidence)
  ]);
  const deadline=Math.min(...editions.map(edition=>millis(edition.windowStart)));
  const issues=[];
  if(checkedAt>=deadline) issues.push('SCOPE_WINDOW_STARTED');
  if(editions.length<evaluation.minimumEventsPerFormat) issues.push('TOO_FEW_EDITIONS');
  if(editions.some(edition=>edition.issues.length>0)) issues.push('EDITION_SCOPE_UNCONFIRMED');
  const total=editions.reduce((sum,edition)=>sum+(edition.plannedBo3??0),0);
  if(editions.some(edition=>edition.plannedBo3===null)) issues.push('PLANNED_BO3_UNKNOWN');
  if(total<evaluation.minimumSeriesPerFormat) issues.push('PLANNED_BO3_BELOW_MINIMUM');
  const verified=editions.filter(edition=>edition.issues.length===0)
    .reduce((sum,edition)=>sum+(edition.plannedBo3??0),0);
  const minimumEligibleAtPlannedVolume=Math.max(evaluation.minimumSeriesPerFormat,Math.ceil(total*evaluation.minimumCoverage));
  const planningTarget=Math.ceil(evaluation.minimumSeriesPerFormat/evaluation.minimumCoverage);
  const enoughPlanned=total>=minimumEligibleAtPlannedVolume;
  const pendingRegistration=['registeredAt','eventEditionIds','from','until','assessmentAt',
    'candidateManifestSha256','exposureInventorySha256'].filter(field=>registration[field]==null);
  return {
    asOf:new Date(checkedAt).toISOString(),
    reviewBefore:new Date(deadline).toISOString(),
    remainingMs:Math.max(0,deadline-checkedAt),
    scopeReady:issues.length===0,
    issues,
    registrationIssues:[...issues,...exposure.issues],
    exposure,
    editions,
    plannedBo3:{total,fromVerifiedEditions:verified,minimumEligible:evaluation.minimumSeriesPerFormat,
      minimumCoverage:evaluation.minimumCoverage,minimumEditions:evaluation.minimumEventsPerFormat},
    capacity:{minimumEligibleAtPlannedVolume,
      minimumCoverageAtPlannedVolume:enoughPlanned?minimumEligibleAtPlannedVolume/total:null,
      maximumUnavailableAtPlannedVolume:enoughPlanned?total-minimumEligibleAtPlannedVolume:null,
      planningTargetAtMinimumCoverage:planningTarget,
      extraPlannedToTarget:Math.max(0,planningTarget-total)},
    policyStatus:policy.status,
    collectionAllowed:policy.collectionAllowed,
    pendingRegistration
  };
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [planPath,asOf=new Date().toISOString(),...extra]=process.argv.slice(2);
  assert(!extra.length,'usage: review-series-registration.mjs [PLAN.json [AS_OF_UTC]]');
  const [planText,policyText]=await Promise.all([
    readFile(planPath??new URL('./series-bo3-registration-plan.json',import.meta.url),'utf8'),
    readFile(new URL('./series-validation-policy.json',import.meta.url),'utf8')
  ]);
  const report=await reviewSeriesRegistration(JSON.parse(planText),JSON.parse(policyText),asOf);
  console.log(JSON.stringify(report,null,2));
}
