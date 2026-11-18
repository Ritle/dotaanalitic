import assert from 'node:assert/strict';
import {digest} from './post-draft-dataset.mjs';

export const IMPORT_TABLES=['teams','series','series_provision_batches','matches','match_players','provider_ingest_receipts',
 'match_source_snapshots','match_draft_source_observations','match_field_observations','match_quality_assessments'].map(t=>'public.'+t);

export function validateApplyScope(proposal,plan){
 assert.equal(proposal.task,'S3-04/history-import-apply');
 assert.equal(proposal.status,'proposal_not_executed');
 for(const k of ['providerHttpAllowed','additionalIdentityOrRosterEnrichmentAllowed','trainingAllowed','activationAllowed'])assert.equal(proposal[k],false,k);
 assert.equal(proposal.historicalKnownAtNotAsserted,true);
 const ids=plan.maps.filter(m=>!m.reasons.length).map(m=>m.matchId);
 assert(ids.length>0);assert.equal(new Set(ids).size,ids.length);assert.deepEqual(proposal.mapIds,ids);
 assert.equal(proposal.expected.mapsAdded,ids.length);assert.equal(proposal.expected.playersAdded,10*ids.length);
 assert.equal(proposal.expected.teamsAdded,plan.counts.newTeams);assert.equal(proposal.expected.seriesCreated,plan.counts.newSeries);
 assert.equal(proposal.expected.verifiedOutcomes,new Set(plan.groups.filter(g=>!g.reasons.length).flatMap(g=>g.knownMapIds)).size);
 return ids;
}

/** Only unrelated manual organization rows may have appeared since the frozen plan.
 * The full recomputed plan must still be byte-equivalent; identity/reference/map
 * drift is refused, rather than treating newer observations as old evidence. */
export function validateCurrentReferences(baseline,current,originalPlan,rebuiltPlan){
 assert.deepEqual(Object.keys(current).sort(),Object.keys(baseline).sort());
 for(const key of Object.keys(baseline).filter(k=>k!=='teams'))assert.deepEqual(current[key],baseline[key],'planning_reference_drift:'+key);
 const original=new Map(baseline.teams.map(t=>[t.id,t]));
 for(const row of baseline.teams)assert.deepEqual(current.teams.find(t=>t.id===row.id),row,'existing_team_changed');
 const added=current.teams.filter(t=>!original.has(t.id));
 assert(added.every(t=>t.opendota_team_id===null),'new_provider_team_requires_replan');
 assert.equal(new Set(current.teams.map(t=>t.id)).size,current.teams.length,'duplicate_team');
 assert.equal(digest(rebuiltPlan),digest(originalPlan),'import_plan_changed');
 return {unrelatedManualTeams:added.map(t=>({id:t.id,name:t.name})),rebuiltPlanUnchanged:true};
}

export function validateTableChanges(before,after){
 assert.deepEqual(Object.keys(before).sort(),Object.keys(after).sort(),'table_inventory_changed');
 const changed=Object.keys(before).filter(t=>digest(before[t])!==digest(after[t]));
 for(const table of changed)assert(IMPORT_TABLES.includes(table),'unexpected_table_change:'+table);
 return changed;
}

export function validateApplyResult(result,proposal,plan){
 validateApplyScope(proposal,plan);assert.equal(result.status,'PASS');
 for(const k of ['providerHttp','trainingRuns','modelActivations'])assert.equal(result[k],0,k);
 for(const k of ['previousMapsUnchanged','unrelatedRowsUnchanged','repeatRowsUnchanged','frozenArtifactsUnchanged','backupVerified'])assert.equal(result[k],true,k);
 assert.deepEqual(result.counts,proposal.expected);
 assert.deepEqual(result.base.map(r=>r.matchId),proposal.mapIds);assert(result.base.every(r=>r.status==='accepted'&&!r.duplicate));
 assert.deepEqual(result.linked.map(r=>r.matchId),proposal.mapIds);assert(result.linked.every(r=>r.status==='accepted'));
 assert.deepEqual(result.repeat.map(r=>r.matchId),proposal.mapIds);assert(result.repeat.every(r=>r.status==='accepted'&&r.duplicate));
 const whole=[...new Set(plan.groups.filter(g=>!g.reasons.length).flatMap(g=>g.knownMapIds))].sort();
 assert.deepEqual(result.outcomes.map(o=>o.matchId).sort(),whole);assert(result.outcomes.every(o=>o.status==='verified'&&o.seriesId!==null));
 assert.equal(result.series.created,proposal.expected.seriesCreated);
 for(const g of plan.groups.filter(g=>!g.reasons.length)){
  const mapping=result.series.mappings.find(s=>s.providerSeriesId===g.sourceSeriesId);assert(mapping);
  assert.deepEqual([...mapping.mapIds].sort(),[...g.knownMapIds].sort());
  assert(result.outcomes.filter(o=>g.knownMapIds.includes(o.matchId)).every(o=>o.seriesId===mapping.seriesId));
 }
 assert.equal(result.lineage.length,proposal.mapIds.length);
 for(const m of plan.maps.filter(m=>!m.reasons.length)){
  const l=result.lineage.find(r=>r.matchId===m.matchId);assert(l);assert.deepEqual(l.originalSource,m.source);
  assert.equal(l.projectionSha256,m.projectionSha256);assert.equal(l.originalResponseBytesRetained,false);assert.equal(l.knownAt,null);
  assert(l.receipts.length>=2);assert(l.receipts.every(r=>r.payload_sha256===m.projectionSha256&&r.known_at===null&&r.adapter_version===m.replay.adapterVersion));
 }
 for(const table of result.changedTables)assert(IMPORT_TABLES.includes(table));
}
