import { sql } from 'kysely';
import { ContextAsOfSchema, IdentityTimeSchema } from '@dota/contracts';
import type { Executor } from './index.js';

export type OutcomeVerificationRequest = { matchId: string; snapshotAt: string; teamASide: 'radiant' | 'dire' };
export type VerifiedMapOutcome = {
  status: 'verified'; matchId: string; outcomeReceiptId: string; teamAId: string; teamBId: string; teamAWon: boolean;
  startedAt: string; completedAt: string; seriesId: string | null; dataRevision: string; labelVerifiedAt: string;
  sourceEvidence: { receiptId: string; payloadSha256: string; adapterVersion: string; normalizerVersion: string; receiptFetchedAt: string };
};
export type OutcomeVerificationResult = VerifiedMapOutcome | { status: 'unavailable'; matchId: string; reasons: string[] };

/** Label verification only. Call inside the builder's repeatable-read transaction;
 * no prediction, lineup, hero, historical feature or training eligibility claim. */
export class OutcomeVerifier {
  constructor(private readonly db: Executor) {}

  async verifyProMap(input: OutcomeVerificationRequest): Promise<OutcomeVerificationResult> {
    const matchId = ContextAsOfSchema.shape.matchId.parse(input.matchId);
    const snapshotAt = IdentityTimeSchema.parse(input.snapshotAt);
    if (input.teamASide !== 'radiant' && input.teamASide !== 'dire') throw new Error('invalid_team_a_side');
    const { rows } = await sql<{ result: OutcomeVerificationResult }>`
      SELECT verify_training_outcome(${matchId}::bigint,${snapshotAt}::timestamptz,${input.teamASide}) AS result`.execute(this.db);
    if (!rows[0]) throw new Error('outcome_verification_result_missing');
    return rows[0].result;
  }
}
