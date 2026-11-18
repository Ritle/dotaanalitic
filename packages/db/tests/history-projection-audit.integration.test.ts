import {test,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {sql} from '../src/index';
import {testDatabase} from '../../../tests/helpers/postgres';
test('projection provenance must be registered before completion and both records are immutable',async()=>{
 const database=await testDatabase();try{
  const id=randomUUID(),manifest=JSON.stringify({syntheticOnly:true,lineage:[{originalSource:{payloadSha256:'a'.repeat(64)},projectionSha256:'b'.repeat(64),knownAt:null}]}),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  await expect(sql`INSERT INTO history_projection_import_completions(import_id,report_text,report_sha256) VALUES(${id}::uuid,'{}',${hash('{}')})`.execute(database.db)).rejects.toThrow();
  await sql`INSERT INTO history_projection_imports(id,manifest_text,manifest_sha256) VALUES(${id}::uuid,${manifest},${hash(manifest)})`.execute(database.db);
  await sql`INSERT INTO history_projection_import_completions(import_id,report_text,report_sha256) VALUES(${id}::uuid,'{}',${hash('{}')})`.execute(database.db);
  for(const table of ['history_projection_imports','history_projection_import_completions']){
   await expect(sql`DELETE FROM ${sql.table(table)}`.execute(database.db)).rejects.toThrow('history_projection_import_audit_immutable');
   await expect(sql`UPDATE ${sql.table(table)} SET ${sql.ref(table==='history_projection_imports'?'manifest_text':'report_text')}='{}'`.execute(database.db)).rejects.toThrow('history_projection_import_audit_immutable');
  }
  const row=(await sql<{manifest_text:string;manifest_sha256:string}>`SELECT manifest_text,manifest_sha256 FROM history_projection_imports`.execute(database.db)).rows[0]!;
  expect(row.manifest_text).toBe(manifest);expect(row.manifest_sha256).toBe(hash(manifest));
 }finally{await database.close();}
},30000);
