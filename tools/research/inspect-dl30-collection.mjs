// Local operator preview. The December registrar stores a plan, without a collection journal.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createDatabase, sql} from '../../packages/db/dist/index.js';
import {realSha} from './conditional-real-registration.mjs';

export async function inspectDl30Collection(db) {
  const bytes = await readFile(new URL('./player-hero-dl30-window-proposal.json', import.meta.url));
  const digest = realSha(bytes);
  assert.equal(digest, '9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045', 'dl30_proposal_changed');
  const {scope} = JSON.parse(bytes);
  // One statement gives the registration and receipt the same PostgreSQL snapshot.
  const {rows} = await sql`SELECT conditional_real_registration_clock() AS observed_at,
      r.id, r.registered_at, r.package_sha256, r.league_id
    FROM app_users u LEFT JOIN LATERAL (
      SELECT p.id, receipt.observed_at AS registered_at, receipt.package_sha256,
        CASE WHEN receipt.registration_id IS NOT NULL THEN
          p.package_text::jsonb #>> '{review,bindings,0,leagueId}' END AS league_id
      FROM dl30_registrations p
      LEFT JOIN dl30_registration_receipts receipt ON receipt.registration_id=p.id AND receipt.package_sha256=p.package_sha256
      WHERE p.owner_user_id=u.id AND p.proposal_sha256=${digest}
      ORDER BY (receipt.registration_id IS NOT NULL) DESC, p.recorded_at DESC, p.id LIMIT 1
    ) r ON true
    WHERE u.account_role='owner' AND u.is_active`.execute(db);
  assert.equal(rows.length, 1, 'one_active_local_owner_required');
  const row = rows[0];
  const observedAt = row.observed_at.toISOString();
  let phase;
  if (!row.registered_at) {
    if (observedAt >= scope.decisionDeadline) phase = 'registration_expired';
    else phase = row.id ? 'awaiting_receipt' : 'awaiting_registration';
  } else if (observedAt < scope.fromInclusive) phase = 'before_window';
  else if (observedAt < scope.untilExclusive) phase = 'target_window';
  else if (observedAt < scope.assessmentAt) phase = 'outcome_grace';
  else phase = 'assessment_date_reached';
  return {
    observedAt, phase, deadline: scope.decisionDeadline,
    registeredAt: row.registered_at?.toISOString() ?? null,
    registrationSha256: row.package_sha256, leagueId: row.league_id,
    firstLeagueEndpoint: phase === 'target_window' ? '/leagues/' + row.league_id + '/matches' : null,
    collectionAllowed: false, evaluationAllowed: false, activationAllowed: false
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 2, 'usage: inspect-dl30-collection.mjs');
  const db = createDatabase(process.env.DATABASE_URL);
  try {
    console.log(JSON.stringify(await inspectDl30Collection(db), null, 2));
  } finally {
    await db.destroy();
  }
}
