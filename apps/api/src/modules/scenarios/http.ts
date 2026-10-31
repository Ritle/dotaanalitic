import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {ScenarioInputSchema,UpdateScenarioSchema,ScenarioSnapshotSchema,ScenarioListSchema,ScenarioHistorySchema,DraftAssessmentSchema} from '@dota/contracts';
import {ScenarioRepository,ScenarioError} from '@dota/db';
const Params=z.object({id:z.uuid()}).strict();
const Paging=z.object({offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict();
export function registerScenarios(app:FastifyInstance,repository:ScenarioRepository){
  const failure=(code:string,requestId:string)=>({error:{code,requestId,message:code==='CONFLICT'?
    'Сценарий уже изменён. Загрузите сохранённую редакцию и повторите правки.':code==='DRAFT_UNAVAILABLE'?'Выбранный герой недоступен по подтверждённому источнику. Проверьте доступность и измените выбор.':code==='NOT_FOUND'?'Сценарий не найден.':
    'Проверьте две разные команды, 10 разных игроков из каталога, подтверждение, даты UTC и контекст одной карты.'}});
  app.get('/api/v1/scenarios',async(req,reply)=>{
    const q=Paging.safeParse(req.query);if(!q.success)return reply.code(400).send(failure('VALIDATION_ERROR',req.id));
    return ScenarioListSchema.parse(await repository.list(req.ownerSession!.owner.id,q.data.offset));
  });
  app.post('/api/v1/scenarios',async(req,reply)=>{
    const input=ScenarioInputSchema.safeParse(req.body);if(!input.success)return reply.code(400).send(failure('VALIDATION_ERROR',req.id));
    try{return reply.code(201).send(ScenarioSnapshotSchema.parse(await repository.save(req.ownerSession!.owner.id,input.data)));}
    catch(e){if(e instanceof ScenarioError)return reply.code(e.code==='DRAFT_UNAVAILABLE'?422:e.code==='VALIDATION_ERROR'?400:409).send(failure(e.code,req.id));throw e;}
  });
  app.post('/api/v1/scenarios/draft-check',async(req,reply)=>{
    const input=ScenarioInputSchema.safeParse(req.body);if(!input.success)return reply.code(400).send(failure('VALIDATION_ERROR',req.id));
    try{return DraftAssessmentSchema.parse(await repository.checkDraft(input.data));}
    catch(e){if(e instanceof ScenarioError)return reply.code(400).send(failure(e.code,req.id));throw e;}
  });
  app.get('/api/v1/scenarios/:id',async(req,reply)=>{
    const p=Params.safeParse(req.params);if(!p.success)return reply.code(400).send(failure('VALIDATION_ERROR',req.id));
    try{return ScenarioSnapshotSchema.parse(await repository.get(req.ownerSession!.owner.id,p.data.id));}
    catch(e){if(e instanceof ScenarioError)return reply.code(404).send(failure(e.code,req.id));throw e;}
  });
  app.get('/api/v1/scenarios/:id/history',async(req,reply)=>{
    const p=Params.safeParse(req.params),q=Paging.safeParse(req.query);
    if(!p.success||!q.success)return reply.code(400).send(failure('VALIDATION_ERROR',req.id));
    try{return ScenarioHistorySchema.parse(await repository.history(req.ownerSession!.owner.id,p.data.id,q.data.offset));}
    catch(e){if(e instanceof ScenarioError)return reply.code(404).send(failure(e.code,req.id));throw e;}
  });
  app.put('/api/v1/scenarios/:id',async(req,reply)=>{
    const p=Params.safeParse(req.params),input=UpdateScenarioSchema.safeParse(req.body);
    if(!p.success||!input.success)return reply.code(400).send(failure('VALIDATION_ERROR',req.id));
    try{return ScenarioSnapshotSchema.parse(await repository.save(req.ownerSession!.owner.id,input.data.input,{id:p.data.id,expectedRevision:input.data.expectedRevision}));}
    catch(e){if(e instanceof ScenarioError)return reply.code(e.code==='DRAFT_UNAVAILABLE'?422:e.code==='CONFLICT'?409:e.code==='NOT_FOUND'?404:400).send(failure(e.code,req.id));throw e;}
  });
}
