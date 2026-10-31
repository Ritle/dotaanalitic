import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { PatchReleaseEvidenceSchema, DraftRuleEvidenceSchema, HeroRuleEvidenceSchema, GameContextRequestSchema,
  type PatchReleaseEvidence, type DraftRuleEvidence, type HeroRuleEvidence, type GameContextRequest, type GameRegistry } from '@dota/contracts';
import type { Db, Executor } from './index.js';
import { canonicalContextJson } from './temporal.js';
import { MatchContextRepository } from './context-repository.js';
import { resolveGameContext } from './game-context.js';

const hash = (row: unknown) => createHash('sha256').update(canonicalContextJson(row)).digest('hex');
type CommonRow = { id: string; event_at: Date | null; known_at: Date; fetched_at: Date;
  source: string; evidence_ref: string; review_state: PatchReleaseEvidence['reviewState'] };
const common = (row: CommonRow) => ({ id: row.id, eventAt: row.event_at?.toISOString() ?? null,
  knownAt: row.known_at.toISOString(), fetchedAt: row.fetched_at.toISOString(), source: row.source,
  evidenceRef: row.evidence_ref, reviewState: row.review_state });

/** Internal reviewed-evidence writer. Provider payloads never automatically become accepted evidence. */
export class GameRegistryRepository {
  constructor(private readonly db: Executor) {}
  async appendPatch(input: PatchReleaseEvidence) {
    const r = PatchReleaseEvidenceSchema.parse(input), digest = hash(r);
    await sql`INSERT INTO patch_release_evidence(patch_id,released_at,coverage_until,event_at,known_at,fetched_at,
      source,evidence_ref,review_state,evidence_sha256) VALUES (${r.patchId},${r.releasedAt},${r.coverageUntil},${r.eventAt},
      ${r.knownAt},${r.fetchedAt},${r.source},${r.evidenceRef},${r.reviewState},${digest}) ON CONFLICT DO NOTHING`.execute(this.db);
    return this.id('patch_release_evidence', digest);
  }
  async appendDraftRule(input: DraftRuleEvidence) {
    const r = DraftRuleEvidenceSchema.parse(input), digest = hash(r);
    await sql`INSERT INTO draft_rule_evidence(patch_id,game_mode,lobby_type,rule_version,event_at,known_at,fetched_at,
      source,evidence_ref,review_state,evidence_sha256) VALUES (${r.patchId},${r.gameMode},${r.lobbyType},${r.version},${r.eventAt},
      ${r.knownAt},${r.fetchedAt},${r.source},${r.evidenceRef},${r.reviewState},${digest}) ON CONFLICT DO NOTHING`.execute(this.db);
    return this.id('draft_rule_evidence', digest);
  }
  async appendHeroRule(input: HeroRuleEvidence) {
    const r = HeroRuleEvidenceSchema.parse(input), digest = hash(r);
    await sql`INSERT INTO hero_availability_rules(hero_id,patch_id,league_id,allowed,valid_from,valid_to,event_at,known_at,
      fetched_at,source,evidence_ref,review_state,evidence_sha256) VALUES (${r.heroId},${r.patchId},${r.leagueId},${r.allowed},
      ${r.validFrom},${r.validTo},${r.eventAt},${r.knownAt},${r.fetchedAt},${r.source},${r.evidenceRef},${r.reviewState},${digest})
      ON CONFLICT DO NOTHING`.execute(this.db);
    return this.id('hero_availability_rules', digest);
  }
  private async id(table: 'patch_release_evidence' | 'draft_rule_evidence' | 'hero_availability_rules', digest: string) {
    const { rows } = await sql<{ id: string }>`SELECT id FROM ${sql.table(table)} WHERE evidence_sha256=${digest}`.execute(this.db);
    if (!rows[0]) throw new Error('game_evidence_not_persisted');
    return rows[0].id;
  }
  /** Caller uses a repeatable-read transaction for a consistent cache revision and evidence set. */
  async snapshot(): Promise<GameRegistry> {
    const { rows: state } = await sql<{ revision: string }>`SELECT revision FROM game_context_registry_state WHERE singleton`.execute(this.db);
    const { rows: patches } = await sql<CommonRow & { patch_id: string; released_at: Date; coverage_until: Date }>`
      SELECT * FROM patch_release_evidence ORDER BY id`.execute(this.db);
    const { rows: drafts } = await sql<CommonRow & { patch_id: string; game_mode: number; lobby_type: number; rule_version: string }>`
      SELECT * FROM draft_rule_evidence ORDER BY id`.execute(this.db);
    const { rows: heroes } = await sql<CommonRow & { hero_id: number; patch_id: string | null; league_id: string | null;
      allowed: boolean; valid_from: Date; valid_to: Date | null }>`SELECT * FROM hero_availability_rules
      WHERE evidence_sha256 IS NOT NULL ORDER BY id`.execute(this.db);
    if (!state[0]) throw new Error('game_registry_state_missing');
    return { revision: state[0].revision,
      patches: patches.map(r => ({ ...common(r), patchId: r.patch_id, releasedAt: r.released_at.toISOString(), coverageUntil: r.coverage_until.toISOString() })),
      draftRules: drafts.map(r => ({ ...common(r), patchId: r.patch_id, gameMode: r.game_mode, lobbyType: r.lobby_type, version: r.rule_version })),
      heroRules: heroes.map(r => ({ ...common(r), heroId: r.hero_id, patchId: r.patch_id, leagueId: r.league_id,
        allowed: r.allowed, validFrom: r.valid_from.toISOString(), validTo: r.valid_to?.toISOString() ?? null })) };
  }
}

export class GameContextRepository {
  constructor(private readonly db: Db) {}
  async readAsOf(input: GameContextRequest) {
    const query = GameContextRequestSchema.parse(input);
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx => {
      const base = await new MatchContextRepository(trx).readAsOf({ matchId: query.matchId, cutoffAt: query.cutoffAt, stage: query.stage });
      if (base.context === null) return { status: 'unavailable' as const, reason: base.reason, context: null };
      const { rows } = await sql<{ started_at: Date }>`SELECT started_at FROM matches WHERE id=${query.matchId}`.execute(trx);
      const registry = await new GameRegistryRepository(trx).snapshot();
      return { status: 'resolved' as const, reason: null, context: {
        ...resolveGameContext(base.context, rows[0]!.started_at.toISOString(), query, registry),
        dataRevision: base.context.dataRevision, contextPolicyVersion: base.context.policyVersion,
        fieldEvidence: base.context.fields } };
    });
  }
}
