import type {FastifyInstance} from 'fastify';
import type {Db} from '@dota/db';
import {ContextCatalogQuerySchema} from './context-catalog-contract.js';
import {readContextCatalog} from './context-catalog-repository.js';
export function registerContextCatalog(app:FastifyInstance,db:Db){
 app.get('/api/v1/context-catalog',async(request,reply)=>{
  const query=ContextCatalogQuerySchema.safeParse(request.query);
  if(!query.success)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте вид справочника, поиск или локальный ID.',requestId:request.id}});
  return readContextCatalog(db,query.data);
 });
}
