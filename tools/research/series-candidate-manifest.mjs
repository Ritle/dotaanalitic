import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {link,readFile,readdir,realpath,unlink,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {candidateSha} from '../../scripts/lib/v1-candidate-files.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const workspaceFile=path=>join(root,path);
const fromContracts=createRequire(workspaceFile('packages/contracts/package.json'));
const fromPrediction=createRequire(workspaceFile('packages/prediction/package.json'));
const fixedFiles=[
  'package.json','pnpm-lock.yaml','pnpm-workspace.yaml',
  'packages/contracts/package.json','packages/prediction/package.json',
  'scripts/lib/v1-candidate-files.mjs',
  'tools/research/series-candidate-manifest.mjs','tools/research/series-forecast-rehearsal.mjs'
];

async function executableFiles(directory,prefix) {
  const files=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name);
    const label=prefix+'/'+entry.name;
    assert(!entry.isSymbolicLink(),'unexpected symbolic link in candidate dependencies: '+label);
    if(entry.isDirectory()) files.push(...await executableFiles(path,label));
    else if(entry.isFile() && /\.(?:[cm]?js|json)$/.test(entry.name)) files.push([label,path]);
  }
  return files;
}

async function currentManifest() {
  const contractsEntry=await realpath(fromPrediction.resolve('@dota/contracts'));
  assert.equal(contractsEntry,await realpath(workspaceFile('packages/contracts/dist/index.js')),
    'prediction must resolve the workspace contracts');
  const zodManifest=await realpath(fromContracts.resolve('zod/package.json'));
  const dependencies=await Promise.all([
    executableFiles(workspaceFile('packages/contracts/dist'),'packages/contracts/dist'),
    executableFiles(workspaceFile('packages/prediction/dist'),'packages/prediction/dist'),
    executableFiles(dirname(zodManifest),'dependency/zod')
  ]);
  const files=[...fixedFiles.map(path=>[path,workspaceFile(path)]),...dependencies.flat()];
  files.sort(([a],[b])=>a<b?-1:a>b?1:0);
  // Registration can later reference this digest without changing the candidate.
  const {format,candidate}=JSON.parse(await readFile(workspaceFile('tools/research/series-validation-policy.json'),'utf8'));
  assert.equal(format,'series-validation-policy-v1');
  assert.equal(candidate.recipe,'fixed_player_mean_Elo_then_constant_independent_map_probability_series_transform');
  assert(candidate.formats.includes(3),'BO3 is missing from the candidate policy');
  return {
    format:'series-bo3-candidate-manifest-v1',
    scope:'candidate_computation',
    bestOf:3,
    candidate,
    runtime:{
      node:process.version,platform:process.platform,arch:process.arch,v8:process.versions.v8,
      nodeBinarySha256:candidateSha(await readFile(process.execPath)),
      nodeOptionsSha256:candidateSha(JSON.stringify([process.execArgv,process.env.NODE_OPTIONS??'']))
    },
    dependencyVersions:{zod:JSON.parse(await readFile(zodManifest,'utf8')).version},
    files:await Promise.all(files.map(async ([path,local])=>({path,sha256:candidateSha(await readFile(local))})))
  };
}

async function writeManifest(path,bytes) {
  const temporary=join(dirname(resolve(path)),randomUUID()+'.tmp');
  try {
    await writeFile(temporary,bytes,{flag:'wx',flush:true});
    await link(temporary,path);
  } finally {
    await unlink(temporary).catch(error=>{if(error.code!=='ENOENT') throw error;});
  }
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [mode,path,expectedSha,...extra]=process.argv.slice(2);
  assert(path && !extra.length && ((mode==='create' && expectedSha===undefined) ||
    (mode==='verify' && /^[a-f0-9]{64}$/.test(expectedSha??''))),
    'usage: series-candidate-manifest.mjs create MANIFEST.json | verify MANIFEST.json SHA256');
  if(mode==='verify') {
    assert(candidateSha(await readFile(path))===expectedSha,'stored candidate manifest digest mismatch');
  }
  const manifest=await currentManifest();
  const bytes=JSON.stringify(manifest,null,2)+'\n';
  const sha256=candidateSha(bytes);
  if(mode==='create') await writeManifest(path,bytes);
  else assert(sha256===expectedSha,'candidate executable or runtime changed');
  console.log(JSON.stringify({status:mode==='create'?'created':'verified',sha256,files:manifest.files.length,
    node:manifest.runtime.node,zod:manifest.dependencyVersions.zod}));
}
