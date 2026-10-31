import { z } from 'zod';
import { ContextAsOfSchema } from './temporal.js';

export const ReadinessFieldSchema = z.enum(['lineup','roles','teams','patch','heroes','first_pick_side','draft_order_version']);
export const ReadinessCohortSchema = z.enum(['strict_verified_asof','owner_asserted_asof','conditional_lineup_reconstructed']);
const Fields = z.array(ReadinessFieldSchema).max(7).refine(fields => new Set(fields).size === fields.length);
export const ReadinessRequestSchema = ContextAsOfSchema.extend({
  snapshotAt: z.iso.datetime({ precision: 3 }), cohort: ReadinessCohortSchema,
  requiredFacts: Fields.min(1), assumedFacts: Fields.default([])
}).strict().superRefine((row, ctx) => {
  if (row.snapshotAt < row.cutoffAt) ctx.addIssue({ code: 'custom', message: 'Snapshot precedes cutoff' });
  if (row.cohort === 'conditional_lineup_reconstructed' ? !row.assumedFacts.includes('lineup') : row.assumedFacts.length > 0)
    ctx.addIssue({ code: 'custom', message: 'Only conditional cohort declares assumptions and must declare lineup' });
  const draftFacts = ['heroes','first_pick_side','draft_order_version'];
  if (row.stage === 'pre_match' && [...row.requiredFacts,...row.assumedFacts].some(field => draftFacts.includes(field)))
    ctx.addIssue({ code: 'custom', message: 'Pre-match cannot request current draft facts' });
  if (row.assumedFacts.some(field => ['first_pick_side','draft_order_version'].includes(field)))
    ctx.addIssue({ code: 'custom', message: 'Draft order cannot be reconstructed as an assumed fact' });
});
export type ReadinessField = z.infer<typeof ReadinessFieldSchema>;
export type ReadinessRequest = z.infer<typeof ReadinessRequestSchema>;
