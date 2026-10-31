import { z } from 'zod';

export const CanonicalPlayerIdSchema = z.string().regex(/^[1-9]\d*$/)
  .refine(id => BigInt(id) <= 9223372036854775807n);
export const Steam32Schema = z.string().regex(/^[1-9]\d*$/).refine(id => BigInt(id) <= 4294967295n);
export const IdentityTimeSchema = z.iso.datetime({ precision: 3 });
const Evidence = z.string().trim().min(1).max(512);
const clocks = {
  eventAt: IdentityTimeSchema.nullable(), knownAt: IdentityTimeSchema.nullable(), fetchedAt: IdentityTimeSchema,
  evidenceRef: Evidence.nullable(), source: Evidence
};
export const AccountEvidenceSchema = z.object({
  playerId: CanonicalPlayerIdSchema,
  // This evidence contract requires normalized Steam32 for both provider labels.
  // STRATZ integration remains off; arbitrary provider IDs/nicknames are not accepted.
  provider: z.enum(['opendota', 'stratz']), externalAccountId: Steam32Schema,
  status: z.enum(['provisional', 'verified', 'rejected']), ...clocks
}).strict().superRefine((row, ctx) => {
  if (row.status === 'verified' && row.evidenceRef === null)
    ctx.addIssue({ code: 'custom', message: 'Verified identity requires evidence' });
  if (row.knownAt !== null && row.knownAt > row.fetchedAt || row.eventAt !== null && row.eventAt > row.fetchedAt)
    ctx.addIssue({ code: 'custom', message: 'Identity clock exceeds fetchedAt' });
});
export const AliasEvidenceSchema = z.object({
  playerId: CanonicalPlayerIdSchema, alias: z.string().trim().min(1).max(120), ...clocks
}).strict().superRefine((row, ctx) => {
  if (row.knownAt !== null && (row.knownAt > row.fetchedAt || row.evidenceRef === null) ||
    row.eventAt !== null && row.eventAt > row.fetchedAt)
    ctx.addIssue({ code: 'custom', message: 'Alias time/evidence invalid' });
});
export const PlayerHistoryRequestSchema = z.object({
  playerIds: z.array(CanonicalPlayerIdSchema).min(1).max(10).refine(ids => new Set(ids).size === ids.length),
  cutoffAt: IdentityTimeSchema
}).strict();
export type AccountEvidence = z.infer<typeof AccountEvidenceSchema>;
export type AliasEvidence = z.infer<typeof AliasEvidenceSchema>;
export type PlayerHistoryRequest = z.infer<typeof PlayerHistoryRequestSchema>;
export type StoredAccountEvidence = AccountEvidence & { observationId: string };
