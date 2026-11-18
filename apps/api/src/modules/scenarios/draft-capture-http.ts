import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {DraftCaptureRequestSchema,DraftCaptureSavedSchema} from './draft-capture-contract.js';
import {ScenarioError} from '@dota/db';
import {DraftCaptureRepository} from './draft-capture-repository.js';
import {readDraftHistorySummary} from './draft-history-summary.js';
import type {Db} from '@dota/db';
import {DraftShadowRepository} from './draft-shadow-repository.js';
const Params=z.object({id:z.uuid().transform(v=>v.toLowerCase())}).strict();
const ReadParams=Params.extend({revision:z.coerce.number().int().positive().max(2147483646)});
export function registerDraftCaptures(app:FastifyInstance,repository:DraftCaptureRepository,db:Db){
  const shadow=new DraftShadowRepository(db);
  const fail=(code:string,requestId:string)=>({error:{code,requestId,message:code==='CONFLICT'
    ?'Сценарий изменён. Загрузите сохранённую редакцию перед фиксацией драфта.'
    :code==='NOT_FOUND'?'Сохранённый драфт не найден.':'Проверьте идентификатор сценария и номер сохранённой редакции.'}});
  app.post('/api/v1/scenarios/:id/draft-captures',async(req,reply)=>{
    const p=Params.safeParse(req.params),q=DraftCaptureRequestSchema.safeParse(req.body);
    if(!p.success||!q.success)return reply.code(400).send(fail('VALIDATION_ERROR',req.id));
    try{
      const result=await repository.create(req.ownerSession!.owner.id,p.data.id,q.data);
      await shadow.ensure(req.ownerSession!.owner.id,p.data.id,q.data.expectedRevision);
      return DraftCaptureSavedSchema.parse(result);
    }
    catch(e){if(e instanceof ScenarioError)return reply.code(e.code==='CONFLICT'?409:e.code==='NOT_FOUND'?404:400).send(fail(e.code,req.id));throw e;}
  });
  app.get('/api/v1/scenarios/:id/draft-captures/:revision/shadow-summary',async(req,reply)=>{
    if(req.ownerSession!.role!=='owner')return reply.code(403).send({error:{code:'OWNER_REQUIRED',requestId:req.id,message:'Состояние расчёта доступно владельцу.'}});
    const p=ReadParams.safeParse(req.params);if(!p.success)return reply.code(400).send(fail('VALIDATION_ERROR',req.id));
    try{return await shadow.summary(req.ownerSession!.owner.id,p.data.id,p.data.revision);}
    catch(e){if(e instanceof ScenarioError)return reply.code(404).send(fail('NOT_FOUND',req.id));throw e;}
  });
  app.post('/api/v1/scenarios/:id/draft-captures/:revision/shadow-retry',async(req,reply)=>{
    const p=ReadParams.safeParse(req.params);
    if(!p.success||!z.object({}).strict().safeParse(req.body).success)return reply.code(400).send(fail('VALIDATION_ERROR',req.id));
    try{return await shadow.ensure(req.ownerSession!.owner.id,p.data.id,p.data.revision);}
    catch(e){if(e instanceof ScenarioError)return reply.code(404).send(fail('NOT_FOUND',req.id));throw e;}
  });
  app.get('/api/v1/scenarios/:id/draft-captures/:revision',async(req,reply)=>{
    if(req.ownerSession!.role!=='owner')return reply.code(403).send({error:{code:'OWNER_REQUIRED',requestId:req.id,message:'Снимки драфта доступны владельцу.'}});
    const p=ReadParams.safeParse(req.params);if(!p.success)return reply.code(400).send(fail('VALIDATION_ERROR',req.id));
    const result=await repository.get(req.ownerSession!.owner.id,p.data.id,p.data.revision);
    return result?DraftCaptureSavedSchema.parse(result):reply.code(404).send(fail('NOT_FOUND',req.id));
  });
  app.get('/api/v1/scenarios/:id/draft-captures/:revision/history-summary',async(req,reply)=>{
    if(req.ownerSession!.role!=='owner')return reply.code(403).send({error:{code:'OWNER_REQUIRED',requestId:req.id,message:'Проверка истории доступна владельцу.'}});
    const p=ReadParams.safeParse(req.params);if(!p.success)return reply.code(400).send(fail('VALIDATION_ERROR',req.id));
    try{return await readDraftHistorySummary(db,req.ownerSession!.owner.id,p.data.id,p.data.revision);}
    catch(e){if(e instanceof ScenarioError)return reply.code(404).send(fail('NOT_FOUND',req.id));throw e;}
  });
}
