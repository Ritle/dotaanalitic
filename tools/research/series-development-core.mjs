import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createV1FeatureBuilder} from '../../packages/prediction/dist/v1-features.js';
import {prepareReleaseHistory} from '../../packages/db/dist/v1-release-inventory.js';
import {canonicalContextJson} from '../../packages/db/dist/temporal.js';
const hash=x=>createHash('sha256').update(canonicalContextJson(x)).digest('hex');
const us=t=>(BigInt(Date.parse(t))*1000n).toString();
const cmp=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;

/** No series label is accepted by this boundary. Filter BEFORE the map builder's eligibility checks. */
export function buildSeriesFeatures(history,target){
  const cutoff=BigInt(target.cutoffAtUs),excluded=new Set(target.mapIds);
  assert.equal(excluded.size,target.mapIds.length,'duplicate_target_map');
  assert(excluded.has(target.firstMapId),'first_map_outside_series');
  const first=history.maps.find(m=>m.matchId===target.firstMapId);assert(first,'first_map_missing');
  assert.equal(first.startedAtUs,target.cutoffAtUs,'first_map_cutoff_mismatch');assert.equal(first.seriesKey,target.seriesKey,'first_map_series_mismatch');
  const maps=history.maps.filter(m=>!excluded.has(m.matchId)&&m.seriesKey!==target.seriesKey&&
    BigInt(m.startedAtUs)<cutoff&&BigInt(m.completedAtUs)<cutoff);
  const body={...history,maps};delete body.sourceFingerprint;
  const scoped={...body,sourceFingerprint:hash(body)};
  const scenario={schemaVersion:1,cutoffAtUs:target.cutoffAtUs,targetMatchId:target.firstMapId,
    teamA:target.teamA,teamB:target.teamB,lineup:{basis:'actual_lineup_reconstructed',source:target.lineupSource,
      selectedAtUs:target.selectedAtUs,revision:hash({firstMapId:target.firstMapId,teamA:target.teamA,teamB:target.teamB,identityRevision:history.identityRevision})}};
  const result=createV1FeatureBuilder(scoped)(scenario);
  assert(result.history.usedMatchIds.every(id=>!excluded.has(id)),'target_series_in_history');
  return result;
}

/** Membership/corpus have already passed their pinned archive replay at the CLI boundary. */
export function buildSeriesDevelopmentDataset(inventoryInput,membership,corpus){
  assert.equal(membership.format,'series-membership-audit-v1');assert.equal(corpus.format,'series-corpus-export-v1');
  const prepared=prepareReleaseHistory(inventoryInput),{inventory,history}=prepared;
  const source=new Map(inventory.source.candidates.map(m=>[m.matchId,m]));
  const eligible=new Map(history.maps.map(m=>[m.matchId,m]));
  const assessments=new Map(prepared.assessments.map(m=>[m.matchId,m]));
  const groups=new Map(corpus.plans.flatMap(p=>p.groups).map(g=>[g.providerSeriesId,g]));
  const targets=membership.rows.filter(r=>r.seriesLabelReady).sort((a,b)=>a.verifiedSeriesStartAt.localeCompare(b.verifiedSeriesStartAt)||cmp(a.providerSeriesId,b.providerSeriesId));
  assert.equal(new Set(targets.map(t=>t.providerSeriesId)).size,targets.length,'duplicate_target_series');
  const rows=[],labels=[],diagnostics=[];
  for(const target of targets){
    const g=groups.get(target.providerSeriesId);assert(g,'series_group_missing');
    assert.deepEqual([...target.mapIds].sort(),[...g.mapIds].sort(),'membership_map_binding');
    const sorted=[...g.maps].sort((a,b)=>a.startedAt.localeCompare(b.startedAt)||cmp(a.id,b.id));
    assert.equal(sorted[0]?.startedAt,target.verifiedSeriesStartAt,'series_start_binding');
    // V1 history keys use provider:id; exposure-ledger JSON tuple keys are a different wire format.
    const [teamAId,teamBId]=[g.teamAId,g.teamBId].sort(cmp),seriesKey='opendota:'+target.providerSeriesId;
    const alias=inventory.source.aliases.find(a=>a.seriesId===g.existingSeriesId);
    assert(alias?.provider==='opendota'&&alias.providerSeriesId===target.providerSeriesId,'target_alias_changed');
    // Refuse stale corpus labels after a canonical/source correction. New audit revision required.
    for(const old of sorted){const m=source.get(old.id);assert(m&&m.outcome.status==='verified','canonical_target_missing');
      assert.equal(m.dataRevision,old.dataRevision,'target_revision_changed');assert.equal(m.seriesId,g.existingSeriesId,'target_series_changed');
      assert.equal(m.startedAtUs,us(old.startedAt),'target_start_changed');assert.equal(m.radiantTeamId,old.radiant,'target_radiant_changed');
      assert.equal(m.direTeamId,old.dire,'target_dire_changed');
      assert.equal(m.outcome.sourceEvidence.payloadSha256,old.outcome.sourceEvidence.payloadSha256,'target_receipt_changed');
      assert.equal(m.outcome.teamAWon,old.outcome.teamAWon,'target_outcome_changed');assert.equal(m.endedAtUs,us(old.outcome.completedAt),'target_end_changed');
    }
    const first=source.get(sorted[0].id),lineup=eligible.get(first.matchId),reasons=[];
    if(!lineup)reasons.push('FIRST_MAP_LINEUP_UNAVAILABLE',...(assessments.get(first.matchId)?.reasons??[]));
    let result=null,input=null;
    if(lineup){assert.equal(lineup.seriesKey,seriesKey,'target_alias_changed');
      const aIsRadiant=first.radiantTeamId===teamAId;
      input={seriesKey,mapIds:target.mapIds,firstMapId:first.matchId,cutoffAtUs:us(target.verifiedSeriesStartAt),teamAId,teamBId,
        teamA:aIsRadiant?lineup.teamA:lineup.teamB,teamB:aIsRadiant?lineup.teamB:lineup.teamA,
        lineupSource:'verified-map-receipt:'+lineup.outcomeReceiptId,selectedAtUs:lineup.fetchedAtUs};
      result=buildSeriesFeatures(history,input);reasons.push(...result.reasons);
    }
    rows.push({seriesKey,bestOf:target.bestOf,input,result,status:result?.status??'unavailable',reasons:[...new Set(reasons)].sort()});
    assert([teamAId,teamBId].includes(target.winnerTeamId),'series_winner_binding');
    labels.push({seriesKey,teamAId,teamBId,teamAWon:target.winnerTeamId===teamAId,completedAt:target.completedAt,
      source:target.source,mapIds:target.mapIds,availability:'reconstructed_verified_series_outcome'});
    const firstIds=lineup?[...lineup.teamA,...lineup.teamB].map(p=>p.playerId).sort(cmp):null;
    diagnostics.push({seriesKey,maps:sorted.map(m=>{const row=eligible.get(m.id);return {matchId:m.id,lineupAvailable:!!row,
      sameTenAsFirst:row&&firstIds?canonicalContextJson([...row.teamA,...row.teamB].map(p=>p.playerId).sort(cmp))===canonicalContextJson(firstIds):null};})});
  }
  const byFormat={},reasons={};for(const row of rows){const f=byFormat[row.bestOf]??={series:0,ready:0};f.series++;f.ready+=Number(row.status==='ready');
    for(const reason of row.reasons)reasons[reason]=(reasons[reason]??0)+1;}
  const body={format:'series-development-dataset-v1',purpose:'development_only',syntheticOnly:inventory.source.syntheticOnly,
    sourceFingerprint:inventory.fingerprint,identityRevision:history.identityRevision,warmupFromAt:inventory.source.request.fromAt,
    summary:{series:rows.length,ready:rows.filter(r=>r.status==='ready').length,unavailable:rows.filter(r=>r.status!=='ready').length,
      suppliedMaps:inventory.source.candidates.length,eligibleHistoryMaps:history.maps.length,byFormat,reasons},
    rows,labels,diagnostics,independent:false,evaluation:'not_performed',deployable:false,teamAWinProbability:null};
  return {...body,fingerprint:hash(body)};
}
