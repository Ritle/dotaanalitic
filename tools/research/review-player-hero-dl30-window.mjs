import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

// Run from the project root. The audit needs IDs and start times only.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function readDocument(path) {
  const bytes = await readFile(path);
  return {path, sha256: hash(bytes), value: JSON.parse(bytes)};
}
async function fileHash(path) {
  const digest = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) digest.update(chunk);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return digest.digest('hex');
}

const proposal = await readDocument('tools/research/player-hero-dl30-window-proposal.json');
const parent = await readDocument(proposal.value.parent.path);
assert.equal(parent.sha256, proposal.value.parent.sha256);
const {candidate, independence, evaluation} = parent.value;
const scope = proposal.value.scope;
const day = 86_400_000;
assert.equal(Date.parse(scope.untilExclusive) - Date.parse(scope.fromInclusive), evaluation.durationDays * day);
assert.equal(Date.parse(scope.assessmentAt) - Date.parse(scope.untilExclusive), evaluation.outcomeGraceDays * day);
assert(Date.parse(scope.decisionDeadline) < Date.parse(scope.fromInclusive));
const development = await readDocument('docs/evidence/s3-04-player-hero-experiment-plan.json');
assert.equal(development.sha256, 'befbca5cc9d1310b8837f1e7a4f047e336ba8a1e386372dff95ce96af4d428df');
const ids = development.value.exposure.mapIds;
const seriesIds = development.value.exposure.canonicalSeriesKeys.map(key => {
  const [provider, id] = JSON.parse(key);
  assert.equal(provider, 'opendota');
  return id;
});
assert.equal(new Set(ids).size, ids.length);
assert.equal(new Set(seriesIds).size, seriesIds.length);
const uri = new URL(process.env.DATABASE_URL);
assert(['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname), 'expected local PostgreSQL');
const db = new pg.Client({connectionString: uri.href});
await db.connect();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const maps = (await db.query(`
    SELECT count(*)::int AS "localMaps", max(started_at) AS "latestLocalStart",
           count(*) FILTER (WHERE id=ANY($1::bigint[]))::int AS "developmentIdsFound",
           max(started_at) FILTER (WHERE id=ANY($1::bigint[])) AS "latestDevelopmentStart",
           count(*) FILTER (WHERE started_at >= $2 AND started_at < $3)::int AS "localStartsInWindow",
           count(*) FILTER (WHERE id=ANY($1::bigint[]) AND started_at >= $2 AND started_at < $3)::int AS "developmentStartsInWindow"
    FROM matches`, [ids, scope.fromInclusive, scope.untilExclusive])).rows[0];
  const series = (await db.query(`
    SELECT count(*)::int AS found FROM series
    WHERE provider='opendota' AND provider_series_id=ANY($1::text[])`, [seriesIds])).rows[0];
  const checkedAt = (await db.query('SELECT transaction_timestamp() AS at')).rows[0].at;
  await db.query('COMMIT');
  const ledgerSha256 = await fileHash(independence.exposure.path);
  console.log(JSON.stringify({
    proposalSha256: proposal.sha256, parentSha256: parent.sha256, checkedAt,
    candidateSha256: await fileHash(candidate.artifactPath), expectedCandidateSha256: candidate.artifactSha256,
    developmentPlanSha256: development.sha256, developmentMapIds: ids.length,
    developmentSeriesIds: seriesIds.length, developmentSeriesIdsFound: series.found, ...maps,
    requiredLedgerPath: independence.exposure.path, requiredLedgerSha256: independence.exposure.sha256,
    observedLedgerSha256: ledgerSha256, fullLedgerHashMatches: ledgerSha256 === independence.exposure.sha256,
    targetMembershipCompared: false, independenceEstablished: false, registrationPerformed: false
  }, null, 2));
} finally {
  await db.end();
}
