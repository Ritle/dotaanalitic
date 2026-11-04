import {expect,it} from 'vitest';
import {V1ScheduledPredictionCreateSchema,V1RuntimeSnapshotSchema} from '@dota/contracts';
import {syntheticScheduledView} from '../../../tests/helpers/scheduled-forecast-view.js';
import {scheduledPredictionView,predictionView} from '../src/v1-prediction-reader.js';
it('rejects HTTP control of model, purpose, source identities, outcome or clock while preserving BIGINT references',()=>{
  const v=syntheticScheduledView(),r={requestId:v.requestId,scenarioId:v.scenario.id,expectedRevision:1,targetSha256:v.target.targetSha256,targetScope:null};
  expect(V1ScheduledPredictionCreateSchema.parse(r)).toEqual(r);
  for(const extra of [{ownerId:v.id},{modelId:v.id},{purpose:'what_if_single_map'},{realTarget:v.target},{teamAWinProbability:0.9},{issuedAt:v.issuedAt}])
    expect(V1ScheduledPredictionCreateSchema.safeParse({...r,...extra}).success).toBe(false);
});
it('projects scheduled immutable snapshots without exposing source payloads or relabelling what-if',()=>{
  const v=syntheticScheduledView(),snapshot=V1RuntimeSnapshotSchema.parse({format:'v1-runtime-snapshot-v1',request:{requestId:v.requestId,scenarioId:v.scenario.id,expectedRevision:1,
    purpose:'real_map',realTarget:v.target,targetScope:null},scenario:v.scenario,createdAt:v.createdAt,issuedAt:null,cutoffAt:v.cutoffAt,status:'unavailable',teamAWinProbability:null,reasons:['NO_ACTIVE_MODEL'],
    gate:{status:'unavailable',modelId:null,privateValue:'do-not-expose'},code:{private:'do-not-expose'},source:null,features:null,targetReview:{private:'do-not-expose'},warnings:[]});
  const saved={id:v.id,sha256:v.snapshotSha256,snapshot},result=scheduledPredictionView(saved);
  expect(result.target.providerMatchId).toBe('9007199254742999');expect(result.purpose).toBe('real_map');expect(JSON.stringify(result)).not.toContain('do-not-expose');
  expect(()=>predictionView(saved)).toThrow();
});
