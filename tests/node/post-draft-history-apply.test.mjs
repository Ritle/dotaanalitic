import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateApplyScope,validateCurrentReferences,validateTableChanges,validateApplyResult} from '../../tools/research/post-draft-history-apply-policy.mjs';
const fixture=()=>{
 const mapId='9007199254740993',source={provider:'opendota',endpoint:'/matches/'+mapId,payloadSha256:'a'.repeat(64),knownAt:null};
 const plan={maps:[{matchId:mapId,reasons:[],source,projectionSha256:'b'.repeat(64),replay:{adapterVersion:'opendota-projection-replay-v1'}}],groups:[{sourceSeriesId:'99',knownMapIds:[mapId],reasons:[]}],counts:{newTeams:0,newSeries:0}};
 const expected={mapsAdded:1,playersAdded:10,teamsAdded:0,verifiedOutcomes:1,seriesCreated:0};
 const proposal={task:'S3-04/history-import-apply',status:'proposal_not_executed',providerHttpAllowed:false,additionalIdentityOrRosterEnrichmentAllowed:false,trainingAllowed:false,activationAllowed:false,historicalKnownAtNotAsserted:true,mapIds:[mapId],expected};
 const result={status:'PASS',providerHttp:0,trainingRuns:0,modelActivations:0,previousMapsUnchanged:true,unrelatedRowsUnchanged:true,repeatRowsUnchanged:true,frozenArtifactsUnchanged:true,backupVerified:true,counts:expected,
  base:[{matchId:mapId,status:'accepted',duplicate:false}],linked:[{matchId:mapId,status:'accepted'}],repeat:[{matchId:mapId,status:'accepted',duplicate:true}],
  outcomes:[{matchId:mapId,status:'verified',seriesId:'synthetic-series'}],series:{created:0,mappings:[{providerSeriesId:'99',mapIds:[mapId],seriesId:'synthetic-series'}]},
  lineage:[{matchId:mapId,originalSource:structuredClone(source),projectionSha256:'b'.repeat(64),originalResponseBytesRetained:false,knownAt:null,
   receipts:[0,1].map(i=>({id:String(i+1),payload_sha256:'b'.repeat(64),adapter_version:'opendota-projection-replay-v1',known_at:null}))}],changedTables:['public.matches']};
 return {proposal,plan,result};
};
test('working scope is exact and preserves bigint map IDs without network, training or enrichment authorization',()=>{
 const f=fixture();assert.deepEqual(validateApplyScope(f.proposal,f.plan),['9007199254740993']);
 for(const key of ['providerHttpAllowed','additionalIdentityOrRosterEnrichmentAllowed','trainingAllowed','activationAllowed'])assert.throws(()=>validateApplyScope({...f.proposal,[key]:true},f.plan));
 assert.throws(()=>validateApplyScope({...f.proposal,mapIds:['1']},f.plan));assert.throws(()=>validateApplyScope({...f.proposal,mapIds:[]},f.plan));
 assert.throws(()=>validateApplyScope({...f.proposal,expected:{...f.proposal.expected,verifiedOutcomes:2}},f.plan));
});
test('unrelated owner team is tolerated only if original references and rebuilt plan are unchanged',()=>{
 const base={teams:[{id:'1',opendota_team_id:'10',name:'Synthetic'}],players:[],identities:[],maps:[],references:[]},plan={fingerprint:'synthetic'};
 const current={...base,teams:[...base.teams,{id:'2',opendota_team_id:null,name:'Owner local team'}]};
 assert.deepEqual(validateCurrentReferences(base,current,plan,plan).unrelatedManualTeams,[{id:'2',name:'Owner local team'}]);
 for(const key of ['identities','players','maps','references'])assert.throws(()=>validateCurrentReferences(base,{...current,[key]:[{}]},plan,plan));
 assert.throws(()=>validateCurrentReferences(base,{...current,teams:current.teams.slice(1)},plan,plan));
 assert.throws(()=>validateCurrentReferences(base,{...current,teams:[...base.teams,{id:'2',opendota_team_id:'11',name:'Other'}]},plan,plan));
 assert.throws(()=>validateCurrentReferences(base,current,plan,{fingerprint:'changed'}));
});
test('imports cannot change old forecast, live estimate, identity, queue or model tables',()=>{
 for(const table of ['prediction_runs','live_lineup_estimates','player_account_evidence','prediction_model_versions','history_projection_imports']){
  const key='public.'+table,before={[key]:{count:1,hash:'a'}};assert.throws(()=>validateTableChanges(before,{[key]:{count:1,hash:'b'}}));
 }
 assert.throws(()=>validateTableChanges({'pgboss.job':{count:3,hash:'a'}},{'pgboss.job':{count:2,hash:'b'}}));
 assert.deepEqual(validateTableChanges({'public.matches':{count:1,hash:'a'}},{'public.matches':{count:2,hash:'b'}}),['public.matches']);
 assert.throws(()=>validateTableChanges({}, {'public.new':{count:0,hash:'a'}}));
});
test('completion proves exact maps, whole-series outcomes, source lineage and idempotent rows',()=>{
 const f=fixture();validateApplyResult(f.result,f.proposal,f.plan);
 for(const mutate of [r=>r.repeat[0].duplicate=false,r=>r.base[0].duplicate=true,r=>r.outcomes[0].status='unknown',r=>r.outcomes[0].seriesId='wrong',
  r=>r.lineage[0].originalSource.payloadSha256='c'.repeat(64),r=>r.lineage[0].knownAt='2020-01-01T00:00:00Z',r=>r.lineage[0].receipts[0].payload_sha256='c'.repeat(64),
  r=>r.lineage[0].originalResponseBytesRetained=true,r=>r.backupVerified=false,r=>r.counts.mapsAdded=2,r=>r.changedTables.push('public.players')]){
  const result=structuredClone(f.result);mutate(result);assert.throws(()=>validateApplyResult(result,f.proposal,f.plan));
 }
});
