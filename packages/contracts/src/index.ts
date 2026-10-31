import { z } from 'zod';
export * from './temporal.js';
export * from './identity.js';
export * from './game-context.js';
export * from './dataset.js';
export * from './readiness.js';
export * from './catalog.js';
export * from './pro-maps.js';
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

export const OwnerLoginSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9_.-]{3,120}$/);
export const OwnerPasswordSchema = z.string().min(12).max(128);
export const LoginSchema = z.object({ login: OwnerLoginSchema, password: z.string().min(1).max(128) }).strict();
export const OwnerSchema = z.object({ id: z.uuid(), login: OwnerLoginSchema });
export const AuthResponseSchema = z.object({
  owner: OwnerSchema,
  expiresAt: z.iso.datetime(),
  csrfToken: z.string().min(1).max(512)
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;
export * from './roster.js';
export * from './player-hero.js';
export * from './strength.js';
export * from './sample.js';
export * from './patch-history.js';
export * from './compare.js';
export * from './scenario.js';
export * from './draft.js';
export * from './hero-matchups.js';
export * from './scenario-report.js';
