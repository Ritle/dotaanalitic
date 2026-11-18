import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {sql,PlayerHistoryRepository,type Db} from '@dota/db';
import {PlayerHistoryOptionsSchema,type PlayerHistoryOptions} from '@dota/contracts';
import {PlayerHistoryService} from './player-history.js';
import {ComparisonHistoryRequestSchema,ComparisonHistoryResponseSchema,comparisonHistoryOptions,minimumComparisonHistory,needsComparisonHistory,type ComparisonHistoryRequest,type ComparisonHistoryResponse} from './comparison-history-contract.js';
export class ComparisonHistoryService{
 private readonly repo:PlayerHistoryRepository;
 constructor(private readonly db:Db,private readonly history:PlayerHistoryService){this.repo=new PlayerHistoryRepository(db);}
 async read(owner:string,input:ComparisonHistoryRequest,start:boolean,canProcess:boolean){
  const checkedAt=new Date().toISOString();
  const groups:ComparisonHistoryResponse['groups']=[];
  for(const slot of ['A','B'] as const){
   const ids=[...(slot==='A'?input.lineupA:input.lineupB)].sort();
   const base={slot,playerIds:ids,coverage:null,history:null};
   if(input.cutoffAt){groups.push({...base,state:'historical',message:'Для явно заданного исторического среза автоматическая загрузка выключена. Используйте имеющиеся данные или ручную подготовку истории.'});continue;}
   try{
    const bindings=await this.repo.bindings(ids);
    if(!bindings){groups.push({...base,state:'unavailable',message:'Для автоматической загрузки нужны пять однозначно подтверждённых числовых аккаунтов. Уточните состав.'});continue;}
    // Global normalized pro coverage, deliberately independent of display date/patch/league filters.
    const coverage=[];
    for(const b of bindings){
     const row=(await sql<{n:number}>`SELECT count(DISTINCT m.id)::int n FROM matches m JOIN match_players p ON p.match_id=m.id
      WHERE p.player_id=${b.playerId} AND p.source_account_id=${b.accountId} AND m.is_pro IS TRUE AND m.ingest_state IN ('accepted','partial')
      AND m.radiant_win IS NOT NULL AND m.duration_seconds>0 AND m.started_at<${checkedAt}::timestamptz
      AND m.started_at+m.duration_seconds*interval '1 second'<=${checkedAt}::timestamptz`.execute(this.db)).rows[0]!;
     coverage.push({playerId:b.playerId,nRaw:row.n});
    }
    const active=(await sql<{options:unknown}>`SELECT options FROM player_history_runs WHERE owner_user_id=${owner}::uuid AND bindings=${JSON.stringify(bindings)}::jsonb
     AND (status IN ('queued','running') OR next_allowed_at>clock_timestamp()) ORDER BY (status IN ('queued','running')) DESC,created_at DESC,id DESC LIMIT 1`.execute(this.db)).rows[0];
    let options:PlayerHistoryOptions=active?PlayerHistoryOptionsSchema.parse(active.options):comparisonHistoryOptions;
    let history=await this.history.read(owner,ids,false,options);
    const needed=needsComparisonHistory(coverage.map(p=>p.nRaw));
    const wasActive=!!history.run&&['queued','running'].includes(history.run.status);
    if(!needed&&!wasActive){groups.push({...base,coverage,state:'covered',history,message:'Локальной pro-истории достаточно для базового сравнения. Нулевой результат отдельных фильтров не запускает повторное скачивание. Это не проверка пригодности для прогноза.'});continue;}
    if(start&&needed&&!wasActive&&!history.retryAt){
     try{history=await this.history.read(owner,ids,true,options);}
     catch(error){
      // Another request may have queued this exact binding with different options.
      const raced=(await sql<{options:unknown}>`SELECT options FROM player_history_runs WHERE owner_user_id=${owner}::uuid AND bindings=${JSON.stringify(bindings)}::jsonb AND status IN ('queued','running') ORDER BY created_at DESC,id DESC LIMIT 1`.execute(this.db)).rows[0];
      if(!raced)throw error;options=PlayerHistoryOptionsSchema.parse(raced.options);history=await this.history.read(owner,ids,false,options);
     }
    }
    if(history.run&&['queued','running'].includes(history.run.status)&&canProcess){await this.history.processSelected(owner,history.run.id,start);history=await this.history.read(owner,ids,false,options);}
    const state=history.run?.status??'unavailable';
    groups.push({...base,coverage,history,state:!wasActive&&!start&&!history.run?'unavailable':state,
     message:state==='queued'?'История выбранной пятёрки в очереди. Автоматический загрузчик обработает её в фоне.':state==='running'?'Загружаем ограниченную pro-историю выбранной пятёрки. Имеющиеся данные остаются доступны.':history.message});
   }catch{groups.push({...base,state:'unavailable',message:'Автоматическая подготовка истории временно недоступна. Имеющиеся данные сохранены. Повторите сравнение позже.'});}
  }
  return ComparisonHistoryResponseSchema.parse({policyVersion:'comparison-history-v1',checkedAt,minimumMaps:minimumComparisonHistory,options:comparisonHistoryOptions,groups});
 }
}
export function registerComparisonHistory(app:FastifyInstance,service:ComparisonHistoryService){
 for(const method of ['GET','POST'] as const)app.route({method,url:'/api/v1/players/comparison-history',config:{rateLimit:{max:method==='POST'?20:120,timeWindow:'1 minute'}},handler:async(req,reply)=>{
  const query=z.object({lineupA:z.string().max(100),lineupB:z.string().max(100),cutoffAt:z.iso.datetime().optional()}).strict().safeParse(req.query);
  const payload=method==='POST'?req.body:query.success?{...query.data,lineupA:query.data.lineupA.split(','),lineupB:query.data.lineupB.split(',')}:null;
  const parsed=ComparisonHistoryRequestSchema.safeParse(payload);
  if(!parsed.success||method==='POST'&&!z.object({}).strict().safeParse(req.query).success||parsed.data.cutoffAt&&Date.parse(parsed.data.cutoffAt)>Date.now())return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Выберите десять разных игроков и срез не в будущем.',requestId:req.id}});
  if(method==='POST'&&req.ownerSession?.role!=='owner')return reply.code(403).send({error:{code:'OWNER_REQUIRED',message:'Загрузку истории запускает только владелец.',requestId:req.id}});
  return service.read(req.ownerSession!.owner.id,parsed.data,method==='POST',req.ownerSession!.role==='owner');
 }});
}
