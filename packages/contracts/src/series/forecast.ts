import {z} from 'zod';
import {CatalogIdSchema} from '../catalog.js';
export const SeriesBestOfSchema=z.union([z.literal(1),z.literal(3),z.literal(5)]);
export type SeriesBestOf=z.infer<typeof SeriesBestOfSchema>;
export const SeriesForecastReadinessSchema=z.object({
 targetUnit:z.literal('series'),provider:z.literal('pandascore'),providerMatchId:CatalogIdSchema,
 bestOf:z.number().int().min(1).max(20).nullable(),scheduledAt:z.iso.datetime({offset:true}).nullable(),
 checkedAt:z.iso.datetime({offset:true}),sourceFetchedAt:z.iso.datetime({offset:true}).nullable(),
 sourceSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
 status:z.literal('unavailable'),teamAWinProbability:z.null(),teamBWinProbability:z.null(),
 modelVersion:z.null(),reasons:z.array(z.string().min(1)).min(1),
}).strict();
export type SeriesForecastReadiness=z.infer<typeof SeriesForecastReadinessSchema>;

/** Research comparison only: these are source-checked outcomes, not training labels or published forecasts. */
export const SeriesDiagnosticExampleSchema=z.object({
 seriesKey:z.string().min(1).max(160),forecastId:z.string().min(1).max(160),bestOf:SeriesBestOfSchema,
 startedAt:z.iso.datetime({offset:true}),endedAt:z.iso.datetime({offset:true}),
 baseIssuedAt:z.iso.datetime({offset:true}),featureCutoffAt:z.iso.datetime({offset:true}),
 mapProbability:z.number().finite().min(0).max(1),teamAWon:z.boolean(),
 sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const SeriesDiagnosticInputSchema=z.array(SeriesDiagnosticExampleSchema).max(10000);
