import {z} from 'zod';
import {V1ReleasePlanRequestSchema,V1ReleaseCatalogueCaptureSchema} from './v1-release-plan.js';

const Time=z.iso.datetime({precision:3}),Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Id=V1ReleasePlanRequestSchema.shape.events.element.shape.leagueId;
const Event=V1ReleasePlanRequestSchema.shape.events.element.refine(e=>
  ![e.name,e.catalogueName].some(n=>/qualif|division\s*(?:2|ii)\b|practice/i.test(n)),{message:'main_event_required'});
const unique=(ids:string[])=>new Set(ids).size===ids.length;
export const V1HistoricalRequestSchema=z.object({
  schemaVersion:z.literal(1),protocolKey:z.string().regex(/^[a-z0-9-]{3,100}$/),
  evaluationBasis:z.literal('conditional_retrospective_unexposed_series'),
  warmupFromAt:Time,eventCutoffAt:Time,maxInventoryMaps:z.literal(5000),
  baseQualityPolicySha256:Sha,catalogueSha256:Sha,exposureSha256:Sha,
  exposureAcknowledgement:z.literal('bounded_local_audit_not_global_blindness_proof'),
  events:z.array(Event).min(1).max(5),
  earlierProtocolsUse:z.literal('archive_or_separate_monitoring_no_best_result_selection')
}).strict().refine(r=>unique(r.events.map(e=>e.leagueId))&&unique(r.events.map(e=>e.eventKey))&&
  r.events.every(e=>r.warmupFromAt<e.fromAt&&e.fromAt<e.until&&e.until<=r.eventCutoffAt),{message:'invalid_historical_scope'});

export const V1HistoricalExposureSchema=z.object({
  schemaVersion:z.literal(1),format:z.literal('v1-prior-exposure-v1'),capturedAt:Time,
  fileManifestSha256:Sha,databaseSnapshotSha256:Sha,declaredFileCount:z.number().int().nonnegative(),
  blockedMatchIds:z.array(Id).max(100000).refine(unique),
  opendotaSeriesIds:z.array(Id).max(100000).refine(unique),
  limitations:z.array(z.string().min(1).max(1000)).min(1).max(25),syntheticOnly:z.boolean()
}).strict();
const Path=z.string().min(1).max(1024),File=z.object({path:Path,sha256:Sha}).strict();
export const V1HistoricalFilesSchema=z.object({schemaVersion:z.literal(1),request:File,catalogue:File,exposure:File}).strict();
export const V1HistoricalDiscoveryCaptureSchema=z.object({
  source:V1ReleaseCatalogueCaptureSchema.shape.source.extend({endpoint:z.string().regex(/^\/leagues\/[1-9]\d{0,18}\/matches$/)}).strip(),
  rawBody:z.string().min(2).max(8388608)
}).strict();
export const V1HistoricalDiscoveryFilesSchema=z.object({schemaVersion:z.literal(1),
  captures:z.array(File).min(1).max(20)
}).strict();
