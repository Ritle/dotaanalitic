/** Metadata + source-wrapper audit in declared research roots. No credentials or external calls. */
import assert from 'node:assert/strict';
import {readdir,readFile,writeFile,stat,realpath} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha,extractExposure} from './exposure-ledger-core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const excluded=/node_modules|corepack|runtime|tamper|rehearsal|browser|backup|test-results|private-owner|pgsql|\.git|\.venv|isolated|exposure|oracle|synthetic|demo/i;
export async function discoverReceipts(){
 const files=[],excludedPaths=[];
 async function walk(dir){
  for(const e of (await readdir(resolve(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const path=join(dir,e.name).replaceAll('\\','/');
   if(excluded.test(e.name)||e.isSymbolicLink()){excludedPaths.push(path);continue;}
   if(e.isDirectory())await walk(path);else if(e.isFile()&&e.name.endsWith('.json'))files.push(path);
   assert(files.length<=20000,'discovery_file_limit');
  }
 }
 for(const e of (await readdir(resolve(root,'.tools'),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(!/^(s30|s3-|v1|evaluation|research|elo)/.test(e.name))continue;
  const p='.tools/'+e.name;
  if(excluded.test(e.name)||e.isSymbolicLink()){excludedPaths.push(p);continue;}
  if(e.isDirectory())await walk(p);else if(e.isFile()&&e.name.endsWith('.json'))files.push(p);
 }
 let totalBytes=0;const entries=[],sources=[];
 for(const path of files.sort()){
  const size=(await stat(resolve(root,path))).size;totalBytes+=size;assert(totalBytes<=3*1024**3,'discovery_byte_limit');
  if(size>128*1024**2){entries.push({path,size,status:'unreviewed_size_limit'});continue;}
  const bytes=await readFile(resolve(root,path)),entry={path,size,sha256:sha(bytes)};
  let x;try{x=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{entries.push({...entry,status:'unreviewed_parse'});continue;}
  if(x?.syntheticOnly===true||x?.source?.syntheticOnly===true){entries.push({...entry,status:'excluded_synthetic'});continue;}
  const o=x?.observation??x;
  if(o?.source?.provider==='opendota'&&typeof o?.rawBody==='string'){
   try{
    const data=extractExposure('opendota-receipt',x);
    sources.push({path,sha256:entry.sha256,adapter:'opendota-receipt'});
    entries.push({...entry,status:'included_native_receipt',maps:data.rows.length});
   }catch{
    entries.push({...entry,status:'unreviewed_native_receipt'});
   }
  }else entries.push({...entry,status:'not_supported_source_wrapper'});
 }
 return {format:'exposure-source-discovery-v1',capturedAt:new Date().toISOString(),
  scope:'JSON in .tools research families s30/s3-/v1/evaluation/research/elo; excludes runtime,QA,private/dependency trees',
  codeSha256:sha(await readFile(fileURLToPath(import.meta.url))),entries,excludedPaths,sources,
  summary:{files:files.length,bytes:totalBytes,receipts:sources.length,
   unreviewedNativeReceipts:entries.filter(e=>e.status==='unreviewed_native_receipt').length},
  completeGlobalInventory:false,registrationAllowed:false};
}
async function main(){
 const [path,...extra]=process.argv.slice(2);assert(path&&!extra.length,'arguments');
 const full=resolve(root,path),rel=relative(resolve(root,'.tools'),full);
 assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&rel.endsWith('.json'),'local_output_required');
 const parent=await realpath(dirname(full));assert(!relative(resolve(root,'.tools'),parent).startsWith('..'),'outside_output');
 const result=await discoverReceipts(),bytes=JSON.stringify(result,null,2)+'\n';
 await writeFile(full,bytes,{flag:'wx'});console.log(JSON.stringify({sha256:sha(bytes),...result.summary}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
 console.error('Обзор источников отклонён: проверьте лимиты и новый путь .tools.');process.exitCode=1;
});
