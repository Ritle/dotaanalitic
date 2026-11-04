import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {CatalogIdSchema,RosterCatalogueSearchSchema,RosterCatalogueApplySchema} from '@dota/contracts';
import {RosterCatalogueError,RoleProfileQueryError} from '@dota/db';
import {RosterCatalogueService} from './catalogue-service.js';
export function registerRosterCatalogue(app:FastifyInstance,service:RosterCatalogueService){
 for(const action of ['state','search','apply'] as const)app.route<{Params:{id:string}}>({method:action==='state'?'GET':'POST',
  url:'/api/v1/upcoming/:id/catalogue'+(action==='state'?'':'/'+action),config:{rateLimit:{max:60,timeWindow:'1 minute'}},handler:async(req,reply)=>{
   try{const id=CatalogIdSchema.parse(req.params.id);z.object({}).strict().parse(req.query);
    const owner=req.ownerSession!.owner.id;
    if(action==='state')return await service.state(owner,id);
    if(action==='search'){const q=RosterCatalogueSearchSchema.parse(req.body);return await service.search(id,q.kind,q.query);}
    return await service.apply(owner,id,RosterCatalogueApplySchema.parse(req.body));
   }catch(e){const code=e instanceof RosterCatalogueError?e.code:e instanceof RoleProfileQueryError?'conflict':e instanceof z.ZodError?'invalid':null;
    if(!code)throw e;return reply.code(code==='source_unavailable'?503:code==='invalid'?400:409).send({error:{code:'CATALOGUE_'+code.toUpperCase(),requestId:req.id,message:{
     invalid:'Выберите команду и пять разных аккаунтов из каталога источника.',conflict:'Сопоставление или данные аккаунтов изменились. Перечитайте связи и проверьте выбранные ID.',
     source_changed:'Заявка или каталог обновились. Обновите составы, перечитайте связи и повторите выбор.',source_unavailable:'Каталог источника пока недоступен или уже обновляется. Повторите поиск позже.'}[code]}});
   }
  }});
}
