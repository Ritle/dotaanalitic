import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {PlayerHistoryRepository,PlayerHistoryResumeError,historyResumeScope,playerHistoryKey,playerHistoryRun,type Db} from '@dota/db';
import {SelectedPlayerHistoryRequestSchema,PlayerHistoryResumeRequestSchema,PlayerHistoryResponseSchema,PlayerHistoryOptionsSchema,type PlayerHistoryOptions} from '@dota/contracts';
import {createPlayerHistoryQueue,enqueuePlayerHistory,enqueuePlayerHistoryResume,PLAYER_HISTORY_QUEUE,PlayerHistoryOptionsConflict} from '@dota/ingestion';
export class PlayerHistoryService{
 private readonly repo:PlayerHistoryRepository;
 private queue:ReturnType<typeof createPlayerHistoryQueue>|undefined;
 constructor(db:Db,private readonly connection:string){this.repo=new PlayerHistoryRepository(db);}
 private boss(){return this.queue??=createPlayerHistoryQueue(this.connection).catch(e=>{this.queue=undefined;throw e;});}
 async close(){await (await this.queue)?.stop({graceful:true,timeout:10000});}
 async resume(owner:string,runId:string){
  const row=await this.repo.get(runId);if(!row||row.owner_user_id!==owner)throw new PlayerHistoryResumeError('resume_source_unavailable');
  await enqueuePlayerHistoryResume(await this.boss(),this.repo.db,owner,runId);
  return this.read(owner,row.bindings.map(p=>p.playerId),false,row.options);
 }
 async read(owner:string,ids:string[],refresh=false,inputOptions:PlayerHistoryOptions={windowDays:90,maxMaps:10}){
  const options=PlayerHistoryOptionsSchema.parse(inputOptions),playerIds=[...ids].sort(),bindings=await this.repo.bindings(playerIds);
  if(!bindings)return PlayerHistoryResponseSchema.parse({playerIds,options,available:false,run:null,retryAt:null,message:'Для загрузки нужны пять различных игроков с однозначно подтверждёнными Steam32. Уточните аккаунты в каталоге.'});
  const key=playerHistoryKey(bindings,options);let row=await this.repo.latest(owner,key);
  if(row&&['queued','running'].includes(row.status)){
   const job=await (await this.boss()).getJobById(PLAYER_HISTORY_QUEUE,row.id);
   if(!job||['completed','failed','cancelled'].includes(job.state)){await this.repo.abandoned(row.id);row=await this.repo.latest(owner,key);}
  }
  if(refresh){await enqueuePlayerHistory(await this.boss(),this.repo.db,owner,bindings,options);row=await this.repo.latest(owner,key);}
  const message=row?.operation==='evidence_resume'?(['queued','running'].includes(row.status)?'Повторно проверяем данные уже загруженных карт. Новые карты не скачиваются.':row.status==='completed'?'Данные сохранённых карт проверены. История не скачивалась заново.':'Повторная проверка завершилась частично или с ошибкой. Посмотрите причины в отчёте.'):
   !row?`Можно загрузить до ${options.maxMaps} уникальных pro-карт выбранной пятёрки за ${options.windowDays} дней, включая игры в других командах.`:
   row.status==='queued'?'Задание в очереди. Для обработки должен быть запущен загрузчик истории.':row.status==='running'?'Проверяем личную историю выбранных игроков.':
   row.status==='completed'?(row.report&&playerHistoryRun(row).report?.accepted===0?'В ограниченной выборке источника подходящих карт не найдено. Это не означает отсутствие pro-опыта.':'История загружена. Показатели перечитаны; выборка не охватывает всю карьеру.'):
   row.error_code==='identity_changed'?'Связь игрока с аккаунтом изменилась. Проверьте состав и повторите загрузку.':row.error_code==='worker_unavailable'?'Задание не завершилось. Запустите загрузчик и повторите после паузы.':
   row.status==='partial'?'Часть карт не удалось принять. Проверьте счётчики и повторите позже.':'Источник или импорт сейчас недоступен. Повторите после паузы.';
  return PlayerHistoryResponseSchema.parse({playerIds,options,available:true,run:row?playerHistoryRun(row):null,canResume:!!row&&historyResumeScope(row).length>0,retryAt:row&&row.next_allowed_at.getTime()>Date.now()?row.next_allowed_at.toISOString():null,message});
 }
}
export function registerPlayerHistory(app:FastifyInstance,service:PlayerHistoryService){
 app.post('/api/v1/players/history-refresh/resume',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(req,reply)=>{
  const parsed=PlayerHistoryResumeRequestSchema.safeParse(req.body);
  if(!parsed.success||!z.object({}).strict().safeParse(req.query).success)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Выберите сохранённое задание истории.',requestId:req.id}});
  try{return reply.code(202).send(await service.resume(req.ownerSession!.owner.id,parsed.data.runId));}
  catch(e){if(e instanceof PlayerHistoryResumeError||e instanceof PlayerHistoryOptionsConflict)return reply.code(409).send({error:{code:'PLAYER_HISTORY_RESUME_UNAVAILABLE',message:'Проверьте аккаунты и завершённое задание истории. Возможно, уже выполняется загрузка с другими параметрами.',requestId:req.id}});
   return reply.code(503).send({error:{code:'PLAYER_HISTORY_UNAVAILABLE',message:'Повторная проверка сейчас недоступна. Попробуйте позже.',requestId:req.id}});}
 });
 for(const method of ['GET','POST'] as const)app.route({method,url:'/api/v1/players/history-refresh',config:{rateLimit:{max:method==='GET'?120:20,timeWindow:'1 minute'}},handler:async(req,reply)=>{
  const choice=(values:readonly string[])=>z.string().refine(s=>values.includes(s)).transform(Number).optional();
  const query=z.object({playerIds:z.string().max(100),windowDays:choice(['90','180','365','730']),maxMaps:choice(['10','25','50'])}).strict().safeParse(req.query);
  const parsed=SelectedPlayerHistoryRequestSchema.safeParse(method==='GET'&&query.success?{...query.data,playerIds:query.data.playerIds.split(',')}:req.body);
  if(!parsed.success||method==='GET'&&!query.success||method==='POST'&&!z.object({}).strict().safeParse(req.query).success)
   return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Выберите пять различных игроков.',requestId:req.id}});
  try{return reply.code(method==='POST'?202:200).send(await service.read(req.ownerSession!.owner.id,parsed.data.playerIds,method==='POST',{windowDays:parsed.data.windowDays,maxMaps:parsed.data.maxMaps}));}
  catch(e){if(e instanceof PlayerHistoryOptionsConflict)return reply.code(409).send({error:{code:'PLAYER_HISTORY_ALREADY_RUNNING',message:'История этой пятёрки уже загружается с другими параметрами. Дождитесь завершения задания.',requestId:req.id}});
   return reply.code(503).send({error:{code:'PLAYER_HISTORY_UNAVAILABLE',message:'Загрузка истории сейчас недоступна. Попробуйте позже.',requestId:req.id}});}
 }});
}
