import {sql,type Db} from '@dota/db';
import {DisplayLabelsSchema,type DisplayLabelsQuery} from './display-labels-contract.js';
export async function readDisplayLabels(db:Db,query:DisplayLabelsQuery){
 const [teams,players]=await Promise.all([
  sql<{id:string;name:string}>`SELECT id::text,name FROM teams WHERE id=ANY(${[...new Set(query.teams)]}::bigint[]) ORDER BY id`.execute(db),
  sql<{id:string;name:string}>`SELECT id::text,nickname AS name FROM players WHERE id=ANY(${[...new Set(query.players)]}::bigint[]) ORDER BY id`.execute(db)
 ]);
 return DisplayLabelsSchema.parse({source:'local_catalogue',readAt:new Date().toISOString(),teams:teams.rows,players:players.rows});
}
