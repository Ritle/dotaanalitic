import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {ScenarioError} from '@dota/db';
import {DraftNativeRequestSchema} from './draft-native-contract.js';
import type {DraftNativeRepository} from './draft-native-repository.js';
const Params=z.object({id:z.uuid().transform(v=>v.toLowerCase()),revision:z.coerce.number().int().positive().max(2147483646)}).strict();
export function registerDraftNativeBindings(app:FastifyInstance,repo:DraftNativeRepository){
  const error=(code:string,requestId:string)=>({error:{code,requestId,message:code==='CONFLICT'?
    'Для снимка уже сохранена другая карта или этот запрос относится к другой проверке. Загрузите сохранённые данные.':
    code==='NOT_FOUND'?'Снимок сохранённой редакции не найден.':code==='OWNER_REQUIRED'?'Проверка карты доступна владельцу.':'Укажите числовой Dota match ID.'}});
  app.get('/api/v1/scenarios/:id/draft-captures/:revision/native-binding',async(req,reply)=>{
    if(req.ownerSession!.role!=='owner')return reply.code(403).send(error('OWNER_REQUIRED',req.id));
    const p=Params.safeParse(req.params);if(!p.success)return reply.code(400).send(error('VALIDATION_ERROR',req.id));
    try{return await repo.get(req.ownerSession!.owner.id,p.data.id,p.data.revision);}
    catch(e){if(e instanceof ScenarioError)return reply.code(404).send(error('NOT_FOUND',req.id));throw e;}
  });
  app.post('/api/v1/scenarios/:id/draft-captures/:revision/native-binding',async(req,reply)=>{
    const p=Params.safeParse(req.params),q=DraftNativeRequestSchema.safeParse(req.body);
    if(!p.success||!q.success)return reply.code(400).send(error('VALIDATION_ERROR',req.id));
    try{return await repo.create(req.ownerSession!.owner.id,p.data.id,p.data.revision,q.data);}
    catch(e){if(e instanceof ScenarioError)return reply.code(e.code==='CONFLICT'?409:e.code==='NOT_FOUND'?404:400).send(error(e.code,req.id));throw e;}
  });
}
