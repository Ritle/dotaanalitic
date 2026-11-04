import {z} from 'zod';
import {V1JournalStatusSchema,V1JournalFiltersSchema,V1JournalRequestSchema,V1JournalInputSchema,V1JournalSummarySchema,V1ForecastJournalReportSchema} from './v1-journal.js';
import {V1LifecycleSavedSchema} from './v1-target-lifecycle.js';
export const V1JournalCurrentStatusSchema=z.enum([...V1JournalStatusSchema.options,'cancelled']);
export const V1JournalCurrentFiltersSchema=z.object({...V1JournalFiltersSchema.shape,status:V1JournalCurrentStatusSchema.nullable().default(null)}).strict()
  .refine(v=>!v.fromAt||!v.until||v.fromAt<v.until);
export type V1JournalCurrentFilters=z.infer<typeof V1JournalCurrentFiltersSchema>;
export const V1JournalCurrentRequestSchema=V1JournalRequestSchema.extend({filters:V1JournalCurrentFiltersSchema});
export const V1JournalInputV2Schema=V1JournalInputSchema.extend({format:z.literal('v1-journal-input-v2'),lifecycle:z.array(V1LifecycleSavedSchema).max(5000)});
export const V1JournalSummaryV2Schema=V1JournalSummarySchema.extend({lifecyclePolicy:z.literal('owner_reported_verified_binding_precedence_v1'),
  filters:V1JournalCurrentFiltersSchema,counts:V1JournalSummarySchema.shape.counts.extend({cancelled:z.number().int().nonnegative()}),
  rows:z.array(V1JournalSummarySchema.shape.rows.element.extend({status:V1JournalCurrentStatusSchema})).max(5000)});
export const V1ForecastJournalReportV2Schema=V1ForecastJournalReportSchema.extend({format:z.literal('v1-journal-report-v2'),
  request:V1JournalCurrentRequestSchema,summary:V1JournalSummaryV2Schema});
export const V1JournalStoredInputSchema=z.union([V1JournalInputSchema,V1JournalInputV2Schema]);
export const V1JournalStoredReportSchema=z.union([V1ForecastJournalReportSchema,V1ForecastJournalReportV2Schema]);
