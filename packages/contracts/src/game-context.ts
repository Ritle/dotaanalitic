import { z } from 'zod';
import { ContextAsOfSchema } from './temporal.js';

const Id = z.string().regex(/^[1-9]\d{0,18}$/).refine(id => BigInt(id) <= 9223372036854775807n);
const Time = z.iso.datetime({ precision: 3 });
const Text = z.string().trim().min(1).max(512);
const clocks = {
  eventAt: Time.nullable(), knownAt: Time, fetchedAt: Time,
  source: Text, evidenceRef: Text, reviewState: z.enum(['accepted', 'unverified', 'conflict', 'rejected'])
};
function clocksValid(row: z.infer<typeof CommonEvidenceSchema>, ctx: z.RefinementCtx) {
  if (row.knownAt > row.fetchedAt || row.eventAt !== null && row.eventAt > row.fetchedAt)
    ctx.addIssue({ code: 'custom', message: 'Evidence clock exceeds fetchedAt' });
}
const CommonEvidenceSchema = z.object(clocks);
export const PatchReleaseEvidenceSchema = z.object({
  ...clocks, patchId: Id, releasedAt: Time,
  // Explicit coverage horizon: NOT a guess that the last known patch lasts forever.
  coverageUntil: Time
}).strict().superRefine((row, ctx) => {
  clocksValid(row, ctx);
  if (row.releasedAt >= row.coverageUntil || row.coverageUntil > row.fetchedAt)
    ctx.addIssue({ code: 'custom', message: 'Invalid verified patch coverage interval' });
});
export const DraftRuleEvidenceSchema = z.object({
  ...clocks, patchId: Id, gameMode: z.number().int().min(0).max(32767), lobbyType: z.number().int().min(0).max(32767),
  version: Text
}).strict().superRefine(clocksValid);
export const HeroRuleEvidenceSchema = z.object({
  ...clocks, heroId: z.number().int().positive().max(2147483647), patchId: Id.nullable(), leagueId: Id.nullable(),
  allowed: z.boolean(), validFrom: Time, validTo: Time.nullable()
}).strict().superRefine((row, ctx) => {
  clocksValid(row, ctx);
  if (row.validTo !== null && row.validFrom >= row.validTo)
    ctx.addIssue({ code: 'custom', message: 'Invalid hero rule interval' });
});
export const GameContextRequestSchema = ContextAsOfSchema.extend({ teamAId: Id, teamBId: Id })
  .refine(row => row.teamAId !== row.teamBId, { message: 'Teams must differ' });
export type PatchReleaseEvidence = z.infer<typeof PatchReleaseEvidenceSchema>;
export type DraftRuleEvidence = z.infer<typeof DraftRuleEvidenceSchema>;
export type HeroRuleEvidence = z.infer<typeof HeroRuleEvidenceSchema>;
export type GameContextRequest = z.infer<typeof GameContextRequestSchema>;
export type GameRegistry = {
  revision: string;
  patches: (PatchReleaseEvidence & { id: string })[];
  draftRules: (DraftRuleEvidence & { id: string })[];
  heroRules: (HeroRuleEvidence & { id: string })[];
};
