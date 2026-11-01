import {z} from 'zod';
import {CatalogIdSchema as Id} from './catalog.js';
export const SeriesProvisionRequestSchema=z.object({providerSeriesIds:z.array(Id).min(1).max(50)
  .refine(ids=>new Set(ids).size===ids.length),snapshotAt:z.iso.datetime({precision:3})}).strict();
export const SeriesPlanFingerprintSchema=z.string().regex(/^[a-f0-9]{64}$/);
export const SeriesProvisionResultSchema=z.object({created:z.number().int().nonnegative(),mappings:z.array(z.object({
  providerSeriesId:Id,seriesId:z.uuid(),mapIds:z.array(Id),created:z.boolean()}).strict()),
  mapWrites:z.literal(0),historicalAvailability:z.literal('not_assessed'),trainingReady:z.literal(false),deployable:z.literal(false)}).strict();
