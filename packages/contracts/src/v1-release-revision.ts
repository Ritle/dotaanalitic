import {z} from 'zod';
import {V1ReleasePlanRequestSchema, V1ReleaseCatalogueCaptureSchema} from './v1-release-plan.js';

const Time=z.iso.datetime({precision:3}), Sha=z.string().regex(/^[a-f0-9]{64}$/);
const {catalogueSha256: _catalogue, events, ...requestFields}=V1ReleasePlanRequestSchema.shape;
const Event=events.element.extend({leagueId:events.element.shape.leagueId.nullable()})
  .refine(e=>![e.name,e.catalogueName].some(n=>/qualif|division\s*(?:2|ii)\b/i.test(n)),{message:'main_event_required'});

/** An intent with unresolved IDs is never a registered plan or a prediction input. */
export const V1ReleaseRevisionIntentSchema=z.object({
  schemaVersion:z.literal(1), format:z.literal('v1-release-revision-intent-v1'),
  revisionKey:z.string().regex(/^[a-z0-9-]{3,100}$/), recordedAt:Time,
  supersedesPlanSha256:Sha, qualityPolicySha256:Sha,
  oldPlanUse:z.literal('archive_only_no_release_selection'), reason:z.string().min(20).max(2000),
  request:z.object({...requestFields,events:z.array(Event).min(1).max(5)}).strict()
    .refine(r=>new Set(r.events.map(e=>e.eventKey)).size===r.events.length &&
      new Set(r.events.filter(e=>e.leagueId!==null).map(e=>e.leagueId)).size===r.events.filter(e=>e.leagueId!==null).length &&
      r.events.every(e=>r.warmupFromAt<e.fromAt&&e.fromAt<e.until&&e.until<r.snapshotAt),{message:'invalid_revision_windows'})
}).strict();

const Path=z.string().min(1).max(1024), File=z.object({path:Path,sha256:Sha}).strict();
export const V1ReleaseRevisionFilesSchema=z.object({
  schemaVersion:z.literal(1),intent:File,catalogue:File,
  previousBundle:z.object({path:Path,configSha256:Sha,freezeSha256:Sha}).strict()
}).strict();

/** Accept provider transport annotations, but only validated catalogue facts enter the new plan. */
export const V1ReleaseRevisionCatalogueSchema=z.object({
  source:V1ReleaseCatalogueCaptureSchema.shape.source.strip(),
  rawBody:V1ReleaseCatalogueCaptureSchema.shape.rawBody
}).strip();
