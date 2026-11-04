import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {buildV1DevelopmentFeatures,prepareV1FeatureHistory,canonicalContextJson} from '../../packages/db/dist/index.js';
import {buildV1Features} from '../../packages/prediction/dist/index.js';
const sha=text=>createHash('sha256').update(text).digest('hex');
const fail=code=>{throw Error(code);};

/** Development feature replay only. Never evaluate a holdout or execute reference code. */
export function checkV1HistoricalRegression(dataset,reference,sourceSha256,referenceSha256){
  if(!/^[a-f0-9]{64}$/.test(sourceSha256)||!/^[a-f0-9]{64}$/.test(referenceSha256))fail('INVALID_SHA');
  if(!reference||typeof reference!=='object'||Array.isArray(reference))fail('REFERENCE_INVALID');
  if(reference.sourceFileSha256!==sourceSha256)fail('REFERENCE_SOURCE_MISMATCH');
  const {sourceFileSha256:_,code,...expected}=reference;
  if(!Array.isArray(code)||code.length>10000||code.some(row=>!row||typeof row.path!=='string'||row.path.length>512||
    !/^[a-f0-9]{64}$/.test(row.sha256)))fail('REFERENCE_INVALID');
  const actual=buildV1DevelopmentFeatures(dataset);
  if(!isDeepStrictEqual(actual,expected))fail('FEATURE_REPLAY_MISMATCH');
  const history=prepareV1FeatureHistory(dataset),byId=new Map(history.maps.map(map=>[map.matchId,map]));
  let runtimeParityRows=0,strictHistoryLinks=0;
  for(const row of actual.rows){
    if(!isDeepStrictEqual(row.result,buildV1Features(history,row.result.scenario)))fail('RUNTIME_PARITY_MISMATCH');
    if(row.result.teamAWinProbability!==null||row.result.deployable!==false||row.result.predictionStatus!=='unavailable')fail('PREDICTION_FORBIDDEN');
    runtimeParityRows++;
    const cutoff=BigInt(row.result.scenario.cutoffAtUs);
    for(const id of row.result.history.usedMatchIds){
      const map=byId.get(id);
      if(!map||id===row.matchId||BigInt(map.startedAtUs)>=cutoff||BigInt(map.completedAtUs)>=cutoff)fail('HISTORY_CUTOFF_VIOLATION');
      strictHistoryLinks++;
    }
  }
  return {schemaVersion:1,format:'v1-historical-regression-v1',status:'passed',
    sourceFileSha256:sourceSha256,referenceFileSha256:referenceSha256,sourceFingerprint:actual.sourceFingerprint,
    featureSchemaVersion:actual.featureSchemaVersion,featureContentSha256:sha(canonicalContextJson(actual)),summary:actual.summary,
    matchedRows:actual.rows.length,runtimeParityRows,strictHistoryLinks,syntheticOnly:actual.syntheticOnly,
    scope:'development_feature_regression_only',evaluation:'not_performed',deployable:false,teamAWinProbability:null};
}
