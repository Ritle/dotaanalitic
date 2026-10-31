import { z } from 'zod';

// Deliberately independent of provider payloads and post-game match statistics.
const Id = z.string().regex(/^[1-9]\d*$/).refine(id => BigInt(id) <= 9223372036854775807n);
const Time = z.iso.datetime({ precision: 3 });
const Text = z.string().trim().min(1).max(512);
const Side = z.enum(['radiant', 'dire']);
export const PlayerSlotSchema = z.number().int().refine(slot =>
  (slot >= 0 && slot <= 4) || (slot >= 128 && slot <= 132));
const Player = z.object({ playerSlot: PlayerSlotSchema, playerId: Id.nullable() }).strict();
const Role = Player.extend({
  rolePos: z.number().int().min(1).max(5).nullable(),
  basis: z.enum(['confirmed', 'estimated', 'unknown']),
  confidence: z.number().min(0).max(1).nullable()
}).refine(role => role.basis !== 'unknown' || role.rolePos === null);
const Hero = z.object({ playerSlot: PlayerSlotSchema, heroId: z.number().int().positive() }).strict();
function uniqueSlots<T extends { playerSlot: number }>(rows: T[]) {
  return new Set(rows.map(row => row.playerSlot)).size === rows.length;
}
function uniquePlayers(rows: z.infer<typeof Player>[]) {
  const ids = rows.flatMap(row => row.playerId === null ? [] : [row.playerId]);
  return new Set(ids).size === ids.length;
}
export const ContextFactSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('league_id'), value: Id.nullable() }).strict(),
  z.object({ field: z.literal('game_mode'), value: z.number().int().min(0).max(32767).nullable() }).strict(),
  z.object({ field: z.literal('lobby_type'), value: z.number().int().min(0).max(32767).nullable() }).strict(),
  z.object({ field: z.literal('series_id'), value: z.uuid().nullable() }).strict(),
  z.object({ field: z.literal('map_number'), value: z.number().int().min(1).max(32767).nullable() }).strict(),
  z.object({ field: z.literal('series_score_before'), value: z.object({
    radiant: z.number().int().min(0).max(32767), dire: z.number().int().min(0).max(32767)
  }).strict().nullable() }).strict(),
  z.object({ field: z.literal('teams'), value: z.object({
    radiantTeamId: Id.nullable(), direTeamId: Id.nullable()
  }).strict().refine(teams => teams.radiantTeamId === null || teams.direTeamId === null ||
    teams.radiantTeamId !== teams.direTeamId).nullable() }).strict(),
  z.object({ field: z.literal('first_pick_side'), value: Side.nullable() }).strict(),
  z.object({ field: z.literal('draft_order_version'), value: Text.nullable() }).strict(),
  z.object({ field: z.literal('lineup'), value: z.array(Player).min(1).max(10)
    .refine(uniqueSlots).refine(uniquePlayers).nullable() }).strict(),
  z.object({ field: z.literal('roles'), value: z.array(Role).min(1).max(10)
    .refine(uniqueSlots).refine(uniquePlayers).nullable() }).strict(),
  z.object({ field: z.literal('heroes'), value: z.array(Hero).min(1).max(10)
    .refine(uniqueSlots).refine(rows => new Set(rows.map(row => row.heroId)).size === rows.length).nullable() }).strict()
]);
export const ContextObservationSchema = z.object({
  matchId: Id,
  fact: ContextFactSchema,
  // eventAt = the announcement/observation event, NOT the future scheduled map start.
  eventAt: Time.nullable(),
  knownAt: Time.nullable(),
  fetchedAt: Time,
  availability: z.enum(['verified_asof', 'user_asserted_asof', 'retrospective_fact', 'unknown']),
  earliestStage: z.enum(['pre_match', 'post_draft', 'post_match']),
  provider: z.string().trim().min(1).max(80),
  providerRecordId: Text.nullable(),
  evidenceRef: Text.nullable(),
  adapterVersion: Text,
  reviewState: z.enum(['unverified', 'accepted', 'conflict', 'rejected'])
}).strict().superRefine((row, ctx) => {
  if (row.knownAt !== null && row.knownAt > row.fetchedAt)
    ctx.addIssue({ code: 'custom', message: 'knownAt exceeds fetchedAt' });
  if (row.eventAt !== null && row.eventAt > row.fetchedAt)
    ctx.addIssue({ code: 'custom', message: 'eventAt exceeds fetchedAt' });
  if (row.availability === 'verified_asof' && (row.knownAt === null || row.evidenceRef === null))
    ctx.addIssue({ code: 'custom', message: 'Verified availability requires knownAt and evidenceRef' });
  if (['heroes', 'first_pick_side', 'draft_order_version'].includes(row.fact.field) && row.earliestStage === 'pre_match')
    ctx.addIssue({ code: 'custom', message: 'Draft facts are not pre-match inputs' });
});
export const ContextAsOfSchema = z.object({
  matchId: Id, cutoffAt: Time, stage: z.enum(['pre_match', 'post_draft'])
}).strict();
export type ContextFact = z.infer<typeof ContextFactSchema>;
export type ContextField = ContextFact['field'];
export type ContextObservation = z.infer<typeof ContextObservationSchema>;
export type ContextAsOf = z.infer<typeof ContextAsOfSchema>;
// recordedAt is server-owned metadata, deliberately excluded from the append DTO.
export type StoredContextObservation = ContextObservation & { id: string; recordedAt?: string | null };
