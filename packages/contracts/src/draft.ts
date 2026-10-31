import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
const Hero=z.number().int().positive().max(2147483647),Slot=z.enum(['A','B']);
export const DraftInputSchema=z.object({assignments:z.array(z.object({teamSlot:Slot,rolePos:z.number().int().min(1).max(5),heroId:Hero}).strict()).max(10),
  // This is a bounded request size, not a historical draft-order rule.
  bans:z.array(z.object({teamSlot:Slot,heroId:Hero}).strict()).max(40)}).strict().superRefine((v,ctx)=>{
  const ids=[...v.assignments,...v.bans].map(p=>p.heroId);
  if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',message:'Duplicate picked or banned hero'});
  if(new Set(v.assignments.map(p=>p.teamSlot+String(p.rolePos))).size!==v.assignments.length)ctx.addIssue({code:'custom',message:'Duplicate draft slot'});
});
export type DraftInput=z.infer<typeof DraftInputSchema>;
const Time=z.iso.datetime({precision:3});
const Proof=z.object({id:CatalogIdSchema,kind:z.enum(['patch','hero']),source:z.string(),evidenceRef:z.string(),eventAt:Time.nullable(),knownAt:Time,fetchedAt:Time,
  reviewState:z.enum(['accepted','conflict'])}).strict();
const Decision=z.object({value:z.boolean().nullable(),reason:z.string().nullable(),evidenceIds:z.array(CatalogIdSchema)}).strict();
export const DraftAssessmentSchema=z.object({status:z.enum(['blocked','unknown','available']),policyVersion:z.literal('scenario-draft-v1'),
  registryRevision:z.string().regex(/^\d+$/),checkedAt:Time,knowledgeAt:Time,mapTime:Time.nullable(),leagueId:CatalogIdSchema.nullable(),
  patch:z.object({value:CatalogIdSchema.nullable(),reason:z.string().nullable(),evidenceIds:z.array(CatalogIdSchema)}).strict(),
  assignedHeroes:z.number().int().min(0).max(10),fullDraft:z.boolean(),draftOrderValidated:z.literal(false),
  heroes:z.array(z.object({heroId:Hero,teamSlot:Slot,rolePos:z.number().int().min(1).max(5).nullable(),action:z.enum(['pick','ban']),decision:Decision}).strict()),
  proofs:z.array(Proof),warnings:z.array(z.string()),predictionStatus:z.literal('unavailable'),teamAWinProbability:z.null()}).strict();
export type DraftAssessment=z.infer<typeof DraftAssessmentSchema>;
