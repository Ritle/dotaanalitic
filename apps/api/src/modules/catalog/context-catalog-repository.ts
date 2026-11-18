import {sql,type Db} from '@dota/db';
import {ContextCatalogSchema,type ContextCatalogQuery} from './context-catalog-contract.js';
export async function readContextCatalog(db:Db,q:ContextCatalogQuery){
 // Closed mapping; these are local primary keys, never provider IDs or release proofs.
 const mapping={patches:{table:'patches',name:'label',secondary:null},leagues:{table:'leagues',name:'name',secondary:null},
  heroes:{table:'heroes',name:'localized_name',secondary:'internal_name'},players:{table:'players',name:'nickname',secondary:null},teams:{table:'teams',name:'name',secondary:'tag'}} as const;
 const {table,name,secondary}=mapping[q.kind];
 const extra=secondary?sql`OR strpos(lower(coalesce(${sql.ref(secondary)},'') COLLATE "und-x-icu"),lower(${q.query} COLLATE "und-x-icu"))>0`:sql``;
 const where=q.ids?sql`id=ANY(${[...new Set(q.ids)]}::bigint[])`:q.id?sql`id=${q.id}::bigint`:sql`${q.query}='' OR id::text=${q.query} OR strpos(lower(${sql.ref(name)} COLLATE "und-x-icu"),lower(${q.query} COLLATE "und-x-icu"))>0 ${extra}`;
 const rows=(await sql<{id:string;name:string}>`SELECT id::text,${sql.ref(name)} AS name FROM ${sql.table(table)}
  WHERE ${where} ORDER BY lower(${sql.ref(name)}),id LIMIT ${q.ids?20:q.id?1:21} OFFSET ${q.offset}`.execute(db)).rows;
 return ContextCatalogSchema.parse({kind:q.kind,source:'local_catalogue',readAt:new Date().toISOString(),items:rows.slice(0,20),hasMore:rows.length>20});
}
