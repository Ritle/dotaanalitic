import {prepareHistoricalCapsule,verifyHistoricalCapsule,registerHistoricalFreeze} from './lib/v1-historical-execution.mjs';
import {saveHistoricalBundle,loadHistoricalBundle,evaluateHistoricalBundle,replayHistoricalBundle} from './lib/v1-historical-bundle.mjs';
import {releaseExecutionCode,releaseRuntime} from './lib/v1-release-files.mjs';
import {sha} from './lib/v1-historical-protocol.mjs';
const [mode,input,digest,fourth,...extra]=process.argv.slice(2),isSha=s=>/^[a-f0-9]{64}$/.test(s??'');
if(extra.length||!input||!isSha(digest)||!fourth||!['freeze','verify','evaluate','replay'].includes(mode)||mode!=='freeze'&&!isSha(fourth)){
  console.error('Использование: freeze CONFIG SHA NEW_BUNDLE | verify/evaluate/replay BUNDLE FREEZE_SHA INPUT_SHA');process.exit(2);
}
try{
  if(mode==='freeze'){
    const capsule=await prepareHistoricalCapsule(input,digest),bytes=JSON.stringify(capsule,null,2)+'\n';
    const context=verifyHistoricalCapsule(capsule),code=await releaseExecutionCode();
    const freeze=registerHistoricalFreeze(context,sha(bytes),code,await releaseRuntime(),new Date().toISOString());
    const manifest=await saveHistoricalBundle(fourth,capsule,bytes,freeze,code);
    console.log(JSON.stringify({status:'historical_executable_frozen',...manifest,coverage:context.coverage.summary}));
  }else{
    const bundle=await loadHistoricalBundle(input,digest,fourth);
    const result=mode==='evaluate'?await evaluateHistoricalBundle(bundle):mode==='replay'?await replayHistoricalBundle(bundle):
      {status:'historical_executable_verified',freezeFingerprint:bundle.freeze.fingerprint,codeFiles:bundle.freeze.code.length,
        coverage:bundle.context.coverage.summary,evaluationPerformed:false,deployable:false};
    console.log(JSON.stringify(result));
  }
}catch(e){
  console.error(JSON.stringify({status:'unavailable',code:e?.code==='EEXIST'?'OUTPUT_EXISTS':
    /^historical_execution_[a-z_]+$/.test(e?.message??'')?e.message.toUpperCase():'HISTORICAL_EXECUTION_REJECTED',
    message:'Проверка остановлена. Сверьте SHA, время, код и локальные зависимости пакета. Существующую регистрацию или первую оценку не перезаписывать.',
    deployable:false,teamAWinProbability:null}));process.exitCode=1;
}
