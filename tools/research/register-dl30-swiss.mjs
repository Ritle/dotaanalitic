import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createDatabase,sql} from '../../packages/db/dist/index.js';
import {parseBindingEvidenceJson} from './conditional-tournament-binding-v2.mjs';
import {sha} from './exposure-ledger-core.mjs';
import {readPcInventories} from './reconcile-dl30-pc-inventories.mjs';
import {reviewSwissReceipt} from './review-dl30-swiss-receipt.mjs';
import {replayStage} from './review-dl30-swiss-stage.mjs';
import {fromKeys} from './shared-exposure.mjs';

const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isUuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

export function privateSwissInventory(text, digest) {
  assert(isDigest(digest) && sha(text) === digest, 'private_exposure_changed');
  const payload = parseBindingEvidenceJson(text);
  assert.deepEqual(Object.keys(payload).sort(), ['format','mapIds','seriesKeys'], 'unexpected_private_exposure_fields');
  assert.equal(payload.format, 'dl30-private-exposure-v1', 'invalid_private_exposure_format');
  const inventory = fromKeys(payload.mapIds, payload.seriesKeys);
  assert.equal(inventory.mapIds.length, payload.mapIds.length, 'duplicate_private_map');
  assert.equal(inventory.openDotaSeriesIds.length + inventory.pandaScoreMeetingIds.length, payload.seriesKeys.length,
    'duplicate_private_series');
  return inventory;
}

export async function prepareSwissOwnerReview([capture,local,localSha,peer,peerSha,privatePath,privateSha], now) {
  assert(isDigest(localSha) && isDigest(peerSha) && isDigest(privateSha), 'expected_evidence_sha256');
  assert(process.env.RESEARCH_DATABASE_URL, 'RESEARCH_DATABASE_URL required');
  const privateInventory = privateSwissInventory(await readFile(privatePath,'utf8'),privateSha);
  const stage = await replayStage(capture, now);
  const inventories = await readPcInventories(local,localSha,peer,peerSha,
    {connectionString:process.env.RESEARCH_DATABASE_URL,publish:false,privateInventory});
  const review = reviewSwissReceipt(stage,inventories);
  if (!review.evidence) return review;
  assert(inventories.report.sharedRegistry.revisions.length > 0, 'shared_registry_empty');
  const evidence = {...review.evidence,privateExposureSha256:privateSha,
    registryRevisions:inventories.report.sharedRegistry.revisions};
  return {...review,evidence,digest:sha(JSON.stringify(evidence)),totals:inventories.report.total};
}

function describe(row) {
  if (!row) return {status:'not_registered',registrationPerformed:false};
  return {status:'registered',registrationPerformed:true,receiptSha256:row.digest,
    observedAt:row.observed_at.toISOString(),collectionAllowed:false,activationAllowed:false};
}

export async function swissReceiptStatus(db) {
  const {rows:[row]} = await sql`SELECT digest, observed_at FROM dl30_swiss_receipts WHERE singleton`.execute(db);
  return describe(row);
}

export async function registerSwissOwnerReview(db, ownerId, reviewedDigest, prepare) {
  assert(isUuid(ownerId) && isDigest(reviewedDigest), 'expected_owner_uuid_and_review_sha256');
  const {rows:[previous]} = await sql`SELECT r.digest, r.observed_at, p.owner_id
    FROM dl30_swiss_receipts r JOIN dl30_swiss_plans p USING (digest) WHERE r.singleton`.execute(db);
  if (previous) {
    assert(previous.digest === reviewedDigest && previous.owner_id === ownerId.toLowerCase(), 'receipt_already_observed');
    return describe(previous);
  }
  const {rows:[clock]} = await sql`SELECT conditional_real_registration_clock() AS at`.execute(db);
  const evidence = await prepare(clock.at.toISOString());
  if (!evidence.evidence) return evidence;
  assert.equal(evidence.digest,reviewedDigest,'owner_review_digest_changed');
  const text = JSON.stringify(evidence.evidence);
  assert.equal(sha(text),reviewedDigest,'invalid_review_digest');
  const transaction = action => db.transaction().setIsolationLevel('read committed').execute(async tx => {
    await sql`SET LOCAL synchronous_commit = 'on'`.execute(tx);
    await sql`SET LOCAL lock_timeout = '30s'`.execute(tx);
    return action(tx);
  });
  await transaction(tx => sql`SELECT write_dl30_swiss_plan(${ownerId}::uuid,${reviewedDigest},${text})`.execute(tx));
  // A retry can refresh a pending plan if research inputs changed between commits.
  const {rows:[after]} = await sql`SELECT conditional_real_registration_clock() AS at`.execute(db);
  const current = await prepare(after.at.toISOString());
  assert.equal(current.digest,reviewedDigest,'review_changed_before_receipt');
  const result = await transaction(tx => sql`SELECT * FROM observe_dl30_swiss_registration(${reviewedDigest})`.execute(tx));
  return describe(result.rows[0]);
}

function summary(review) {
  const {evidence,...result} = review;
  if (!evidence) return result;
  return {...result,binding:evidence.binding,sources:evidence.sources,pcReportSha256:evidence.pcReportSha256,
    privateExposureSha256:evidence.privateExposureSha256,registryRevisions:evidence.registryRevisions,unionSha256:evidence.unionSha256};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [action,...args] = process.argv.slice(2);
  assert((action === 'status' && !args.length) || (action === 'review' && args.length === 7) ||
    (action === 'register' && args.length === 9),
  'usage: status | review CAPTURE LOCAL LOCAL_SHA PEER PEER_SHA PRIVATE PRIVATE_SHA | register OWNER_UUID REVIEW_SHA CAPTURE LOCAL LOCAL_SHA PEER PEER_SHA PRIVATE PRIVATE_SHA');
  if (action === 'review') {
    console.log(JSON.stringify(summary(await prepareSwissOwnerReview(args)),null,2));
  } else {
    assert(process.env.DATABASE_URL,'DATABASE_URL required');
    const db = createDatabase(process.env.DATABASE_URL);
    try {
      const result = action === 'status' ? await swissReceiptStatus(db) :
        await registerSwissOwnerReview(db,args[0],args[1],now => prepareSwissOwnerReview(args.slice(2),now));
      console.log(JSON.stringify(summary(result),null,2));
    } finally { await db.destroy(); }
  }
}
