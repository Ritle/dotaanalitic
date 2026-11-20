import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {createDatabase, sql} from '../../packages/db/dist/index.js';
import {ExclusionIdsSchema, realSha} from './conditional-real-registration.mjs';
import {parseBindingEvidenceJson, TournamentBindingReviewV2Schema} from './conditional-tournament-binding-v2.mjs';

const preparedPath = '.tools/s304-dl30-registration-inputs-r1.json';
const preparedSha = 'b0853f7a23dce9d111322a2b8bc436aaa8a00592d8527e4f74215d76144f5ac3';
const proposalSha = '9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045';
const migration = 'packages/db/migrations/072_dl30_registration.sql';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const Review = TournamentBindingReviewV2Schema.extend({
  format: z.literal('dl30-tournament-review-v1'), policySha256: z.literal(proposalSha),
  reviewerUserId: z.string().uuid(), syntheticOnly: z.literal(false),
  bindings: TournamentBindingReviewV2Schema.shape.bindings.length(1)
});
const Package = z.object({
  format: z.literal('dl30-registration-v1'), preparedText: z.string(), floorText: z.string(),
  exclusions: ExclusionIdsSchema, review: Review, registrarSha256: hash, migrationSha256: hash
}).strict();

async function codeHashes() {
  return {registrarSha256: realSha(await readFile(new URL(import.meta.url))), migrationSha256: realSha(await readFile(migration))};
}

export async function buildDl30Package(review, exclusions) {
  const preparedText = await readFile(preparedPath, 'utf8');
  assert.equal(realSha(preparedText), preparedSha, 'prepared_inputs_changed');
  const floor = JSON.parse(preparedText).exclusionFloor;
  const floorText = await readFile(floor.path, 'utf8');
  assert.equal(realSha(floorText), floor.sha256, 'exposure_floor_changed');
  return Package.parse({format: 'dl30-registration-v1', preparedText, floorText, review, exclusions, ...await codeHashes()});
}

async function verifyRuntime(p) {
  const code = await codeHashes();
  assert.equal(p.registrarSha256, code.registrarSha256, 'registrar_changed');
  assert.equal(p.migrationSha256, code.migrationSha256, 'migration_changed');
  const {stdout} = await promisify(execFile)(process.execPath, ['tools/research/prepare-dl30-registration.mjs', 'verify'], {timeout: 60000});
  assert.equal(JSON.parse(stdout).sha256, preparedSha, 'runtime_changed');
}

// Only explicit owner CLI calls enter this store. The SQL guards recheck the live inventory and server clock.
export async function registerDl30(db, ownerId, text, expectedSha) {
  z.string().uuid().parse(ownerId);
  assert(Buffer.byteLength(text) <= 33554432, 'package_limit');
  assert.equal(realSha(text), hash.parse(expectedSha), 'package_hash');
  const p = Package.parse(parseBindingEvidenceJson(text));
  assert.equal(p.review.reviewerUserId, ownerId, 'review_owner_mismatch');
  assert.equal(realSha(p.preparedText), preparedSha, 'prepared_inputs_changed');
  const transact = fn => db.transaction().setIsolationLevel('read committed').execute(async tx => {
    await sql`SET LOCAL synchronous_commit='on'`.execute(tx);
    await sql`SET LOCAL lock_timeout='30s'`.execute(tx);
    const owner = await sql`SELECT id FROM app_users WHERE id=${ownerId}::uuid AND account_role='owner' AND is_active FOR SHARE`.execute(tx);
    assert(owner.rows.length === 1, 'active_owner_required');
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${proposalSha},0))`.execute(tx);
    return fn(tx);
  });
  const id = await transact(async tx => {
    const saved = (await sql`SELECT r.id, r.package_sha256 FROM dl30_registrations r
      LEFT JOIN dl30_registration_receipts c ON c.registration_id=r.id
      WHERE r.proposal_sha256=${proposalSha} AND (c.registration_id IS NOT NULL OR r.package_sha256=${expectedSha})
      ORDER BY (c.registration_id IS NOT NULL) DESC LIMIT 1`.execute(tx)).rows[0];
    if (saved) {
      assert.equal(saved.package_sha256, expectedSha, 'registration_already_bound');
      return saved.id;
    }
    await verifyRuntime(p);
    const inserted = await sql`INSERT INTO dl30_registrations(owner_user_id,package_text,package_sha256)
      VALUES(${ownerId}::uuid,${text},${expectedSha}) RETURNING id`.execute(tx);
    return inserted.rows[0].id;
  });
  const registeredAt = await transact(async tx => {
    const saved = (await sql`SELECT observed_at FROM dl30_registration_receipts WHERE registration_id=${id}::uuid`.execute(tx)).rows[0];
    if (saved) return saved.observed_at;
    await verifyRuntime(p);
    const receipt = await sql`INSERT INTO dl30_registration_receipts(registration_id,package_sha256)
      VALUES(${id}::uuid,${expectedSha}) RETURNING observed_at`.execute(tx);
    return receipt.rows[0].observed_at;
  });
  return {id, packageSha256: expectedSha, registeredAt: registeredAt.toISOString(), status: 'registered_plan_only',
    collectionAllowed: false, evaluationAllowed: false, activationAllowed: false};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, first, second, third, ...extra] = process.argv.slice(2);
  assert(first && second && third && !extra.length, 'usage: package REVIEW EXCLUSIONS NEW_FILE | register OWNER FILE SHA256');
  if (mode === 'package') {
    const p = await buildDl30Package(parseBindingEvidenceJson(await readFile(first, 'utf8')), parseBindingEvidenceJson(await readFile(second, 'utf8')));
    const bytes = JSON.stringify(p);
    await writeFile(third, bytes, {flag: 'wx'});
    console.log(JSON.stringify({packageSha256: realSha(bytes), status: 'prepared_only'}));
  } else {
    assert.equal(mode, 'register');
    const db = createDatabase(process.env.DATABASE_URL);
    try { console.log(JSON.stringify(await registerDl30(db, first, await readFile(second, 'utf8'), third))); }
    finally { await db.destroy(); }
  }
}
