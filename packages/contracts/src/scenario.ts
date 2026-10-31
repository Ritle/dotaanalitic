import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
import {RosterLineupSchema} from './roster.js';
import {DraftInputSchema,DraftAssessmentSchema} from './draft.js';
const Time=z.iso.datetime({precision:3});
const Five=RosterLineupSchema.refine(rows=>rows.every(p=>p.playerId!==null),{message:'Confirm five identified players'});
const Slot=z.enum(['A','B']).nullable();
const Context=z.object({seriesId:z.uuid().nullable(),leagueId:CatalogIdSchema.nullable().optional(),mapNumber:z.number().int().min(1).max(5).nullable(),
  teamASeriesWinsBefore:z.number().int().min(0).max(4).nullable(),teamBSeriesWinsBefore:z.number().int().min(0).max(4).nullable(),
  radiantSlot:Slot,firstPickSlot:Slot,venueKind:z.enum(['lan','online','hybrid']).nullable(),tournamentStage:z.string().trim().min(1).max(120).nullable()}).strict();
export const ScenarioInputSchema=z.object({title:z.string().trim().min(1).max(120),teamAId:CatalogIdSchema,teamBId:CatalogIdSchema,
  cutoffAt:Time,scheduledAt:Time.nullable(),lineupA:Five,lineupB:Five,expectedLineupA:Five.nullable(),expectedLineupB:Five.nullable(),
  confirmedByOwner:z.literal(true),context:Context,draft:DraftInputSchema.optional()}).strict().superRefine((v,ctx)=>{
  const issue=(message:string)=>ctx.addIssue({code:'custom',message});
  if(v.teamAId===v.teamBId)issue('Teams must differ');
  for(const lines of [[v.lineupA,v.lineupB],[v.expectedLineupA??[],v.expectedLineupB??[]]]){
    const ids=lines.flat().map(p=>p.playerId);if(new Set(ids).size!==ids.length)issue('Duplicate player across teams');
  }
  if(v.scheduledAt&&v.cutoffAt>v.scheduledAt)issue('Cutoff must not follow scheduled start');
  const c=v.context;
  if((c.teamASeriesWinsBefore===null)!==(c.teamBSeriesWinsBefore===null))issue('Series scores must be supplied together');
  if(c.teamASeriesWinsBefore!==null&&c.teamBSeriesWinsBefore!==null&&
    (c.mapNumber===null||c.teamASeriesWinsBefore+c.teamBSeriesWinsBefore!==c.mapNumber-1))issue('Score must precede selected map');
});
export type ScenarioInput=z.infer<typeof ScenarioInputSchema>;
export const UpdateScenarioSchema=z.object({expectedRevision:z.number().int().min(1).max(2147483646),input:ScenarioInputSchema}).strict();
export const ScenarioSnapshotSchema=z.object({id:z.uuid(),revision:z.number().int().positive(),input:ScenarioInputSchema,
  source:z.literal('manual'),recordedAt:Time,knownAt:Time,eventAt:Time.nullable(),inputHash:z.string().regex(/^[a-f0-9]{64}$/),
  warnings:z.array(z.enum(['OWNER_ASSERTION_ONLY','RECORDED_AFTER_CUTOFF'])),predictionEligibility:z.literal('not_assessed'),draftAssessment:DraftAssessmentSchema.optional()}).strict();
export type ScenarioSnapshot=z.infer<typeof ScenarioSnapshotSchema>;
export const ScenarioListSchema=z.object({items:z.array(ScenarioSnapshotSchema),hasMore:z.boolean()}).strict();
export const ScenarioHistorySchema=z.object({items:z.array(ScenarioSnapshotSchema),hasMore:z.boolean()}).strict();
