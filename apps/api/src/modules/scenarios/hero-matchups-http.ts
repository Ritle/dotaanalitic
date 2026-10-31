import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {HeroMatchupQuerySchema,HeroMatchupResponseSchema} from '@dota/contracts';
import {HeroMatchupRepository,ScenarioError} from '@dota/db';
export function registerHeroMatchups(app:FastifyInstance,repository:HeroMatchupRepository){
  app.post('/api/v1/scenarios/:id/hero-matchups',async(req,reply)=>{
    const p=z.object({id:z.uuid()}).strict().safeParse(req.params),q=HeroMatchupQuerySchema.safeParse(req.body);
    const fail=(status:number,code:string,message:string)=>reply.code(status).send({error:{code,message,requestId:req.id}});
    if(!p.success||!q.success)return fail(400,'VALIDATION_ERROR','Проверьте редакцию, период, патч и явно заданные коэффициенты.');
    try{return HeroMatchupResponseSchema.parse(await repository.report(req.ownerSession!.owner.id,p.data.id,q.data));}
    catch(e){if(e instanceof ScenarioError)return fail(e.code==='NOT_FOUND'?404:e.code==='CONFLICT'?409:400,e.code,
      e.code==='CONFLICT'?'Сценарий уже изменён. Загрузите актуальную редакцию.':e.code==='NOT_FOUND'?'Сценарий не найден.':'Некорректный период или фильтр.');throw e;}
  });
}
