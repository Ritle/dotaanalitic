import { AccountEvidenceSchema, ContextFactSchema, IdentityTimeSchema, Steam32Schema, type StoredAccountEvidence } from '@dota/contracts';
import type { resolveContextAsOf } from './temporal.js';

export const IDENTITY_POLICY_VERSION = 'verified-steam32-v1';
export const LINEUP_POLICY_VERSION = 'confirmed-roles-v1';

/** cutoff=null means current descriptive identity, never proof of historical availability. */
export function resolveIdentity(input: readonly StoredAccountEvidence[], accountId: string, cutoffAt: string | null) {
  Steam32Schema.parse(accountId);
  if (cutoffAt !== null) IdentityTimeSchema.parse(cutoffAt);
  const rows = input.map(({ observationId, ...row }) => ({ observationId, ...AccountEvidenceSchema.parse(row) }))
    .filter(row => row.externalAccountId === accountId && row.status !== 'provisional' && row.evidenceRef !== null)
    .filter(row => cutoffAt === null || row.knownAt !== null && row.knownAt <= cutoffAt &&
      (row.eventAt === null || row.eventAt <= cutoffAt));
  const ids = [...new Set(rows.filter(row=>row.status==='verified').map(row => row.playerId))];
  const conflict=ids.length>1 || rows.some(row=>row.status==='rejected' && ids.includes(row.playerId));
  return {
    playerId: !conflict && ids.length === 1 ? ids[0]! : null,
    status: conflict ? 'conflict' as const : ids.length === 1 ? 'verified' as const : 'unknown' as const,
    observationIds: rows.map(row => row.observationId).sort(),
    policyVersion: IDENTITY_POLICY_VERSION,
    availability: cutoffAt === null ? 'current_identity' as const : 'verified_asof' as const
  };
}

type Context = ReturnType<typeof resolveContextAsOf>;
/** Native map slots only. Manual A/B scenario editing remains S2; no current-team fallback. */
export function resolveLineup(context: Context, existingPlayerIds: readonly string[]) {
  const lineup = context.fields.find(field => field.field === 'lineup')?.fact;
  const roles = context.fields.find(field => field.field === 'roles')?.fact;
  if (lineup) ContextFactSchema.parse(lineup);
  if (roles) ContextFactSchema.parse(roles);
  const known = new Set(existingPlayerIds);
  const warnings = new Set<string>();
  const members = lineup?.field === 'lineup' ? lineup.value ?? [] : [];
  const roleRows = roles?.field === 'roles' ? roles.value ?? [] : [];
  const players = Array.from({ length: 10 }, (_, index) => {
    const playerSlot = index < 5 ? index : index + 123;
    const member = members.find(row => row.playerSlot === playerSlot);
    const playerId = member?.playerId != null && known.has(member.playerId) ? member.playerId : null;
    if (playerId === null) warnings.add('UNKNOWN_PLAYER_IDS');
    const role = roleRows.find(row => row.playerSlot === playerSlot);
    const matchesIdentity = playerId !== null && role?.playerId === playerId;
    // No arbitrary confidence threshold: estimates (even 1.0) never become confirmed roles.
    const confirmed = matchesIdentity && role?.basis === 'confirmed' && (role.confidence === null || role.confidence === 1);
    if (role && !matchesIdentity) warnings.add('ROLE_IDENTITY_MISMATCH');
    if (role && !confirmed) warnings.add('ROLE_UNVERIFIED');
    return { playerSlot, side: playerSlot < 128 ? 'radiant' as const : 'dire' as const,
      playerId, rolePos: confirmed ? role!.rolePos : null,
      roleEvidence: role ?? null };
  });
  // A claimed duplicate position invalidates those positions, not the preserved source evidence.
  for (const side of ['radiant', 'dire'] as const) {
    const sidePlayers = players.filter(player => player.side === side);
    const duplicates = new Set(sidePlayers.filter(player => player.rolePos !== null &&
      sidePlayers.filter(other => other.rolePos === player.rolePos).length > 1).map(player => player.rolePos));
    for (const player of sidePlayers) if (duplicates.has(player.rolePos)) {
      player.rolePos = null; warnings.add('ROLE_CONFLICT');
    }
  }
  const sides = (['radiant', 'dire'] as const).map(side => {
    const five = players.filter(player => player.side === side);
    const ids = five.flatMap(player => player.playerId === null ? [] : [player.playerId]);
    const complete = ids.length === 5 && new Set(ids).size === 5;
    return { side, players: five, complete, rolesConfirmed: five.every(player => player.rolePos !== null),
      fingerprint: complete ? [...ids].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0).join(':') : null };
  });
  if (players.some(player=>player.rolePos===null)) warnings.add('UNKNOWN_ROLES');
  return { matchId: context.matchId, cutoffAt: context.cutoffAt, stage: context.stage,
    policyVersion: LINEUP_POLICY_VERSION, cohort: 'verified_asof' as const, sides, warnings: [...warnings].sort(),
    evidence: context.fields.filter(field => field.field === 'lineup' || field.field === 'roles') };
}
