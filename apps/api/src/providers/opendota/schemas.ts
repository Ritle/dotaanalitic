import { z } from 'zod';

const RawIdSchema = z.union([
  z.number().int().nonnegative().safe(),
  z.string().max(19).regex(/^(0|[1-9]\d*)$/)
]).transform(String).refine(id => BigInt(id) <= 9223372036854775807n);
export const ProviderIdSchema = RawIdSchema.refine(id => id !== '0');
const NullableIdSchema = RawIdSchema.transform(id => id === '0' ? null : id).nullish();
const AccountIdSchema = RawIdSchema.refine(id => BigInt(id) <= 4294967295n)
  .transform(id => id === '0' ? null : id).nullish();
const IntegerSchema = z.number().int().nonnegative().safe().nullish();

// Validate the fields we consume, strip unrelated telemetry/profile data, and
// tolerate missing facts. Completeness/eligibility are separate from JSON shape.
const MatchSummaryFields = {
  match_id: ProviderIdSchema,
  start_time: IntegerSchema,
  duration: IntegerSchema,
  radiant_win: z.boolean().nullish(),
  radiant_team_id: NullableIdSchema,
  dire_team_id: NullableIdSchema,
  leagueid: NullableIdSchema,
  series_id: NullableIdSchema,
  series_type: IntegerSchema,
  radiant_score: IntegerSchema,
  dire_score: IntegerSchema
};
export const ProMatchesSchema = z.array(z.object(MatchSummaryFields));

export const MatchPlayerSchema = z.object({
  account_id: AccountIdSchema,
  player_slot: IntegerSchema,
  hero_id: IntegerSchema,
  lane_role: IntegerSchema
});

// Keep the original action order, extra events and additional provider fields.
// Unknown side/order values are not upgraded into a verified draft timeline.
export const DraftActionSchema = z.looseObject({
  is_pick: z.boolean().nullish(),
  hero_id: IntegerSchema,
  team: IntegerSchema,
  order: IntegerSchema
});
const TeamReferenceSchema = z.object({ team_id: NullableIdSchema }).nullish();
export const MatchSchema = z.object({
  ...MatchSummaryFields,
  patch: IntegerSchema,
  game_mode: IntegerSchema,
  lobby_type: IntegerSchema,
  radiant_team: TeamReferenceSchema,
  dire_team: TeamReferenceSchema,
  players: z.array(MatchPlayerSchema).nullish(),
  picks_bans: z.array(DraftActionSchema).nullish()
});

export const TeamSchema = z.object({
  team_id: ProviderIdSchema,
  last_match_time: IntegerSchema
});
export const TeamPlayersSchema = z.array(z.object({
  account_id: AccountIdSchema,
  games_played: IntegerSchema,
  wins: IntegerSchema,
  is_current_team_member: z.boolean().nullish()
}));
export const PlayerSchema = z.object({
  profile: z.object({ account_id: AccountIdSchema }).nullish()
});

export type OpenDotaMatch = z.infer<typeof MatchSchema>;
