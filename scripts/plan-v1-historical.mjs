import {registerHistoricalProtocol,verifyHistoricalProtocol,inspectHistoricalDiscovery,readHistoricalInputs,
  readHistoricalCaptures,bounded,save} from './lib/v1-historical-protocol.mjs';
const [mode,config,configSha,...rest]=process.argv.slice(2);
const digest=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
if(!['create','verify','inspect'].includes(mode)||!config||!digest(configSha)||
  (mode==='create'?rest.length!==1:mode==='verify'?rest.length!==2||!digest(rest[1]):rest.length!==5||!digest(rest[1])||!digest(rest[3]))){
  console.error('Использование: create config SHA new-plan | verify config SHA plan SHA | inspect config SHA plan SHA captures SHA new-review');process.exit(2);
}
try{
  const inputs=await readHistoricalInputs(config,configSha);
  const plan=mode==='create'?registerHistoricalProtocol(inputs.request,inputs.catalogue,inputs.exposure,new Date().toISOString()):
    verifyHistoricalProtocol((await bounded(rest[0],4194304,rest[1])).data,inputs.catalogue,inputs.exposure,inputs.request);
  let output=null,summary=null;
  if(mode==='create')output=await save(rest[0],plan);
  if(mode==='inspect'){
    const review=inspectHistoricalDiscovery(plan,inputs.catalogue,inputs.exposure,await readHistoricalCaptures(rest[2],rest[3]),new Date().toISOString());
    output=await save(rest[4],review);summary=review.summary;
  }
  console.log(JSON.stringify({status:mode==='create'?plan.status:mode==='verify'?'historical_protocol_verified':'historical_discovery_reviewed',
    fingerprint:plan.fingerprint,registeredAt:plan.registeredAt,output,summary,modelRegistered:false,executableFreezeRegistered:false,
    evaluationPerformed:false,teamAWinProbability:null,deployable:false}));
}catch(error){
  const code=/^historical_[a-z_]+$/.test(error?.message??'')?error.message.toUpperCase():error?.code==='EEXIST'?'OUTPUT_EXISTS':'HISTORICAL_INPUT_REJECTED';
  console.error(JSON.stringify({status:'unavailable',code,message:'Исторический протокол отклонён. Проверьте источники, пересечения, даты и SHA; существующие файлы сохраняются.',teamAWinProbability:null}));process.exitCode=1;
}
