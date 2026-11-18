import {writeFile} from 'node:fs/promises';
import {verifiedProtocol,datasetCode,boundedJson,buildPostDraftDataset,digest} from './post-draft-dataset.mjs';
const [mode,inventory,metadata,protocolPath,capturePath,output,...extra]=process.argv.slice(2);
try{
 if(!['create','verify'].includes(mode)||!output||extra.length)throw Error('arguments');
 const [{protocol,sha256:protocolSha256},capture,code]=await Promise.all([verifiedProtocol(inventory,metadata,protocolPath),boundedJson(capturePath),datasetCode()]);
 if(capture.value.source.syntheticOnly)throw Error('synthetic_cli_forbidden');
 if(digest(capture.value.source.code)!==digest(code))throw Error('capture_code_changed');
 const body={...buildPostDraftDataset(protocol,capture.value),inputs:{protocolSha256,captureSha256:capture.sha256},code};
 const artifact={...body,fingerprint:digest(body)};
 if(mode==='create'){
  const bytes=JSON.stringify(artifact)+'\n';if(Buffer.byteLength(bytes)>128*1024*1024)throw Error('file_limit');
  await writeFile(output,bytes,{flag:'wx'});
 }else if(digest((await boundedJson(output)).value)!==digest(artifact))throw Error('dataset_replay_mismatch');
 console.log(JSON.stringify({status:mode==='create'?'frozen_research_only':'verified_research_only',fingerprint:artifact.fingerprint,
  partitions:artifact.partitions,dataChecks:artifact.dataChecks,historyMaps:artifact.history.eligibleMaps,heroes:artifact.heroVocabulary.length,deployable:false}));
}catch(e){console.error(e?.code==='EEXIST'?'Выборка уже существует. Для изменений нужна новая версия.':'Выборка не прошла проверку. Проверьте SHA протокола, снимка, кода и ревизии данных.');process.exitCode=1;}
