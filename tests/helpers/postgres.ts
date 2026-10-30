import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createDatabase,sql} from '../../packages/db/dist/index.js';

export async function testDatabase(){
  const connection=process.env.DATABASE_URL;
  if(!connection)throw new Error('DATABASE_URL required; PostgreSQL ingestion tests cannot be skipped');
  const name='codex_ingest_'+randomBytes(6).toString('hex');
  if(!/^codex_ingest_[a-f0-9]{12}$/.test(name))throw new Error('unsafe_test_database');
  const admin=createDatabase(connection);
  await sql`CREATE DATABASE ${sql.id(name)}`.execute(admin);
  const uri=new URL(connection);uri.pathname='/'+name;
  const url=uri.toString();
  const db=createDatabase(url);
  const close=async()=>{await db.destroy();await sql`DROP DATABASE ${sql.id(name)} WITH (FORCE)`.execute(admin);await admin.destroy();};
  try{
    execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/migrate.mjs',import.meta.url))],
      {env:{...process.env,DATABASE_URL:url},stdio:'pipe'});
  }catch(error){await close();throw error;}
  return {db,url,close};
}
