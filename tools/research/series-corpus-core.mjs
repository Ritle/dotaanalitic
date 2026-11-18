/** Local corpus audit only: a terminal observed score is not remote membership proof. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalContextJson} from '../../packages/db/dist/temporal.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
const time=x=>{const n=Date.parse(x);assert(typeof x==='string'&&Number.isFinite(n),'invalid_time');return n;};
const decimal=x=>assert(typeof x==='string'&&/^[1-9]\d*$/.test(x),'invalid_id');
export function auditSeriesCorpus(plans, exposure) {
  assert(Array.isArray(plans)&&Array.isArray(exposure.maps)&&Array.isArray(exposure.canonicalSeriesKeys),'invalid_inventory');
  const exposedMaps=new Set(exposure.maps.map(x=>x.matchId));
  const exposedSeries=new Set(exposure.canonicalSeriesKeys);
  const seenSeries=new Set(), seenMaps=new Set(), rows=[];
  for(const plan of plans){
    const {fingerprint,...body}=plan;
    assert.equal(sha(canonicalContextJson(body)),fingerprint,'plan_fingerprint');
    assert.equal(plan.policyVersion,'reviewed-opendota-series-v3','plan_policy');
    assert.equal(plan.remoteMembershipCompleteness,'unknown','unsupported_membership_claim');
    assert.equal(plan.trainingReady,false);assert.equal(plan.deployable,false);
    const snapshot=time(plan.request.snapshotAt);
    for(const g of plan.groups){
      decimal(g.providerSeriesId);assert(!seenSeries.has(g.providerSeriesId),'duplicate_series');seenSeries.add(g.providerSeriesId);
      const reasons=[...g.reasons];
      if(![1,3,5].includes(g.bestOf))reasons.push('UNSUPPORTED_FORMAT');
      if(!g.maps.length)reasons.push('NO_MAPS');
      assert(Array.isArray(g.mapIds)&&new Set(g.mapIds).size===g.mapIds.length,'duplicate_map');
      for(const id of g.mapIds){decimal(id);assert(!seenMaps.has(id),'map_in_multiple_series');seenMaps.add(id);}
      assert(new Set(g.maps.map(m=>m.id)).size===g.maps.length,'duplicate_canonical_map');
      assert(g.maps.every(m=>g.mapIds.includes(m.id)),'map_outside_group');
      if(g.mapIds.length!==g.maps.length)reasons.push('CANONICAL_MAP_MISSING');
      const maps=[...g.maps].sort((a,b)=>time(a.startedAt)-time(b.startedAt)||a.id.localeCompare(b.id));
      let winsA=0,winsB=0,previousEnd=null;
      const required=[1,3,5].includes(g.bestOf)?(g.bestOf+1)/2:null;
      for(const m of maps){
        const o=m.outcome;
        if(m.isPro!==true||m.ingestState==='conflict'||o?.status!=='verified'){reasons.push('MAP_OUTCOME_UNVERIFIED');continue;}
        assert.equal(o.matchId,m.id,'outcome_map_binding');
        if(o.seriesId!==g.existingSeriesId||m.seriesId!==g.existingSeriesId)reasons.push('SERIES_BINDING_MISMATCH');
        if(o.startedAt!==m.startedAt||o.dataRevision!==m.dataRevision)reasons.push('MAP_REVISION_MISMATCH');
        if(typeof o.teamAWon!=='boolean'||!((o.teamAId===g.teamAId&&o.teamBId===g.teamBId)||(o.teamAId===g.teamBId&&o.teamBId===g.teamAId))){reasons.push('OUTCOME_TEAM_MISMATCH');continue;}
        const start=time(o.startedAt),end=time(o.completedAt);
        if(end<=start||end>snapshot||time(o.labelVerifiedAt)>snapshot)reasons.push('INVALID_OUTCOME_TIME');
        if(previousEnd!==null&&start<=previousEnd)reasons.push('MAPS_OVERLAP');
        previousEnd=end;
        if(required!==null&&(winsA>=required||winsB>=required))reasons.push('MAP_AFTER_DECISIVE_WIN');
        const winner=o.teamAWon?o.teamAId:o.teamBId;
        if(winner===g.teamAId)winsA++;else winsB++;
      }
      if(required!==null&&(Math.max(winsA,winsB)!==required||Math.min(winsA,winsB)>=required||maps.length>g.bestOf))reasons.push('NO_VALID_TERMINAL_SCORE');
      const key=JSON.stringify(['opendota',g.providerSeriesId]);
      const previouslyExposed=exposedSeries.has(key)||g.mapIds.some(id=>exposedMaps.has(id));
      const uniqueReasons=[...new Set(reasons)].sort(),terminalObserved=uniqueReasons.length===0;
      rows.push({providerSeriesId:g.providerSeriesId,leagueId:g.leagueId,bestOf:g.bestOf,mapIds:g.mapIds,
        teamAId:g.teamAId,teamBId:g.teamBId,observedScore:{teamA:winsA,teamB:winsB},terminalObserved,
        observedFirstMapAt:maps[0]?.startedAt??null,verifiedSeriesStartAt:null,
        observedWinnerTeamId:terminalObserved?(winsA>winsB?g.teamAId:g.teamBId):null,
        reasons:uniqueReasons,previouslyExposed,independence:previouslyExposed?'exposed':'not_established',
        exposedByThisAudit:true,
        membershipCompleteness:'unknown',datasetEligible:false,trainingReady:false});
    }
  }
  rows.sort((a,b)=>BigInt(a.providerSeriesId)<BigInt(b.providerSeriesId)?-1:1);
  const byFormat={};const reasons={};
  for(const row of rows){const f=byFormat[row.bestOf??'unknown']??={series:0,maps:0,terminalObserved:0,previouslyExposed:0};
    f.series++;f.maps+=row.mapIds.length;f.terminalObserved+=Number(row.terminalObserved);f.previouslyExposed+=Number(row.previouslyExposed);
    for(const reason of row.reasons)reasons[reason]=(reasons[reason]??0)+1;}
  return {format:'series-local-corpus-audit-v1',purpose:'development_inventory',deployable:false,
    summary:{series:rows.length,maps:seenMaps.size,terminalObserved:rows.filter(r=>r.terminalObserved).length,
      previouslyExposed:rows.filter(r=>r.previouslyExposed).length,independentSeries:0,datasetEligibleSeries:0,byFormat,reasons},rows};
}
