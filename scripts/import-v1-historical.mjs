import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createDatabase,IdentityProvisioner,readAccountEvidence,resolveIdentity,SeriesProvisionRepository,V1DataRepository} from '../packages/db/dist/index.js';
import {IngestionService} from '../packages/ingestion/dist/importer.js';
import {releaseExecutionCode} from './lib/v1-release-files.mjs';
import {historicalImportInputs,readHistoricalImportPlan,historicalImportProvider,reconcileHistoricalImport,save} from './lib/v1-historical-import.mjs';
const [mode,input,digest,output,...extra]=process.argv.slice(2);
if(!['prepare','verify','identities','maps','series','export'].includes(mode)||!input||!/^[a-f0-9]{64}$/.test(digest??'')||!output||extra.length){
 console.error('Использование: prepare CONFIG SHA NEW_PLAN | verify/identities/maps/series/export PLAN SHA NEW_OUTPUT_DIRECTORY');process.exit(2);
}
let db,writesAttempted=false;
try{
 if(mode==='prepare'){
  const {plan}=await historicalImportInputs(input,digest);const ref=await save(output,plan);
  console.log(JSON.stringify({status:'historical_import_prepared',...ref,maps:plan.maps.length,accounts:plan.accounts.length,
   provenAccounts:plan.identityReviews.length,unresolvedProfiles:plan.unresolvedProfiles.length,series:plan.providerSeriesIds.length,providerRequests:0}));
 }else{
  const inputs=await readHistoricalImportPlan(input,digest),{plan}=inputs;await mkdir(output);
  await save(join(output,'input.json'),{planPath:input,planSha256:digest,planFingerprint:plan.fingerprint,mode,at:new Date().toISOString(),code:await releaseExecutionCode()});
  const results=[];
  if(mode==='verify')results.push({status:'source_plan_verified',maps:plan.maps.length});
  else{
   if(!process.env.DATABASE_URL)throw Error('database_required');db=createDatabase(process.env.DATABASE_URL);
   if(mode==='identities'){
    const provision=new IdentityProvisioner(db);
    for(const accountId of plan.accounts){
     const resolution=resolveIdentity(await readAccountEvidence(db,[accountId]),accountId,null);
     let result;
     if(resolution.status==='verified')result={accountId,status:'already_verified',playerId:resolution.playerId};
     else if(resolution.status==='conflict')result={accountId,status:'blocked',reasons:['IDENTITY_CONFLICT']};
     else{
      const review=plan.identityReviews.find(r=>r.accounts[0].accountId===accountId);
      if(!review)result={accountId,status:'blocked',reasons:['NUMERIC_PROOF_MISSING']};
      else{const preview=await provision.preview(review);await save(join(output,'identity-plan-'+accountId+'.json'),preview);
       if(preview.status==='blocked')result={accountId,status:'blocked',reasons:[...new Set(preview.rows.flatMap(r=>r.reasons))]};
       else{writesAttempted=true;result={accountId,status:'applied',...await provision.apply(review,preview.fingerprint)};}
      }
     }
     await save(join(output,'identity-'+accountId+'.json'),result);results.push(result);
    }
   }else if(mode==='maps'){
    const importer=new IngestionService(db,historicalImportProvider(inputs));
    for(const m of plan.maps){let result;
     if(m.reasons.length)result={matchId:m.matchId,status:'not_importable',reasons:m.reasons};
     else{writesAttempted=true;result=await importer.ingest(m.matchId);}
     await save(join(output,'map-'+m.matchId+'.json'),result);results.push(result);
     if(results.length%50===0)console.log(JSON.stringify({status:'importing',processed:results.length,total:plan.maps.length,providerRequests:0}));
    }
   }else if(mode==='series'){
    const provision=new SeriesProvisionRepository(db);
    for(const providerSeriesId of plan.providerSeriesIds){
     const request={providerSeriesIds:[providerSeriesId],snapshotAt:new Date().toISOString()},preview=await provision.preview(request);
     await save(join(output,'series-plan-'+providerSeriesId+'.json'),preview);
     let result;
     if(preview.status==='blocked')result={providerSeriesId,status:'blocked',reasons:[...new Set(preview.groups.flatMap(g=>g.reasons))]};
     else if(preview.groups.every(g=>g.existingSeriesId!==null))result={providerSeriesId,status:'already_present'};
     else{writesAttempted=true;result={providerSeriesId,...await provision.apply(request,preview.fingerprint)};}
     await save(join(output,'series-'+providerSeriesId+'.json'),result);results.push(result);
     if(results.length%50===0)console.log(JSON.stringify({status:'binding_series',processed:results.length,total:plan.providerSeriesIds.length,providerRequests:0}));
    }
   }else{
    const snapshotAt=new Date().toISOString(),original=inputs.ctx.canonical.source.request;
    const dataset=await new V1DataRepository(db).export({...original,snapshotAt},await releaseExecutionCode());
    const report=reconcileHistoricalImport(plan,dataset);
    await save(join(output,'dataset.json'),dataset);await save(join(output,'coverage.json'),report);
    results.push({status:'canonical_coverage_exported',summary:report.summary});
   }
  }
  const summary={};for(const r of results)summary[r.status]=(summary[r.status]??0)+1;
  const report={schemaVersion:1,mode,planSha256:digest,planFingerprint:plan.fingerprint,completedAt:new Date().toISOString(),summary,
   results,writesAttempted,providerRequests:0,qualityGateCalculated:false,evaluationPerformed:false,teamAWinProbability:null,deployable:false};
  const ref=await save(join(output,'result.json'),report);
  console.log(JSON.stringify({status:'historical_import_step_complete',mode,...ref,summary,
   ...(mode==='export'?{coverage:results[0].summary}:{}),duplicates:results.filter(r=>r.duplicate).length,providerRequests:0,evaluationPerformed:false}));
 }
}catch(e){
 console.error(JSON.stringify({status:'unavailable',code:/^historical_import_[a-z_]+$/.test(e?.message??'')?e.message.toUpperCase():'HISTORICAL_IMPORT_REJECTED',
  writesAttempted,message:'Этап остановлен. Сохранённые результаты не удалены. Повторите тот же план с новым каталогом: записи БД идемпотентны.',teamAWinProbability:null}));process.exitCode=1;
}finally{await db?.destroy();}
