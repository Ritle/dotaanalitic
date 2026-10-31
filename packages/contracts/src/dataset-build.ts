import { z } from 'zod';
const Time = z.iso.datetime({ precision: 3 });
/** Fixed preparation policy: no caller-supplied features, labels, assumptions or synthetic mode. */
export const DatasetBuildRequestSchema = z.object({
  stage: z.enum(['pre_match','post_draft']), teamASide: z.enum(['radiant','dire']),
  fromAt: Time, trainUntil: Time, calibrationUntil: Time, validationUntil: Time, toAt: Time,
  snapshotAt: Time, maxMaps: z.number().int().min(1).max(5000).default(1000)
}).strict().superRefine((r, ctx) => {
  const boundaries = [r.fromAt,r.trainUntil,r.calibrationUntil,r.validationUntil,r.toAt];
  if (boundaries.some((v,i) => i > 0 && v <= boundaries[i-1]!))
    ctx.addIssue({ code:'custom', message:'Split boundaries must be strictly increasing' });
  if (r.toAt > r.snapshotAt) ctx.addIssue({ code:'custom', message:'Selection ends after snapshot' });
});
export type DatasetBuildRequest = z.infer<typeof DatasetBuildRequestSchema>;
