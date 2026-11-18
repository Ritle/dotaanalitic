import {readFile,stat,readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {registrySha} from '@dota/db';
import {DraftCaptureSavedSchema} from './draft-capture-contract.js';
import {DraftHistorySavedSchema,type DraftHistorySaved} from './draft-history-contract.js';
import {buildShadowFeatures} from './draft-shadow-features.js';
import {infer,sigmoid,type Model} from './draft-shadow-inference.js';
import {ShadowResultSchema} from './draft-shadow-contract.js';
export const SHADOW_CANDIDATE_SHA='9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b';
const ModelSchema=z.object({status:z.literal('fitted'),featureOrder:z.array(z.string()),coefficients:z.array(z.number().finite()),intercept:z.literal(0),
  calibration:z.object({status:z.literal('fitted'),temperature:z.number().gt(.250001).lt(3.999999)}).passthrough()}).passthrough();
const ArtifactSchema=z.object({format:z.literal('player-hero-research-fit-v1'),syntheticOnly:z.boolean(),deployable:z.literal(false),
  models:z.object({H1:ModelSchema,H2:ModelSchema}).strict()}).passthrough();
export function parseShadowCandidate(artifactText:string,allowSynthetic=false){
  if(Buffer.byteLength(artifactText)>4*1024*1024)throw Error('shadow_candidate_limit');
  const a=ArtifactSchema.parse(JSON.parse(artifactText)),sha256=registrySha(artifactText);
  if(a.syntheticOnly?!allowSynthetic:sha256!==SHADOW_CANDIDATE_SHA)throw Error('shadow_candidate_sha');
  for(const name of ['H1','H2'] as const)infer(a.models[name],name,{eloLogit:0,observedHeroPracticeLog90Delta:0});
  return {sha256,artifactText,models:a.models,syntheticOnly:a.syntheticOnly};
}
export type ShadowCandidate=ReturnType<typeof parseShadowCandidate>;
export async function loadShadowCandidate():Promise<ShadowCandidate|null>{
  try{
    const path=new URL('../../../../../.tools/s304-hero-fit-r1/artifact.json',import.meta.url);
    if((await stat(path)).size>4*1024*1024)return null;
    return parseShadowCandidate(await readFile(path,'utf8'));
  }catch{return null;} // No synthetic fallback or credentials/paths in logs.
}
export async function shadowImplementationSha(){
  const ext=import.meta.url.endsWith('.ts')?'ts':'js',hashes:Record<string,string>={};
  for(const name of ['draft-shadow-runtime','draft-shadow-features','draft-shadow-hero','draft-shadow-inference','draft-shadow-contract',
    'draft-capture-contract','draft-capture-players','draft-history-contract','draft-target-resolution'])
    hashes[name]=registrySha(await readFile(new URL(`./${name}.${ext}`,import.meta.url),'utf8'));
  const require=createRequire(import.meta.url);
  for(const pkg of ['@dota/prediction','@dota/contracts']){
    const dir=pkg==='@dota/prediction'?fileURLToPath(new URL('../../../../../packages/prediction/dist/',import.meta.url)):dirname(require.resolve(pkg));
    for(const file of (await readdir(dir)).sort())if(file.endsWith('.js'))hashes[`${pkg}/${file}`]=registrySha(await readFile(join(dir,file),'utf8'));
  }
  return registrySha(JSON.stringify(hashes));
}
export function calculateDraftShadow(capture:unknown,history:DraftHistorySaved|null,candidate:ShadowCandidate|null,calculatedAt:string,implementationSha256:string){
  const c=DraftCaptureSavedSchema.parse(capture),o=history===null?null:DraftHistorySavedSchema.parse(history);
  if(o&&(o.evidence.selection.scenarioId!==c.snapshot.scenarioId||o.evidence.selection.revision!==c.snapshot.revision||
    o.evidence.selection.scenarioHash!==c.snapshot.scenarioHash||o.recordedAt>=c.snapshot.decisionCutoffAt||o.evidence.readAt<c.snapshot.scenarioRecordedAt))
    throw Error('shadow_observation_selection');
  if(calculatedAt<c.recordedAt)throw Error('shadow_calculation_clock');
  const features=buildShadowFeatures(c,o,candidate?.syntheticOnly??false),reasons=[...features.reasons];
  if(!candidate)reasons.push('SHADOW_CANDIDATE_UNAVAILABLE');
  let researchScores=null;
  if(features.inputs&&candidate){
    const inputs=features.inputs;
    researchScores={H0:{rawProbability:sigmoid(inputs.eloLogit),calibratedProbability:sigmoid(inputs.eloLogit)},
      H1:infer(candidate.models.H1 as Model,'H1',inputs),H2:infer(candidate.models.H2 as Model,'H2',inputs)};
  }
  return ShadowResultSchema.parse({format:'owner-draft-shadow-result-v1',capture:{id:c.id,sha256:c.sha256},
    observation:o?{id:o.id,sha256:o.sha256}:null,featurePolicy:'selected-ten-and-known-series-exclusion-v1',implementationSha256,calculatedAt,
    candidate:candidate?{sha256:candidate.sha256,artifactText:candidate.artifactText}:null,features,
    status:researchScores?'computed_shadow_only':'unavailable',researchScores,reasons:[...new Set(reasons)].sort(),
    syntheticOnly:candidate?.syntheticOnly??false,primaryEligible:false,deployable:false,trainingPerformed:false,
    forecastStatus:'unavailable',teamAWinProbability:null});
}
