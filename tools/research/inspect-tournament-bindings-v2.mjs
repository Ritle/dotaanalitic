/** Read-only local evidence inspection. No network, DB, registration or overwrite. */
import assert from 'node:assert/strict';
import {readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {resolve,relative,dirname,basename,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {bindingV2Sha,inspectTournamentBindingsV2,parseBindingEvidenceJson} from './conditional-tournament-binding-v2.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
async function insidePrivate(path){const base=await realpath(join(root,'.tools')),full=await realpath(path),r=relative(base,full);
 assert(r&&!r.startsWith('..')&&!r.includes(':'),'private_path_required');return full;}
export async function inspectBindingReviewFile(inputPath,expectedSha,outputPath,checkedAt=new Date().toISOString()){
 assert(/^[a-f0-9]{64}$/.test(expectedSha),'expected_sha_required');const input=await insidePrivate(resolve(root,inputPath)),size=await stat(input);
 assert(size.isFile()&&size.size<=33554432,'input_file_limit');const bytes=await readFile(input);assert(bytes.length<=33554432,'input_file_limit');
 assert.equal(bindingV2Sha(bytes),expectedSha,'input_sha');
 const policyText=await readFile(join(root,'tools/research/player-hero-conditional-future-policy.json'),'utf8');
 const report=inspectTournamentBindingsV2(parseBindingEvidenceJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),policyText,checkedAt);
 const output=resolve(root,outputPath),parent=await insidePrivate(dirname(output));
 assert(basename(output).endsWith('.json'),'json_output_required');
 const result={format:'conditional-tournament-binding-file-report-v2',inputSha256:expectedSha,report};
 const text=JSON.stringify(result,null,2)+'\n';await writeFile(join(parent,basename(output)),text,{flag:'wx'});
 return {status:report.status,bindingsReady:report.bindingsReady,reportSha256:bindingV2Sha(text),registrationPerformed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const [mode,path,sha,output]=process.argv.slice(2);assert(mode==='inspect'&&path&&sha&&output&&process.argv.length===6,'usage');
  console.log(JSON.stringify(await inspectBindingReviewFile(path,sha,output)));
 }catch{console.error(JSON.stringify({status:'unavailable',reason:'invalid_binding_evidence_or_output',message:'Не удалось проверить свидетельства турниров или сохранить новый отчёт.',registrationPerformed:false}));process.exitCode=1;}
}
