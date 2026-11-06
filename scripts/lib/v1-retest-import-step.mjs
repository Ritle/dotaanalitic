import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {IdentityProvisioner,readAccountEvidence,resolveIdentity,SeriesProvisionRepository,V1DataRepository} from '../../packages/db/dist/index.js';
import {IngestionService} from '../../packages/ingestion/dist/importer.js';
import {releaseExecutionCode} from './v1-release-files.mjs';
import {hash} from './v1-historical-collection.mjs';
import {retestImportProvider,reconcileRetestImport,save,fail} from './v1-retest-import.mjs';
export async function executeRetestImportStep(inputs,db,mode,output,planRef,{onWrite=()=>{},onProgress=()=>{}}={}){
 const {plan}=inputs,{fingerprint,...body}=plan;
 if(plan.schemaVersion!==2||plan.format!=='v1-retest-import-plan-v2'||plan.syntheticOnly||hash(body)!==fingerprint)fail('plan_binding');
 if(!['verify','identities','maps','series','export'].includes(mode)||mode!=='verify'&&!db)fail('step_configuration');
 if(inputs.maps.length!==plan.maps.length||new Set(inputs.maps.map(m=>m.matchId)).size!==plan.maps.length)fail('map_inventory');
 for(const m of inputs.maps){const expected=plan.maps.find(p=>p.matchId===m.matchId);
  if(!expected||expected.observationFingerprint!==hash(m.observation)||expected.sourceFingerprint!==m.sourceFingerprint||hash(expected.reasons)!==hash(m.reasons))fail('map_binding');}
 await mkdir(output);let writesAttempted=false;
 const writing=()=>{writesAttempted=true;onWrite();};
 await save(join(output,'input.json'),{schemaVersion:2,plan:planRef,planFingerprint:plan.fingerprint,mode,at:new Date().toISOString(),code:await releaseExecutionCode()});
 const results=[],record=async(name,result)=>{await save(join(output,name+'.json'),result);results.push(result);
  if(results.length%50===0)onProgress({mode,processed:results.length,providerRequests:0});};
 if(mode==='verify')results.push({status:'source_plan_verified',maps:plan.maps.length,closureSha256:plan.closureSha256});
 else if(mode==='identities'){
  const provision=new IdentityProvisioner(db);
  for(const accountId of plan.accounts){
   const resolution=resolveIdentity(await readAccountEvidence(db,[accountId]),accountId,null);let result;
   if(resolution.status==='verified')result={accountId,status:'already_verified',playerId:resolution.playerId};
   else if(resolution.status==='conflict')result={accountId,status:'blocked',reasons:['IDENTITY_CONFLICT']};
   else{const review=plan.identityReviews.find(r=>r.accounts[0].accountId===accountId);
    if(!review)result={accountId,status:'blocked',reasons:['NUMERIC_PROOF_MISSING']};
    else{const preview=await provision.preview(review);await save(join(output,'identity-plan-'+accountId+'.json'),preview);
     if(preview.status==='blocked')result={accountId,status:'blocked',reasons:[...new Set(preview.rows.flatMap(r=>r.reasons))]};
     else{writing();result={accountId,status:'applied',...await provision.apply(review,preview.fingerprint)};}
    }
   }
   await record('identity-'+accountId,result);
  }
 }else if(mode==='maps'){
  const importer=new IngestionService(db,retestImportProvider(inputs));
  for(const m of plan.maps){let result;
   if(m.reasons.length)result={matchId:m.matchId,status:'not_importable',reasons:m.reasons};
   else{writing();result=await importer.ingest(m.matchId);}
   await record('map-'+m.matchId,result);
  }
 }else if(mode==='series'){
  const provision=new SeriesProvisionRepository(db);
  for(const providerSeriesId of plan.providerSeriesIds){
   const request={providerSeriesIds:[providerSeriesId],snapshotAt:new Date().toISOString()},preview=await provision.preview(request);let result;
   await save(join(output,'series-plan-'+providerSeriesId+'.json'),preview);
   if(preview.status==='blocked')result={providerSeriesId,status:'blocked',reasons:[...new Set(preview.groups.flatMap(g=>g.reasons))]};
   else if(preview.groups.every(g=>g.existingSeriesId!==null))result={providerSeriesId,status:'already_present'};
   else{writing();result={providerSeriesId,...await provision.apply(request,preview.fingerprint)};}
   await record('series-'+providerSeriesId,result);
  }
 }else{
  const original=inputs.ctx.canonical.source.request;
  const dataset=await new V1DataRepository(db).export({...original,snapshotAt:new Date().toISOString()},await releaseExecutionCode());
  const report=reconcileRetestImport(plan,dataset);
  await save(join(output,'dataset.json'),dataset);await save(join(output,'coverage.json'),report);
  results.push({status:'canonical_coverage_exported',summary:report.summary});
 }
 const summary={};for(const r of results)summary[r.status]=(summary[r.status]??0)+1;
 const report={schemaVersion:2,format:'v1-retest-import-step-v2',mode,plan:planRef,planFingerprint:plan.fingerprint,
  completedAt:new Date().toISOString(),summary,results,writesAttempted,providerRequests:0,
  qualityGateCalculated:false,evaluationPerformed:false,teamAWinProbability:null,deployable:false};
 return {report,output:await save(join(output,'result.json'),report)};
}
