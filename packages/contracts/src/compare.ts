import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
import {RosterLineupSchema,RosterReportSchema} from './roster.js';
import {SampleEvidenceSchema} from './sample.js';
import {ProMapItemSchema} from './pro-maps.js';
import {StrengthResponseSchema} from './strength.js';
const Time=z.iso.datetime({precision:3}),Count=z.number().int().nonnegative();
export const CompareRequestSchema=z.object({teamAId:CatalogIdSchema,teamBId:CatalogIdSchema,lineupA:RosterLineupSchema,lineupB:RosterLineupSchema,
  fromAt:Time.optional(),cutoffAt:Time.optional(),patchId:CatalogIdSchema.optional(),leagueId:CatalogIdSchema.optional()}).strict().superRefine((r,c)=>{
  const ids=[...r.lineupA,...r.lineupB].flatMap(p=>p.playerId??[]);
  if(r.teamAId===r.teamBId||new Set(ids).size!==ids.length||r.fromAt&&r.cutoffAt&&r.fromAt>=r.cutoffAt)c.addIssue({code:'custom',message:'Invalid teams, lineups or dates'});
});
export type CompareRequest=z.infer<typeof CompareRequestSchema>;
const Stats=z.object({nRaw:Count.nullable(),wins:Count.nullable(),winRate:z.number().min(0).max(1).nullable(),dataUpdatedAt:Time.nullable(),sampleEvidence:SampleEvidenceSchema}).strict();
const Team=z.object({organizationId:CatalogIdSchema,name:z.string(),organization:Stats,recent:Stats,currentPatch:Stats.nullable(),selectedFiveOrganization:Stats,
  sides:z.object({radiant:Stats,dire:Stats}).strict(),opponents:z.array(z.object({opponentId:CatalogIdSchema.nullable(),stats:Stats}).strict()),
  cohesion:RosterReportSchema,strength:StrengthResponseSchema}).strict();
export const CompareReportSchema=z.object({status:z.enum(['ready','insufficient_data']),scope:z.literal('retrospective_descriptive'),policyVersion:z.literal('team-compare-v1'),
  input:CompareRequestSchema,fromAt:Time,cutoffAt:Time,snapshotAt:Time,source:z.literal('normalized_local_maps'),identityRevision:z.string(),registryRevision:z.string(),
  currentPatchId:CatalogIdSchema.nullable(),recentLimit:z.literal(20),model:z.null(),predictionEligibility:z.literal('not_assessed'),teamAWinProbability:z.null(),
  teamA:Team,teamB:Team,h2h:z.object({organizations:Stats,selectedFives:Stats,maps:z.array(ProMapItemSchema.extend({teamASide:z.enum(['radiant','dire']),
    teamAPlayerIds:z.array(CatalogIdSchema.nullable()).length(5),teamBPlayerIds:z.array(CatalogIdSchema.nullable()).length(5),
    matchesSelectedFives:z.boolean().nullable()})),displayedLimit:z.literal(100),omittedMaps:Count}).strict(),
  coverage:z.object({candidates:Count,unknownPro:Count,nonPro:Count,conflict:Count,unfinished:Count,unattributedOrganizationMaps:Count,
    h2hIncompleteFives:Count,lineupHistoryFilterExcluded:Count}).strict(),warnings:z.array(z.string())}).strict();
export const CompareResponseSchema=z.union([CompareReportSchema,z.object({status:z.literal('unavailable'),reason:z.literal('WINDOW_TOO_LARGE'),
  maxCandidates:z.literal(5000),message:z.string()}).strict()]);
export type CompareReport=z.infer<typeof CompareReportSchema>;
