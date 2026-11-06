import {readRetestInputs,registerRetestProtocol,verifyRetestProtocol,bounded,save} from './lib/v1-retest-protocol.mjs';
const [mode,config,configSha,...rest]=process.argv.slice(2),digest=s=>/^[a-f0-9]{64}$/.test(s??'');
if(!['create','verify'].includes(mode)||!config||!digest(configSha)||
  (mode==='create'?rest.length!==1:rest.length!==2||!digest(rest[1]))){
  console.error('Использование: create CONFIG SHA NEW_PLAN | verify CONFIG SHA PLAN SHA');process.exit(2);
}
try{
  const context=await readRetestInputs(config,configSha);
  const plan=mode==='create'?registerRetestProtocol(context,new Date().toISOString()):
    verifyRetestProtocol((await bounded(rest[0],4194304,rest[1])).data,context);
  const output=mode==='create'?await save(rest[0],plan):null;
  console.log(JSON.stringify({status:mode==='create'?plan.status:'retest_protocol_verified',fingerprint:plan.fingerprint,
    registeredAt:plan.registeredAt,output,summary:plan.metadata.summary,denominator:plan.metadata.denominator,
    collectionDeadline:plan.collection.collectionDeadline,previousDecision:plan.previousAttempt.qualityDecision,
    syntheticOnly:plan.syntheticOnly,modelRegistered:false,executableFreezeRegistered:false,
    evaluationPerformed:false,teamAWinProbability:null,deployable:false}));
}catch(e){
  console.error(JSON.stringify({status:'unavailable',code:e?.code==='EEXIST'?'OUTPUT_EXISTS':
    /^retest_[a-z_]+$/.test(e?.message??'')?e.message.toUpperCase():'RETEST_INPUT_REJECTED',
    message:'Регистрация остановлена. Проверьте SHA, прежний результат, выборку и срок сбора. Существующие файлы сохраняются.',
    teamAWinProbability:null,deployable:false}));process.exitCode=1;
}
