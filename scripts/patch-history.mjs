import {readFile,stat} from 'node:fs/promises';
import {createDatabase,PatchMetaRepository,resolveHistoryWeights,evaluatePatchWeightPolicies,sql} from '../packages/db/dist/index.js';
const args=process.argv.slice(2),mode=args[0];
if(!['readiness','weights','evaluate'].includes(mode)||args.length!==(mode==='readiness'?1:2)){
  console.error('Использование: patch-history.mjs readiness | weights input.json | evaluate input.json');process.exit(2);
}
if(!process.env.DATABASE_URL){console.error('Не задан DATABASE_URL.');process.exit(2);}
const db=createDatabase(process.env.DATABASE_URL);
try{
  let input;
  if(mode!=='readiness'){
    if((await stat(args[1])).size>5*1024*1024)throw new Error('input_too_large');
    input=JSON.parse(await readFile(args[1],'utf8'));
  }
  const result=await db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
    const registry=await new PatchMetaRepository(trx).snapshot();
    if(mode==='weights')return resolveHistoryWeights(input,registry);
    if(mode==='evaluate')return evaluatePatchWeightPolicies(input,registry);
    const counts=(await sql`SELECT (SELECT count(*)::int FROM matches WHERE is_pro IS TRUE) AS pro_maps,
      (SELECT count(*)::int FROM training_dataset_versions WHERE status='frozen') AS frozen_datasets,
      (SELECT count(*)::int FROM prediction_model_versions WHERE is_active) AS active_models`.execute(trx)).rows[0];
    return {registryRevision:registry.revision,reviewed:{releases:registry.patches.filter(r=>r.reviewState==='accepted').length,
      transitions:registry.transitions.filter(r=>r.reviewState==='accepted').length,heroImpacts:registry.heroImpacts.filter(r=>r.reviewState==='accepted').length,
      availability:registry.heroRules.filter(r=>r.reviewState==='accepted').length},counts,
      empiricalEvaluation:'unavailable',reason:'EXPLICIT_VERIFIED_OFFLINE_COHORT_AND_POLICY_REQUIRED',deployable:false};
  });
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch{
  console.error('Не удалось выполнить offline-проверку. Проверьте миграцию 014, входной контракт, evidence и временные границы.');process.exitCode=1;
}finally{await db.destroy();}
