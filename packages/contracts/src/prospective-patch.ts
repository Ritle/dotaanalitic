import { z } from 'zod';

const Time = z.iso.datetime({ precision: 3 });
const Text = z.string().trim().min(1).max(512);
const Label = z.string().regex(/^\d{1,2}\.\d{1,2}[a-z]?$/);
const Id = z.string().regex(/^[1-9]\d{0,18}$/)
  .refine(value => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
const Scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('game') }).strict(),
  z.object({ kind: z.literal('league'), leagueId: Id }).strict()
]);
const proof = {
  id: Id, patchLabel: Label, scope: Scope,
  eventAt: Time, knownAt: Time, fetchedAt: Time, recordedAt: Time, reviewedAt: Time,
  source: Text, evidenceRef: Text, payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviewState: z.enum(['accepted', 'unverified', 'conflict', 'rejected'])
};

/** Trusted reviewed claims, not a provider decoder or a public owner-input contract. */
export const ProspectivePatchEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ ...proof, kind: z.literal('active_version') }).strict(),
  z.object({ ...proof, kind: z.literal('publication') }).strict(),
  z.object({ ...proof, kind: z.literal('announced_transition'), effectiveAt: Time.nullable() }).strict()
]).superRefine((row, ctx) => {
  if (row.eventAt > row.knownAt || row.knownAt > row.fetchedAt ||
      row.fetchedAt > row.recordedAt || row.recordedAt > row.reviewedAt)
    ctx.addIssue({ code: 'custom', message: 'invalid_prospective_evidence_clocks' });
});

export const ProspectivePatchRequestSchema = z.object({
  cutoffAt: Time,
  target: z.object({
    kind: z.literal('single_map_scenario'), scenarioId: z.uuid(),
    scenarioRevision: z.number().int().positive().max(2147483647),
    leagueId: Id.nullable(), scheduledMapAt: Time.nullable()
  }).strict(),
  assumption: z.enum(['none', 'same_as_observed']),
  freshness: z.object({
    policyRevision: Text,
    // Explicit operational policy, never a fitted accuracy/coverage guarantee.
    maxAgeSeconds: z.number().int().positive().max(31536000)
  }).strict()
}).strict().refine(row => row.target.scheduledMapAt === null || row.target.scheduledMapAt > row.cutoffAt,
  { message: 'prospective_map_must_be_after_cutoff' });

export const ProspectivePatchInputSchema = z.object({
  request: ProspectivePatchRequestSchema,
  evidence: z.array(ProspectivePatchEvidenceSchema).max(2000)
}).strict();
export type ProspectivePatchEvidence = z.infer<typeof ProspectivePatchEvidenceSchema>;
export type ProspectivePatchRequest = z.infer<typeof ProspectivePatchRequestSchema>;
export type ProspectivePatchInput = z.infer<typeof ProspectivePatchInputSchema>;
