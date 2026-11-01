import {z} from 'zod';
import {CorpusDetailSchema,CorpusShaSchema} from './corpus-audit.js';

const Time=z.iso.datetime({precision:3});
const Label=z.string().regex(/^\d{1,2}\.\d{1,2}[a-z]?$/);
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const Ref=z.object({path:z.string().min(1).max(2048),sha256:CorpusShaSchema}).strict();
const ProviderRef=Ref.extend({fetchedAt:Time,revision:z.string().regex(/^[a-f0-9]{40}$/),sourceUrl:z.string().max(2048)})
  .refine(v=>v.sourceUrl===`https://raw.githubusercontent.com/odota/dotaconstants/${v.revision}/build/patch.json`||
    v.sourceUrl===`https://github.com/odota/dotaconstants/blob/${v.revision}/build/patch.json`,{message:'invalid_provider_source'});
export const PatchDiagnosticsConfigSchema=z.object({schemaVersion:z.literal(1),snapshotAt:Time,
  mapCaptures:z.array(Ref).min(1).max(40),providerPatches:ProviderRef,valveList:Ref,
  matchIds:z.array(Id).min(1).max(2000).optional()
}).strict().refine(v=>!v.matchIds||new Set(v.matchIds).size===v.matchIds.length,{message:'duplicate_selection'});
export type PatchDiagnosticsConfig=z.infer<typeof PatchDiagnosticsConfigSchema>;

// Same audit v3 envelope, including provider code zero used by the oldest source epoch.
export const PatchDiagnosticMapCaptureSchema=CorpusDetailSchema.extend({observations:z.array(
  CorpusDetailSchema.shape.observations.element.extend({provider_patch_id:z.union([
    z.number().int().nonnegative().max(10000),z.string().regex(/^(0|[1-9]\d{0,4})$/)
  ]).nullable()})
).max(50)});
const ProviderDate=z.union([Time,z.iso.datetime({precision:0})]).transform(v=>new Date(v).toISOString());
export const ProviderPatchConstantsSchema=z.array(z.object({id:z.number().int().nonnegative().max(10000),name:Label,date:ProviderDate}))
  .min(1).max(2000);
export const ValvePatchListObservationSchema=z.object({
  data:z.object({success:z.literal(true),patches:z.array(z.object({patch_number:Label,
    patch_timestamp:z.number().int().min(1).max(253402300799)})).min(1).max(2000)}),
  source:z.object({url:z.literal('https://www.dota2.com/datafeed/patchnoteslist?language=english'),
    adapterVersion:z.literal('valve-patch-audit-v1'),fetchedAt:Time,knownAt:z.null(),
    payloadSha256:CorpusShaSchema,attempts:z.number().int().min(1).max(3)})
});
