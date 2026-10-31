import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {ScenarioReportQuerySchema,ScenarioReportCreateSchema,ScenarioReportSchema,ScenarioReportHistorySchema} from '@dota/contracts';
import {ScenarioReportRepository,ScenarioError} from '@dota/db';
const Params=z.object({id:z.uuid()}).strict(),Paging=z.object({offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict();
export function registerReports(app:FastifyInstance,repository:ScenarioReportRepository){
  const failure=(reply:import('fastify').FastifyReply,requestId:string,e:ScenarioError)=>reply.code(e.code==='NOT_FOUND'?404:e.code==='CONFLICT'?409:400).send({error:{code:e.code,requestId,
    message:e.code==='NOT_FOUND'?'Отчёт или сценарий не найден.':e.code==='CONFLICT'?'Сценарий изменён или занят другим расчётом. Обновите редакцию и повторите.':'Проверьте редакцию сценария, период, патч и параметры отчёта.'}});
  app.post('/api/v1/scenarios/:id/analyses',async(req,reply)=>{
    const p=Params.safeParse(req.params),q=ScenarioReportQuerySchema.safeParse(req.body);
    if(!p.success||!q.success)return failure(reply,req.id,new ScenarioError('VALIDATION_ERROR'));
    try{const result=ScenarioReportCreateSchema.parse(await repository.create(req.ownerSession!.owner.id,p.data.id,q.data));return reply.code('status' in result?200:201).send(result);}
    catch(e){if(e instanceof ScenarioError)return failure(reply,req.id,e);throw e;}
  });
  app.get('/api/v1/scenarios/:id/analyses',async(req,reply)=>{
    const p=Params.safeParse(req.params),q=Paging.safeParse(req.query);if(!p.success||!q.success)return failure(reply,req.id,new ScenarioError('VALIDATION_ERROR'));
    try{return ScenarioReportHistorySchema.parse(await repository.history(req.ownerSession!.owner.id,p.data.id,q.data.offset));}
    catch(e){if(e instanceof ScenarioError)return failure(reply,req.id,e);throw e;}
  });
  app.get('/api/v1/analyses/:id',async(req,reply)=>{
    const p=Params.safeParse(req.params);if(!p.success)return failure(reply,req.id,new ScenarioError('VALIDATION_ERROR'));
    try{return ScenarioReportSchema.parse(await repository.get(req.ownerSession!.owner.id,p.data.id));}
    catch(e){if(e instanceof ScenarioError)return failure(reply,req.id,e);throw e;}
  });
}
