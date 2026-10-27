import { z } from 'zod';
// API-facing BIGINT identifiers travel as strings; do not coerce via Number.
export const IdSchema = z.string().regex(/^[1-9]\d*$/);
export const SideSchema = z.enum(['radiant', 'dire']);
export const StageSchema = z.enum(['pre_match', 'post_draft']);
export const ScenarioSlotSchema = z.enum(['A', 'B']);
export const PredictionStatusSchema = z.enum(['pending', 'running', 'done', 'failed', 'unavailable']);
export const StatResultSchema = z.object({
  games: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  winRate: z.number().min(0).max(1).nullable(),
  updatedAt: z.string().datetime().nullable(),
  warnings: z.array(z.string())
}).refine(value => value.wins <= value.games);
export const CreateScenarioSchema = z.object({
  teamAId: IdSchema,
  teamBId: IdSchema,
  cutoffAt: z.string().datetime(),
  scheduledAt: z.string().datetime().optional(),
  radiantSlot: ScenarioSlotSchema.nullable().optional()
}).refine(value => value.teamAId !== value.teamBId, { message: 'Teams must differ' });
export type CreateScenario = z.infer<typeof CreateScenarioSchema>;
