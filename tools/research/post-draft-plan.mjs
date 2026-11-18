import {createHash} from 'node:crypto';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalId} from '../../scripts/lib/match-quality.mjs';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const time=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const order=(a,b)=>BigInt(a.matchId)<BigInt(b.matchId)?-1:BigInt(a.matchId)>BigInt(b.matchId)?1:0;

/** No outcome values, fitting or activation. All known siblings participate in split checks. */
export function buildPostDraftPlan(inventory,metadata,policy){
 if(inventory.policyVersion!=='post-draft-readiness-inventory-v1'||inventory.trainingReady!==false||inventory.deployable!==false)throw Error('inventory_contract');
 const {computedAt,fingerprint,...body}=inventory;if(hash(body)!==fingerprint)throw Error('inventory_fingerprint');
 if(policy.format!=='conditional-final-draft-research-policy-v1'||policy.deployable!==false||policy.release?.activationAllowed!==false)throw Error('research_only');
 const windows=policy.windows;
 if(windows?.length!==5||windows.map(w=>w.name).join(',')!=='warmup,train,validation,calibration,development_test'||windows.some((w,i)=>!time(w.from)||!time(w.until)||w.from>=w.until||(i>0&&windows[i-1].until!==w.from)))throw Error('invalid_windows');
 if(!Array.isArray(metadata)||metadata.length>policy.inputs.maxMaps||metadata.length!==inventory.maps.length)throw Error('inventory_metadata_size');
 const audited=new Map(inventory.maps.map(m=>[m.matchId,m]));if(audited.size!==inventory.maps.length)throw Error('duplicate_inventory_map');
 const seen=new Set(),seriesAliases=new Map(),groups=new Map();
 const rows=metadata.map(m=>{
  const a=audited.get(m.matchId);
  if(canonicalId(m.matchId)!==m.matchId||seen.has(m.matchId)||!a)throw Error('invalid_or_duplicate_map');seen.add(m.matchId);
  if(!time(m.startedAt)||!time(m.completedAt)||m.completedAt<=m.startedAt||m.startedAt!==a.startedAt||m.dataRevision!==a.dataRevision)throw Error('stale_or_invalid_metadata');
  const key=m.seriesId&&m.seriesProvider==='opendota'&&canonicalId(m.sourceSeriesId)!==null&&canonicalId(m.sourceSeriesId)===m.sourceSeriesId?JSON.stringify(['opendota',m.sourceSeriesId]):null;
  if(m.seriesId&&key){const old=seriesAliases.get(m.seriesId);if(old&&old!==key)throw Error('series_alias_conflict');seriesAliases.set(m.seriesId,key);}
  const w=windows.find(w=>m.startedAt>=w.from&&m.startedAt<w.until);
  const reasons=[];
  if(!a.researchInventoryCandidate)reasons.push('INVENTORY_INELIGIBLE');
  if(!key)reasons.push('SERIES_UNVERIFIED');
  if(m.gameMode!==policy.inputs.gameMode||m.lobbyType!==policy.inputs.lobbyType)reasons.push('MODE_OR_LOBBY_OUTSIDE_SCOPE');
  if(!w)reasons.push('OUTSIDE_WINDOWS');
  else if(m.completedAt>=w.until)reasons.push('COMPLETION_CROSSES_BOUNDARY');
  const row={matchId:m.matchId,seriesKey:key,startedAt:m.startedAt,completedAt:m.completedAt,dataRevision:m.dataRevision,
   inventoryLineupSha256:a.lineupSha256,sourceSha256:a.sourceSha256,nominalWindow:w?.name??null,partition:null,reasons};
  if(key){if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}return row;
 });
 for(const members of groups.values()){
  const crossing=new Set(members.map(m=>m.nominalWindow)).size>1||members.some(m=>m.reasons.includes('COMPLETION_CROSSES_BOUNDARY'));
  const anyBad=members.some(m=>m.reasons.length);
  for(const m of members){if(crossing)m.reasons.push('SERIES_CROSSES_BOUNDARY');if(anyBad)m.reasons.push('SERIES_HAS_EXCLUDED_MAP');
   m.reasons=[...new Set(m.reasons)].sort();if(!m.reasons.length)m.partition=m.nominalWindow;}
 }
 rows.sort(order);
 const partitions=Object.fromEntries(windows.map(w=>{const kept=rows.filter(r=>r.partition===w.name);return [w.name,{from:w.from,until:w.until,maps:kept.length,series:new Set(kept.map(r=>r.seriesKey)).size,mapIds:kept.map(r=>r.matchId),plannedDenominator:rows.filter(r=>r.nominalWindow===w.name).length}];}));
 const excluded=rows.filter(r=>r.partition===null),reasons=Object.fromEntries([...new Set(excluded.flatMap(r=>r.reasons))].sort().map(k=>[k,excluded.filter(r=>r.reasons.includes(k)).length]));
 return {format:'conditional-final-draft-protocol-v1',policy,inventoryFingerprint:fingerprint,metadataScope:'all_known_pro_maps_not_only_candidates',
  exposure:'previous_work_not_globally_blind; development_test is retrospective diagnostic only',labelsRead:false,trainingRunCreated:false,
  trainingReady:false,deployable:false,firstMapOnly:false,partitionStatus:'inventory_preview_pending_outcome_history_and_feature_validation',
  partitions,excludedMaps:excluded.length,exclusionReasons:reasons,dispositions:rows};
}
const root=new URL('../../',import.meta.url);
async function load(path,max=16*1024*1024){if((await stat(path)).size>max)throw Error('file_limit');const bytes=await readFile(path);return {value:JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')),sha256:createHash('sha256').update(bytes).digest('hex')};}
async function codeManifest(){return Promise.all(['tools/research/post-draft-plan.mjs','tools/research/post-draft-policy.json','tools/research/read-post-draft-metadata.mjs','scripts/lib/match-quality.mjs'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(new URL(path,root))).digest('hex')})));}
export async function preparePlan(inventoryPath,metadataPath){
 const [inventory,metadata,policy]=await Promise.all([load(inventoryPath),load(metadataPath),load(new URL('post-draft-policy.json',import.meta.url),65536)]);
 return {...buildPostDraftPlan(inventory.value,metadata.value,policy.value),inputs:{inventorySha256:inventory.sha256,metadataSha256:metadata.sha256,policySha256:policy.sha256},code:await codeManifest()};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [mode,inventoryPath,metadataPath,planPath,...rest]=process.argv.slice(2);if(!['create','verify'].includes(mode)||!inventoryPath||!metadataPath||!planPath||rest.length)throw Error('arguments');
  const body=await preparePlan(inventoryPath,metadataPath);
  if(mode==='create'){
   const registeredAt=new Date().toISOString();if(body.policy.windows.at(-1).until>registeredAt)throw Error('future_development_window');
   const registered={registeredAt,...body},plan={...registered,fingerprint:hash(registered)};await writeFile(planPath,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
   console.log(JSON.stringify({status:'registered_research_only',fingerprint:plan.fingerprint,partitions:Object.fromEntries(Object.entries(plan.partitions).map(([k,v])=>[k,{maps:v.maps,series:v.series,denominator:v.plannedDenominator}])),excludedMaps:plan.excludedMaps,deployable:false}));
  }else{
   const {fingerprint,registeredAt,...saved}=(await load(planPath)).value;
   if(!time(registeredAt)||registeredAt>new Date().toISOString()||registeredAt<saved.policy.windows.at(-1).until||hash({registeredAt,...saved})!==fingerprint||hash(saved)!==hash(body))throw Error('protocol_mismatch');
   console.log(JSON.stringify({status:'verified_research_only',fingerprint,deployable:false}));
  }
 }catch(error){console.error(error?.code==='EEXIST'?'Протокол уже существует. Для изменений нужна новая версия.':'Проверка протокола не пройдена: проверьте аргументы, входные SHA, ревизии и код.');process.exitCode=1;}
}
