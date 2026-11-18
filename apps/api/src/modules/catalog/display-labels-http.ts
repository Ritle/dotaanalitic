import type {FastifyInstance} from 'fastify';
import type {Db} from '@dota/db';
import {DisplayLabelsQuerySchema} from './display-labels-contract.js';
import {readDisplayLabels} from './display-labels-repository.js';
export function registerDisplayLabels(app:FastifyInstance,db:Db){
 app.get('/api/v1/catalog-labels',async(request,reply)=>{
  const query=DisplayLabelsQuerySchema.safeParse(request.query);
  if(!query.success)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте список записей: до двух команд, двадцати игроков и пятидесяти героев.',requestId:request.id}});
  return readDisplayLabels(db,query.data);
 });
}
