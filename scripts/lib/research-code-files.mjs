import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ResearchExecutionCodeSchema } from '../../packages/contracts/dist/index.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const maxManifestBytes = 2 * 1024 * 1024;

/** Keep legacy references readable; large inventories use one immutable file reference. */
export async function researchCodeReferences(root, files) {
 if (!Array.isArray(files) || files.length < 1 || files.length > 4096) throw Error('research_code_inventory_limit');
 for (let offset = 0; offset < files.length; offset += 256) ResearchExecutionCodeSchema.parse(files.slice(offset, offset + 256));
 if (new Set(files.map(file => file.path)).size !== files.length) throw Error('research_code_duplicate_path');
 const ordered = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
 if (ordered.length <= 256) return ResearchExecutionCodeSchema.parse(ordered);
 const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, format: 'research-executable-file-manifest-v1', files: ordered }) + '\n');
 if (bytes.length > maxManifestBytes) throw Error('research_code_inventory_limit');
 const sha256 = digest(bytes);
 const relative = `.tools/research-code-manifests/${sha256}.json`;
 const destination = path.join(root, relative), directory = path.dirname(destination);
 await mkdir(directory, { recursive: true });
 const temporary = path.join(directory, `${sha256}-${randomUUID()}.tmp`);
 let temporaryCreated = false;
 try {
  const file = await open(temporary, 'wx'); temporaryCreated = true;
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  // Publish a completed file atomically. A concurrent writer cannot expose partial JSON.
  try { await link(temporary, destination); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const saved = await open(destination, 'r');
  try {
   const stat = await saved.stat();
   if (!stat.isFile() || stat.size !== bytes.length) throw Error('research_code_manifest_conflict');
   const existing = Buffer.alloc(bytes.length + 1); let count = 0;
   while (count < existing.length) {
    const part = await saved.read(existing, count, existing.length - count, null);
    if (!part.bytesRead) break;
    count += part.bytesRead;
   }
   if (!bytes.equals(existing.subarray(0, count))) throw Error('research_code_manifest_conflict');
  } finally { await saved.close(); }
 } finally { if (temporaryCreated) await unlink(temporary); }
 return ResearchExecutionCodeSchema.parse([{ path: relative, sha256 }]);
}
