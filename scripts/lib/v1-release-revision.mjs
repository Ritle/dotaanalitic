import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {V1ReleaseRevisionIntentSchema,V1ReleaseRevisionFilesSchema,V1ReleaseRevisionCatalogueSchema} from '../../packages/contracts/dist/v1-release-revision.js';
import {V1ReleasePlanRequestSchema,V1ReleaseCatalogueRowsSchema,V1ReleaseCatalogueCaptureSchema} from '../../packages/contracts/dist/v1-release-plan.js';
import {V1_RELEASE_QUALITY_POLICY} from '../../packages/prediction/dist/v1-quality-policy.js';
import {canonicalContextJson} from '../../packages/db/dist/temporal.js';
import {bounded,save,sha} from './evaluation-discovery-files.mjs';
import {readV1RegistryBundle} from './v1-registry-bundle.mjs';

const text=value=>JSON.stringify(value,null,2)+'\n';
const fail=code=>{throw Error('revision_'+code);};
function parse(schema,input,code){const p=schema.safeParse(input);if(!p.success)fail(code);return p.data;}

/** Metadata-only preparation. The caller first verifies the old executable bundle. */
export function prepareReleaseRevision(intentInput,previous,catalogueInput,at){
  const intent=parse(V1ReleaseRevisionIntentSchema,intentInput,'intent_invalid');
  if(!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at)fail('clock_invalid');
  if(sha(previous.planText)!==previous.planSha256||intent.supersedesPlanSha256!==previous.planSha256)fail('previous_plan');
  const old=JSON.parse(previous.planText),policySha=sha(canonicalContextJson(old.qualityPolicy));
  if(intent.qualityPolicySha256!==policySha||sha(canonicalContextJson(V1_RELEASE_QUALITY_POLICY))!==policySha)fail('policy_changed');
  if(intent.request.warmupFromAt!==old.request.warmupFromAt||intent.request.developmentDatasetSha256!==old.request.developmentDatasetSha256)fail('history_changed');
  const deadline=intent.request.events.map(e=>e.fromAt).sort()[0];
  if(at>=deadline)fail('registration_deadline');
  const catalogue=parse(V1ReleaseRevisionCatalogueSchema,catalogueInput,'catalogue_invalid');
  if(intent.recordedAt>at||catalogue.source.fetchedAt>at||intent.request.events.some(e=>e.tierDecision.reviewedAt>intent.recordedAt))fail('future_evidence');
  if(Date.parse(at)-Date.parse(catalogue.source.fetchedAt)>86400000)fail('catalogue_stale');
  if(sha(catalogue.rawBody)!==catalogue.source.payloadSha256)fail('catalogue_hash');
  let rows;try{rows=V1ReleaseCatalogueRowsSchema.parse(JSON.parse(catalogue.rawBody));}catch{fail('catalogue_invalid');}
  const events=intent.request.events.map(event=>{
    const matches=rows.filter(r=>event.leagueId===null?r.name===event.catalogueName:r.leagueid===event.leagueId);
    const reason=matches.length===0?'MAIN_EVENT_NOT_FOUND':matches.length>1?'AMBIGUOUS_MAIN_EVENT':
      matches[0].name!==event.catalogueName?'PINNED_EVENT_MISMATCH':
        !['professional','premium'].includes(matches[0].tier)?'PRO_CLASSIFICATION_MISSING':null;
    return {eventKey:event.eventKey,name:event.name,catalogueName:event.catalogueName,
      leagueId:reason===null?matches[0].leagueid:null,reason};
  });
  const ready=events.every(e=>e.reason===null);
  const request=ready?V1ReleasePlanRequestSchema.parse({...intent.request,catalogueSha256:sha(text(catalogue)),
    events:intent.request.events.map((event,i)=>({...event,leagueId:events[i].leagueId}))}):null;
  return {schemaVersion:1,format:'v1-release-revision-preparation-v1',revisionKey:intent.revisionKey,checkedAt:at,
    intentSha256:sha(text(intent)),supersedesPlanSha256:previous.planSha256,oldPlanUse:intent.oldPlanUse,qualityPolicySha256:policySha,
    registrationDeadline:deadline,status:ready?'ready_to_register':'awaiting_event_binding',events,request,catalogue,
    registrationPerformed:false,evaluationPerformed:false,metrics:null,teamAWinProbability:null,deployable:false};
}

export async function readReleaseRevision(configPath,configSha256,{verifyBundle=readV1RegistryBundle,clock=()=>new Date().toISOString()}={}){
  const config=parse(V1ReleaseRevisionFilesSchema,(await bounded(configPath,65536,configSha256)).data,'files_invalid');
  const intent=await bounded(config.intent.path,65536,config.intent.sha256);
  const catalogue=await bounded(config.catalogue.path,16777216,config.catalogue.sha256);
  const previous=await verifyBundle(config.previousBundle.path,config.previousBundle.configSha256,config.previousBundle.freezeSha256);
  return {...prepareReleaseRevision(intent.data,previous,catalogue.data,clock()),intentSha256:config.intent.sha256,
    inputConfigSha256:configSha256,catalogueCaptureSha256:config.catalogue.sha256};
}

export async function writeReleaseRevision(result,directory){
  if(result.status!=='ready_to_register'||result.registrationPerformed!==false||result.deployable!==false)fail('not_ready');
  const request=V1ReleasePlanRequestSchema.parse(result.request),catalogue=V1ReleaseCatalogueCaptureSchema.parse(result.catalogue);
  if(request.catalogueSha256!==sha(text(catalogue))||sha(catalogue.rawBody)!==catalogue.source.payloadSha256)fail('catalogue_hash');
  const root=resolve(directory);await mkdir(root); // Exclusive; partial outputs are retained, never overwritten.
  const catalogueRef=await save(join(root,'catalogue.json'),catalogue),requestRef=await save(join(root,'request.json'),request);
  const {catalogue:_raw,request:_request,...summary}=result;
  const preparation=await save(join(root,'preparation.json'),{...summary,files:{catalogue:catalogueRef,request:requestRef}});
  return {directory:root,requestSha256:requestRef.sha256,catalogueSha256:catalogueRef.sha256,preparationSha256:preparation.sha256};
}
