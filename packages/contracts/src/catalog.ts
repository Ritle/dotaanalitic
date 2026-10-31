import { z } from 'zod';

export const CatalogKindSchema = z.enum(['teams','players','heroes']);
export type CatalogKind = z.infer<typeof CatalogKindSchema>;
export const CatalogIdSchema = z.string().regex(/^[1-9]\d{0,18}$/).refine(id => /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n);
export const CatalogQuerySchema = z.object({
  query: z.string().trim().max(80).default(''),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(10000).default(0)
}).strict();
export type CatalogQuery = z.infer<typeof CatalogQuerySchema>;
const Time = z.iso.datetime();
export const CatalogItemSchema = z.object({
  id: CatalogIdSchema, name: z.string(), secondary: z.string().nullable(),
  syncedAt: Time.nullable(), metadataUpdatedAt: Time
}).strict();
export const CatalogListSchema = z.object({
  kind: CatalogKindSchema, items: z.array(CatalogItemSchema), hasMore: z.boolean(),
  filters: CatalogQuerySchema, source: z.literal('local_catalog'), computedAt: Time,
  warnings: z.array(z.string())
}).strict();
export type CatalogList = z.infer<typeof CatalogListSchema>;
export const TeamOverviewSchema = z.object({
  entity: CatalogItemSchema, entityType: z.literal('organization'), currentLineup: z.null(),
  latestObservedLineup: z.object({
    matchId: CatalogIdSchema, startedAt: Time, syncedAt: Time, source: z.string(),
    side: z.enum(['radiant','dire']), status: z.enum(['complete','incomplete']),
    members: z.array(z.object({ playerSlot: z.number().int(), playerId: CatalogIdSchema.nullable(), name: z.string().nullable() }).strict())
  }).strict().nullable(),
  source: z.literal('local_catalog'), cutoffAt: Time, computedAt: Time, warnings: z.array(z.string())
}).strict();
export type TeamOverview = z.infer<typeof TeamOverviewSchema>;
export const PlayerOverviewSchema = z.object({
  entity: CatalogItemSchema, entityType: z.literal('canonical_player'),
  catalogAccountId: z.string().nullable(), accountVerification: z.literal('not_assessed'),
  currentTeam: z.null(), source: z.literal('local_catalog'), computedAt: Time, warnings: z.array(z.string())
}).strict();
export type PlayerOverview = z.infer<typeof PlayerOverviewSchema>;
