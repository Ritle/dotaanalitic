import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha} from './exposure-ledger-core.mjs';
import {readPcInventories} from './reconcile-dl30-pc-inventories.mjs';
import {replayStage} from './review-dl30-swiss-stage.mjs';

// Inputs come from replayStage and readPcInventories. Keep both sets of blockers
// visible even when one provider hasn't published its stage identifiers yet.
export function reviewSwissReceipt(stage, {report, inventory}) {
  const reasons = [...stage.reasons];
  if (!stage.binding || stage.status !== 'stage_evidence_ready') reasons.push('STAGE_BINDING_REQUIRED');
  if (!report.reviews.local) reasons.push('LOCAL_REVIEW_REQUIRED');
  if (!report.peerDatabaseReportProvided || !report.reviews.peer) reasons.push('PEER_REVIEW_REQUIRED');
  if (report.reviews.local && report.reviews.peer && report.reviews.local.sha256 === report.reviews.peer.sha256)
    reasons.push('DISTINCT_PC_REVIEWS_REQUIRED');
  assert.equal(report.basePackageSha256, stage.packageSha256, 'package_mismatch');
  assert.equal(sha(JSON.stringify(inventory)), report.unionSha256, 'exclusions_changed');
  const evidence = reasons.length ? null : {
    format:'dl30-swiss-receipt-input-v1', proposalSha256:stage.proposalSha256, packageSha256:stage.packageSha256,
    binding:stage.binding, firstSeriesStartLowerBound:stage.firstSeriesStartLowerBound, sources:stage.sources,
    pcReportSha256:sha(JSON.stringify(report,null,2)+'\n'), reviews:report.reviews,
    unionSha256:report.unionSha256, inventory
  };
  return {status:evidence ? 'awaiting_owner_review' : 'unavailable', reasons,
    digest:evidence ? sha(JSON.stringify(evidence)) : null, evidence, registrationPerformed:false};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), shared = args.at(-1)==='--shared';
  if (shared) assert(process.env.RESEARCH_DATABASE_URL,'RESEARCH_DATABASE_URL required');
  const [directory,local,localSha,peer,peerSha,...rest] = shared ? args.slice(0,-1) : args;
  assert(directory && (local || shared) && !rest.length, 'usage: CAPTURE [LOCAL LOCAL_SHA [PEER PEER_SHA]] [--shared]');
  const stage = await replayStage(directory);
  const inventories = await readPcInventories(local,localSha,peer,peerSha);
  const {status,reasons,digest,registrationPerformed} = reviewSwissReceipt(stage,inventories);
  console.log(JSON.stringify({status,reasons,digest,registrationPerformed},null,2));
}
