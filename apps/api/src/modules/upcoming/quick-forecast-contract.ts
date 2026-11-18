import {z} from 'zod';
import {CatalogIdSchema,ScenarioInputSchema,Tier1ScopeSchema,V1ScheduleTargetRequestSchema,V1ScheduledPredictionViewSchema} from '@dota/contracts';
const Id=CatalogIdSchema;
export const QuickForecastRequestSchema=z.object({requestId:z.uuid().transform(s=>s.toLowerCase()),
 providerTeamAId:Id,providerTeamBId:Id,teamAId:Id,teamBId:Id,
 lineupA:ScenarioInputSchema.shape.lineupA,lineupB:ScenarioInputSchema.shape.lineupB,
 tournament:z.object({leagueId:Id,scope:Tier1ScopeSchema}).strict().optional()
}).strict();
export type QuickForecastRequest=z.infer<typeof QuickForecastRequestSchema>;
export const QuickForecastPlanSchema=z.object({target:V1ScheduleTargetRequestSchema,scenarioId:z.uuid(),scope:Tier1ScopeSchema.nullable(),saveScope:z.boolean(),templates:z.array(z.object({teamId:Id,revision:z.number().int().positive(),confirmedAt:z.iso.datetime()})).length(2)}).strict();
export const QuickForecastResponseSchema=z.object({targetId:z.uuid(),scenarioId:z.uuid(),forecast:V1ScheduledPredictionViewSchema}).strict();
export type QuickForecastResponse=z.infer<typeof QuickForecastResponseSchema>;

export const QuickForecastFailureSchema=z.object({error:z.object({code:z.string(),message:z.string(),leagueId:z.string().nullable().optional()})});

export const QuickForecastStageSchema=z.enum(['request','schedule','lineups','map','analysis','complete']);
export type QuickForecastStage=z.infer<typeof QuickForecastStageSchema>;
export const QuickForecastProgressSchema=z.object({stage:QuickForecastStageSchema,state:z.enum(['running','complete','failed']),reused:z.boolean(),updatedAt:z.iso.datetime()}).strict();
export type QuickForecastProgress=z.infer<typeof QuickForecastProgressSchema>;
export const QuickForecastProgressResponseSchema=z.object({progress:QuickForecastProgressSchema.nullable()}).strict();
