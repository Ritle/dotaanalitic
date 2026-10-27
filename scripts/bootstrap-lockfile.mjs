import { spawnSync } from 'node:child_process';
console.log('Generating real pnpm lockfile with exact registry integrity metadata (requires npm registry access).');
const args=['pnpm','install','--lockfile-only','--ignore-scripts'];
const result=spawnSync('corepack',args,{stdio:'inherit',shell:process.platform==='win32'});
if(result.error) { console.error(result.error.message); process.exitCode=1; }
else if(result.status!==0) {
  console.error('Could not generate pnpm-lock.yaml. Check registry/network and retry; NEVER handwrite a lockfile.');
  process.exitCode=result.status || 1;
} else console.log('Commit pnpm-lock.yaml. CI will require it with --frozen-lockfile.');
