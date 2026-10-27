import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors=[];
function visit(dir) {
 for (const item of fs.readdirSync(dir,{withFileTypes:true})) {
  const p=path.join(dir,item.name);
  if (item.isDirectory() && !['node_modules','.git','dist','artifacts'].includes(item.name)) visit(p);
  else if (item.isFile() && p.endsWith('.md')) {
   const src=fs.readFileSync(p,'utf8');
   const links=[...src.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(x=>x[1].split('#')[0]);
   for (const target of links) {
    if (!target || /^(https?:|mailto:|#)/i.test(target)) continue;
    const clean=decodeURIComponent(target).replace(/^<|>$/g,'');
    if (!fs.existsSync(path.resolve(path.dirname(p),clean))) errors.push(`${path.relative(root,p)} -> ${target}`);
   }
  }
 }
}
visit(root);
if(errors.length){ console.error(errors.join('\n')); process.exitCode=1; }
else console.log('Markdown relative links validated');
