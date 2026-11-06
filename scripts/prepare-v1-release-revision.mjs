import {readReleaseRevision,writeReleaseRevision} from './lib/v1-release-revision.mjs';
const [mode,config,configSha,directory,...extra]=process.argv.slice(2);
if(!['check','prepare'].includes(mode)||!config||! /^[a-f0-9]{64}$/.test(configSha??'')||extra.length||
  (mode==='prepare'?!directory:directory!==undefined)){
  console.error('Использование: check inputs.json SHA256 | prepare inputs.json SHA256 new-directory');process.exit(2);
}
try{
  const result=await readReleaseRevision(config,configSha),files=mode==='prepare'&&result.status==='ready_to_register'?await writeReleaseRevision(result,directory):null;
  console.log(JSON.stringify({status:result.status,revisionKey:result.revisionKey,checkedAt:result.checkedAt,registrationDeadline:result.registrationDeadline,
    events:result.events,qualityPolicySha256:result.qualityPolicySha256,files,registrationPerformed:false,evaluationPerformed:false,
    metrics:null,teamAWinProbability:null,deployable:false}));
  if(result.status==='awaiting_event_binding')process.exitCode=3;
}catch(error){
  const code=/^revision_[a-z_]+$/.test(error?.message??'')?error.message.toUpperCase():error?.code==='EEXIST'?'OUTPUT_EXISTS':'REVISION_INPUT_REJECTED';
  console.error(JSON.stringify({status:'unavailable',code,message:'Новый план не зарегистрирован. Проверьте привязку основного турнира, даты, SHA источников и отдельный выходной каталог.',teamAWinProbability:null}));process.exitCode=1;
}
