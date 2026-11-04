import {z} from 'zod';
import type {FastifyInstance,FastifyReply} from 'fastify';
import {V1JournalCurrentRequestSchema} from '@dota/contracts';
import {ScenarioError,type V1JournalService} from '@dota/db';
const Params=z.object({requestId:z.uuid()}).strict();
const Page=z.object({offset:z.coerce.number().int().min(0).max(5000).default(0)}).strict();
const History=z.object({beforeRevision:z.coerce.number().int().positive().max(2147483647).optional()}).strict();
export function registerJournal(app:FastifyInstance,service:V1JournalService){
  function failure(reply:FastifyReply,requestId:string,status:number,code:string,message:string){return reply.code(status).send({error:{code,requestId,message}});}
  function handle(reply:FastifyReply,requestId:string,error:unknown){
    if(error instanceof ScenarioError&&error.code==='NOT_FOUND')return failure(reply,requestId,404,'NOT_FOUND','Отчёт не найден.');
    if(error instanceof Error){
      if(error.message==='journal_request_busy')return failure(reply.header('Retry-After','1'),requestId,429,'JOURNAL_BUSY','Другой отчёт ещё создаётся. Повторите запрос после его завершения.');
      if(error.message==='journal_request_conflict')return failure(reply,requestId,409,'REQUEST_CONFLICT','Этот запрос уже сохранён с другими фильтрами. Создайте новый отчёт.');
      if(['journal_inventory_limit','journal_inventory_bytes_limit','journal_report_bytes_limit'].includes(error.message))
        return failure(reply,requestId,422,'JOURNAL_LIMIT','Полный журнал превышает лимит отчёта. Частичная статистика не сформирована.');
      if(error.message==='journal_integrity')return failure(reply,requestId,503,'JOURNAL_INTEGRITY','Не удалось проверить сохранённый отчёт. Требуется проверка локальных данных.');
      if(error.message==='journal_server_code_changed')return failure(reply,requestId,503,'JOURNAL_CODE_CHANGED','Приложение обновлено. Перезапустите локальный сервер перед новым отчётом. Сохранённые версии доступны.');
    }
    throw error;
  }
  const invalid=(reply:FastifyReply,id:string)=>failure(reply,id,400,'VALIDATION_ERROR','Проверьте период UTC, ID модели, статус и параметры страницы.');
  app.post('/api/v1/forecast-journal',{config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async(req,reply)=>{
    const input=V1JournalCurrentRequestSchema.safeParse(req.body);if(!input.success)return invalid(reply,req.id);
    try{return await service.create(req.ownerSession!.owner.id,input.data);}catch(e){return handle(reply,req.id,e);}
  });
  app.get('/api/v1/forecast-journal',async(req,reply)=>{
    const q=History.safeParse(req.query);if(!q.success)return invalid(reply,req.id);
    try{return await service.history(req.ownerSession!.owner.id,q.data.beforeRevision??null);}catch(e){return handle(reply,req.id,e);}
  });
  app.get('/api/v1/forecast-journal/:requestId',async(req,reply)=>{
    const p=Params.safeParse(req.params),q=Page.safeParse(req.query);if(!p.success||!q.success)return invalid(reply,req.id);
    try{return await service.get(req.ownerSession!.owner.id,p.data.requestId,q.data.offset);}catch(e){return handle(reply,req.id,e);}
  });
}
