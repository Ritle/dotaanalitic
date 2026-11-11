import {sql,type Db} from '@dota/db';
import {ContextCatalogSchema,type ContextCatalogQuery} from './context-catalog-contract.js';
export async function readContextCatalog(db:Db,q:ContextCatalogQuery){
 // Closed mapping; these are local primary keys, never provider IDs or release proofs.
 const table=q.kind==='patches'?'patches':'leagues',name=q.kind==='patches'?'label':'name';
 const where=q.id?sql`id=${q.id}::bigint`:sql`${q.query}='' OR id::text=${q.query} OR strpos(lower(${sql.ref(name)}),lower(${q.query}))>0`;
 const rows=(await sql<{id:string;name:string}>`SELECT id::text,${sql.ref(name)} AS name FROM ${sql.table(table)}
  WHERE ${where} ORDER BY lower(${sql.ref(name)}),id LIMIT ${q.id?1:21} OFFSET ${q.offset}`.execute(db)).rows;
 return ContextCatalogSchema.parse({kind:q.kind,source:'local_catalogue',readAt:new Date().toISOString(),items:rows.slice(0,20),hasMore:rows.length>20});
}
