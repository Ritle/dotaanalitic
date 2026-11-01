import { z } from 'zod';
import { AccountEvidenceSchema } from './identity.js';
const Id = z.string().regex(/^[1-9]\d{0,18}$/).refine(v => /^[1-9]\d{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
const Us = z.string().regex(/^\d{1,18}$/);
const Time = z.iso.datetime({ precision: 3 });
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().min(1).max(512);
export const RESEARCH_ELO_COHORT = 'research_event_time_reconstructed' as const;
export const ResearchEloRequestSchema = z.object({
  schemaVersion: z.literal(1), cohort: z.literal(RESEARCH_ELO_COHORT),
  fromAt: Time, holdoutFromAt: Time, toAt: Time, snapshotAt: Time,
  maxMaps: z.number().int().min(1).max(5000),
  evaluationPolicy: z.literal('event-time-prequential-series-v1')
}).strict().refine(r => r.fromAt < r.holdoutFromAt && r.holdoutFromAt < r.toAt && r.toAt <= r.snapshotAt,
  { message: 'invalid_research_windows' });
const Source = z.object({ receiptId: Id, payloadSha256: Sha, adapterVersion: Text, normalizerVersion: Text, receiptFetchedAt: Time }).strict();
export const ResearchOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('verified'), matchId: Id, outcomeReceiptId: Id, teamAId: Id, teamBId: Id,
    teamAWon: z.boolean(), startedAt: Time, completedAt: Time, seriesId: z.uuid().nullable(),
    dataRevision: Us, labelVerifiedAt: Time, sourceEvidence: Source }).strict(),
  z.object({ status: z.literal('unavailable'), matchId: Id, reasons: z.array(Text) }).strict()
]);
const Player = z.object({ playerSlot: z.number().int().min(0).max(255), sourceAccountId: Id.nullable() }).strict();
const FactClock = z.object({ id: Id, field: Text, eventAtUs: Us.nullable(), knownAtUs: Us.nullable(),
  fetchedAtUs: Us, recordedAtUs: Us.nullable(), reviewState: Text, availability: Text }).strict();
export const ResearchEloMapSchema = z.object({ matchId: Id, startedAtUs: Us, endedAtUs: Us.nullable(),
  syncedAtUs: Us, dataRevision: Us, isPro: z.boolean().nullable(), ingestState: z.enum(['accepted', 'partial', 'conflict']),
  radiantWin: z.boolean().nullable(), radiantTeamId: Id.nullable(), direTeamId: Id.nullable(), seriesId: z.uuid().nullable(),
  players: z.array(Player).max(100), receiptPlayers: z.array(Player).max(100),
  outcome: ResearchOutcomeSchema, seriesSourceMatched: z.boolean(), facts: z.array(FactClock).max(2000)
}).strict();
export const ResearchSeriesAliasSchema = z.object({ seriesId: z.uuid(), provider: z.string().nullable(),
  providerSeriesId: z.string().nullable(), teamAId: Id.nullable(), teamBId: Id.nullable() }).strict();
export const ResearchEloBodySchema = z.object({ schemaVersion: z.literal(1), format: z.literal('research-elo-export-v1'),
  cohort: z.literal(RESEARCH_ELO_COHORT), request: ResearchEloRequestSchema,
  identityRevision: Us, candidates: z.array(ResearchEloMapSchema).max(5000), aliases: z.array(ResearchSeriesAliasSchema).max(5000),
  identities: z.array(AccountEvidenceSchema.safeExtend({ observationId: Text })).max(100000),
  code: z.array(z.object({ path: Text, sha256: Sha }).strict()).min(1).max(12),
  policy: z.object({ version: z.literal('player-mean-elo-v1'), initialRating: z.literal(1500), k: z.literal(32),
    scale: z.literal(400), validation: z.literal('unvalidated') }).strict(),
  syntheticOnly: z.boolean(), trainingReady: z.literal(false), deployable: z.literal(false)
}).strict();
export const ResearchEloExportSchema = ResearchEloBodySchema.extend({ fingerprint: Sha });
export type ResearchEloRequest = z.infer<typeof ResearchEloRequestSchema>;
export type ResearchEloBody = z.infer<typeof ResearchEloBodySchema>;
export type ResearchEloMap = z.infer<typeof ResearchEloMapSchema>;
