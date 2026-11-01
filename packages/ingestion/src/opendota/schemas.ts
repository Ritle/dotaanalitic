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
  lane_role: IntegerSchema,
  kills: IntegerSchema, deaths: IntegerSchema, assists: IntegerSchema,
  gold_per_min: IntegerSchema, xp_per_min: IntegerSchema
});

// Keep the original action order, extra events and additional provider fields.
// Unknown side/order values are not upgraded into a verified draft timeline.
export const DraftActionSchema = z.looseObject({
  is_pick: z.boolean().nullish(),
  hero_id: IntegerSchema,
  team: IntegerSchema,
  order: IntegerSchema
});
const TeamReferenceSchema = z.object({ team_id: NullableIdSchema,
  name: z.string().min(1).max(256).nullish(), tag: z.string().max(64).nullish() }).nullish();
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
  name: z.string().max(256).nullish(),tag: z.string().max(64).nullish(),
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

export const HeroesSchema = z.array(z.object({ id: z.number().int().positive().max(2147483647),
  name: z.string().min(1).max(256), localized_name: z.string().min(1).max(256) }));
export const LeaguesSchema = z.array(z.object({ leagueid: ProviderIdSchema,
  name: z.string().nullish(), tier: z.string().nullish() }));
export const MatchSourceSchema = z.looseObject({ match_id: ProviderIdSchema });

// Current provider catalogue only; these flags are not map-level pro/lineup proof.
export const ProPlayersSchema = z.array(z.object({
  account_id: RawIdSchema.pipe(z.string().refine(id => BigInt(id)>0n&&BigInt(id)<=4294967295n)),
  steamid: z.string().regex(/^\d{17}$/).nullish(),
  name: z.string().max(256).nullish(),
  personaname: z.string().max(256).nullish(),
  team_id: NullableIdSchema,
  team_name: z.string().max(256).nullish(),
  team_tag: z.string().max(64).nullish(),
  is_pro: z.boolean().nullish(),
  is_locked: z.boolean().nullish()
})).max(10000).refine(rows => new Set(rows.map(r=>r.account_id)).size===rows.length);
