import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
import {V1JournalInputV2Schema,V1JournalSummaryV2Schema,V1ForecastJournalReportV2Schema,V1JournalStoredInputSchema,V1JournalStoredReportSchema} from './v1-journal-v2.js';
import {V1ScheduledLifecycleSavedSchema} from './v1-scheduled-lifecycle.js';
// Evidence that a meeting was once bound to a verified map; not a fresh outcome or a scoring label.
export const V1JournalScheduledBindingSchema=z.object({providerMatchId:CatalogIdSchema,matchId:CatalogIdSchema,requestId:z.uuid(),
  sha256:z.string().regex(/^[a-f0-9]{64}$/),reviewedAt:z.iso.datetime({precision:6})}).strict();
export const V1JournalInputV3Schema=V1JournalInputV2Schema.extend({format:z.literal('v1-journal-input-v3'),
  scheduledLifecycle:z.array(V1ScheduledLifecycleSavedSchema).max(5000),scheduledBindings:z.array(V1JournalScheduledBindingSchema).max(5000)});
export const V1JournalSummaryV3Schema=V1JournalSummaryV2Schema.extend({lifecyclePolicy:z.literal('owner_reported_verified_binding_precedence_v2')});
export const V1ForecastJournalReportV3Schema=V1ForecastJournalReportV2Schema.extend({format:z.literal('v1-journal-report-v3'),summary:V1JournalSummaryV3Schema});
export const V1JournalAllInputSchema=z.union([V1JournalStoredInputSchema,V1JournalInputV3Schema]);
export const V1JournalAllReportSchema=z.union([V1JournalStoredReportSchema,V1ForecastJournalReportV3Schema]);
