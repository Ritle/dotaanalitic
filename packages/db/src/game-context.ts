import { GameContextRequestSchema, PatchReleaseEvidenceSchema, DraftRuleEvidenceSchema, HeroRuleEvidenceSchema,
  type ContextFact, type ContextField, type GameContextRequest, type GameRegistry } from '@dota/contracts';
import { sideToScenarioSlot, type resolveContextAsOf } from './temporal.js';

export const GAME_CONTEXT_POLICY = 'evidence-game-context-v1';
type Context = ReturnType<typeof resolveContextAsOf>;
type FactValues = { [F in ContextField]: Extract<ContextFact, { field: F }>['value'] };
type Evidence = { id: string; knownAt: string; eventAt: string | null; reviewState: string };
type Decision<T> = { value: T | null; reason: string | null; evidenceIds: string[] };
function decision<T>(rows: Evidence[], values: T[], missing: string): Decision<T> {
  const evidenceIds = rows.map(row => row.id).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  if (!rows.length) return { value: null, reason: missing, evidenceIds };
  if (rows.some(row => row.reviewState === 'conflict') || new Set(values).size !== 1)
    return { value: null, reason: 'CONFLICT', evidenceIds };
  return { value: values[0]!, reason: null, evidenceIds };
}

/** No network, mutable catalog defaults, completed-map fields or modern drafting assumptions. */
export function resolveGameContext(context: Context, startedAt: string, input: GameContextRequest, registry: GameRegistry) {
  const request = GameContextRequestSchema.parse(input);
  if (!Number.isFinite(Date.parse(startedAt)) || Date.parse(request.cutoffAt) > Date.parse(startedAt) ||
      context.matchId !== request.matchId || context.cutoffAt !== request.cutoffAt || context.stage !== request.stage)
    throw new Error('game_context_snapshot_mismatch');
  const mapTime = new Date(startedAt).toISOString();
  const eligible = (row: Evidence) => row.knownAt <= request.cutoffAt &&
    (row.eventAt === null || row.eventAt <= request.cutoffAt) && ['accepted', 'conflict'].includes(row.reviewState);
  const fact = <F extends ContextField>(field: F) => {
    const item = context.fields.find(item => item.field === field && item.status === 'available');
    return (item?.fact?.value ?? null) as FactValues[F];
  };
  const patch = resolvePatchAt(registry.patches, mapTime, request.cutoffAt);

  const teams = fact('teams');
  const radiantSlot = teams?.radiantTeamId === request.teamAId && teams.direTeamId === request.teamBId ? 'A' :
    teams?.radiantTeamId === request.teamBId && teams.direTeamId === request.teamAId ? 'B' : null;
  const postDraft = request.stage === 'post_draft';
  const firstPickSide = postDraft ? fact('first_pick_side') : null;
  const gameMode = fact('game_mode'), lobbyType = fact('lobby_type'), leagueId = fact('league_id');
  const drafts = registry.draftRules.map(({ id, ...row }) => ({ id, ...DraftRuleEvidenceSchema.parse(row) }))
    .filter(row => postDraft && patch.value !== null && gameMode !== null && lobbyType !== null && eligible(row) &&
      row.patchId === patch.value && row.gameMode === gameMode && row.lobbyType === lobbyType);
  const draftRule = decision(drafts, drafts.map(row => row.version), 'DRAFT_RULE_UNKNOWN');
  const claimedVersion = postDraft ? fact('draft_order_version') : null;
  const draftOrderVersion = claimedVersion !== null && claimedVersion === draftRule.value ? claimedVersion : null;
  const heroRules = registry.heroRules.map(({ id, ...row }) => ({ id, ...HeroRuleEvidenceSchema.parse(row) }));
  const heroes = postDraft ? fact('heroes') : null;
  const heroEligibility = heroes?.map(hero => {
    const applicable = heroRules.filter(row => patch.value !== null && leagueId !== null && eligible(row) &&
      row.heroId === hero.heroId && (row.patchId === null || row.patchId === patch.value) &&
      (row.leagueId === null || row.leagueId === leagueId) && row.validFrom <= mapTime &&
      (row.validTo === null || mapTime < row.validTo));
    return { ...hero, ...decision(applicable, applicable.map(row => row.allowed), 'HERO_ELIGIBILITY_UNKNOWN') };
  }) ?? null;
  const warnings = new Set<string>();
  if (patch.reason) warnings.add(patch.reason === 'CONFLICT' ? 'PATCH_CONFLICT' : patch.reason);
  if (radiantSlot === null) warnings.add('TEAM_ORIENTATION_UNKNOWN');
  if (postDraft) {
    if (firstPickSide === null) warnings.add('FIRST_PICK_UNKNOWN');
    if (draftRule.reason) warnings.add(draftRule.reason === 'CONFLICT' ? 'DRAFT_RULE_CONFLICT' : draftRule.reason);
    if (claimedVersion !== null && draftRule.value !== null && claimedVersion !== draftRule.value) warnings.add('DRAFT_VERSION_MISMATCH');
    if (heroEligibility === null || heroEligibility.length !== 10) warnings.add('FULL_DRAFT_UNKNOWN');
    if (heroEligibility?.some(hero => hero.value === null)) warnings.add('HERO_ELIGIBILITY_UNKNOWN');
    if (heroEligibility?.some(hero => hero.value === false)) warnings.add('HERO_INELIGIBLE');
    warnings.add('DRAFT_TIMELINE_NOT_VALIDATED');
  }
  return { ...request, startedAt: mapTime, policyVersion: GAME_CONTEXT_POLICY, registryRevision: registry.revision,
    patch, leagueId, gameMode, lobbyType, seriesId: fact('series_id'), mapNumber: fact('map_number'),
    // Series score is intentionally unavailable: no between-map prediction in MVP.
    seriesScoreBefore: null, radiantSlot, firstPickSide, firstPickSlot: sideToScenarioSlot(firstPickSide, radiantSlot),
    draftRule, draftOrderVersion, draftOrderValid: null, heroEligibility, warnings: [...warnings].sort() };
}

/** Knowledge time is explicit; retrospective callers must never relabel it as map cutoff. */
export function resolvePatchAt(input: GameRegistry['patches'], mapTime: string, knowledgeAt: string) {
  const patches = input.map(({ id, ...row }) => ({ id, ...PatchReleaseEvidenceSchema.parse(row) }))
    .filter(row => row.knownAt <= knowledgeAt && (row.eventAt === null || row.eventAt <= knowledgeAt) &&
      ['accepted','conflict'].includes(row.reviewState) && row.releasedAt <= mapTime);
  const latest = patches.reduce<string | null>((date, row) => date === null || row.releasedAt > date ? row.releasedAt : date, null);
  const latestRows = patches.filter(row => row.releasedAt === latest);
  const samePatchRows = patches.filter(row => latestRows.some(latestRow => latestRow.patchId === row.patchId));
  let patch = decision(latestRows, latestRows.map(row => row.patchId), 'PATCH_UNKNOWN');
  if (new Set(samePatchRows.map(row => row.releasedAt)).size > 1)
    patch = { ...decision(samePatchRows, samePatchRows.map(row => row.patchId), 'PATCH_UNKNOWN'), value: null, reason: 'CONFLICT' };
  if (patch.value !== null && !latestRows.some(row => row.coverageUntil > mapTime))
    patch = { ...patch, value: null, reason: 'PATCH_COVERAGE_GAP' };
  return patch;
}
