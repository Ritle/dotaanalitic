import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Compile from repository sources, without requiring private research artifacts.
export function compileNativeExportRuntime(){
  execFileSync(process.execPath,['node_modules/typescript/bin/tsc',
    'tools/research/player-hero-prospective-features.mts','tools/research/player-hero-inference.mts',
    '--strict','--noUncheckedIndexedAccess','--skipLibCheck','--target','ES2022',
    '--module','NodeNext','--moduleResolution','NodeNext','--types','node',
    '--typeRoots','packages/db/node_modules/@types','--outDir','.tools/s304-prospective-features-runtime'],
  {cwd:fileURLToPath(new URL('../../',import.meta.url)),windowsHide:true,stdio:'pipe',timeout:120000});
}
