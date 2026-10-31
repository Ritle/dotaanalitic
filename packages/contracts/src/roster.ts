import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
import {SampleEvidenceSchema} from './sample.js';
const Time=z.iso.datetime({precision:3}),Count=z.number().int().nonnegative();
export const RosterMemberSchema=z.object({playerId:CatalogIdSchema.nullable(),rolePos:z.number().int().min(1).max(5),isStandin:z.boolean().default(false)}).strict();
export const RosterLineupSchema=z.array(RosterMemberSchema).length(5).refine(rows=>new Set(rows.map(p=>p.rolePos)).size===5&&
  new Set(rows.flatMap(p=>p.playerId??[])).size===rows.filter(p=>p.playerId!==null).length,{message:'Duplicate role or player'});
export const RosterRequestSchema=z.object({lineup:RosterLineupSchema,expectedLineup:RosterLineupSchema.nullable().default(null),
  fromAt:Time.optional(),cutoffAt:Time.optional()}).strict().refine(q=>!q.fromAt||!q.cutoffAt||q.fromAt<q.cutoffAt);
export type RosterRequest=z.infer<typeof RosterRequestSchema>;
const Sample=z.object({nRaw:Count.nullable(),wins:Count.nullable(),winRate:z.number().min(0).max(1).nullable(),recentMaps:Count.nullable(),
  firstAt:Time.nullable(),lastAt:Time.nullable(),dataUpdatedAt:Time.nullable(),patchDistribution:z.array(z.object({patchId:CatalogIdSchema.nullable(),maps:Count}).strict()),sampleEvidence:SampleEvidenceSchema}).strict();
const Description=z.object({lineup:RosterLineupSchema,fingerprint:z.string().nullable(),exactFive:Sample,exactFiveOrganizationMaps:Count.nullable(),
  pairs:z.array(Sample.extend({playerIds:z.array(CatalogIdSchema.nullable()).length(2),organizationMaps:Count.nullable()})).length(10),
  players:z.array(Sample.extend({playerId:CatalogIdSchema.nullable(),rolePos:z.number().int().min(1).max(5),isStandin:z.boolean(),identityStatus:z.enum(['verified','unknown']),
    confirmedRoleMaps:Count.nullable(),selectedRoleMaps:Count.nullable(),organizations:z.array(Sample.extend({organizationId:CatalogIdSchema.nullable()}))})).length(5)}).strict();
export const RosterReportSchema=z.object({status:z.enum(['ready','partial','insufficient_data']),scope:z.literal('retrospective_descriptive'),policyVersion:z.literal('roster-display-v1'),
  organizationId:CatalogIdSchema,input:RosterRequestSchema,snapshotAt:Time,cutoffAt:Time,recentFrom:Time,recentDays:z.literal(90),source:z.literal('normalized_local_maps'),
  identityRevision:z.string(),registryRevision:z.string(),model:z.null(),predictionEligibility:z.literal('not_assessed'),
  actual:Description,expected:Description.nullable(),comparison:z.object({retainedPlayers:Count,changedPlayers:Count,retainedPairLinks:Count,lostPairLinks:Count,addedPairLinks:Count,roleChanges:Count}).strict().nullable(),
  churn:z.object({limit:Count,maps:Count,completeMaps:Count,uniqueFives:Count.nullable(),changedTransitions:Count.nullable(),meanRetainedPlayers:z.number().nullable(),knownTransitions:Count,
    transitions:z.array(z.object({fromMatchId:CatalogIdSchema,toMatchId:CatalogIdSchema,retainedPlayers:Count.nullable(),changedPlayers:Count.nullable()}).strict())}).strict(),
  coverage:z.object({candidates:Count,unknownPro:Count,nonPro:Count,conflict:Count,unfinished:Count,eligibleMaps:Count,incompleteSides:Count,duplicateIdentityMaps:Count,
    knownPatchMaps:Count,lateFetchedMaps:Count,sourceFetchUnknown:Count}).strict(),
  provenance:z.array(z.object({matchId:CatalogIdSchema,dataRevision:z.string(),source:z.string(),syncedAt:Time,sourceFetchedAt:Time.nullable(),identityProofIds:z.array(z.string()),roleProofIds:z.array(z.string()),patchProofIds:z.array(z.string())}).strict()),
  warnings:z.array(z.string())}).strict();
export const RosterResponseSchema=z.union([RosterReportSchema,z.object({status:z.literal('unavailable'),reason:z.literal('WINDOW_TOO_LARGE'),maxCandidates:z.literal(5000),message:z.string()}).strict()]);
export type RosterReport=z.infer<typeof RosterReportSchema>;
