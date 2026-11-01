import {HistoryRefreshRepository,historyRun,type Db} from '@dota/db';
import {HistoryRefreshResponseSchema,CatalogIdSchema} from '@dota/contracts';
import {createHistoryQueue,enqueueHistoryRefresh,HISTORY_QUEUE} from '@dota/ingestion';
export class HistoryRefreshService{
  private readonly repo:HistoryRefreshRepository;
  private queue:ReturnType<typeof createHistoryQueue>|undefined;
  constructor(db:Db,private readonly connection:string){this.repo=new HistoryRefreshRepository(db);}
  private boss(){return this.queue??=createHistoryQueue(this.connection).catch(e=>{this.queue=undefined;throw e;});}
  async close(){await (await this.queue)?.stop({graceful:true,timeout:10000});}
  async read(owner:string,teamId:string){
    const team=await this.repo.team(teamId);if(!team)return null;
    let row=await this.repo.latest(owner,teamId);
    if(row&&(row.status==='queued'||row.status==='running')){
      const job=await (await this.boss()).getJobById(HISTORY_QUEUE,row.id);
      if(!job||['completed','failed','cancelled'].includes(job.state)){
        await this.repo.abandoned(row.id);row=await this.repo.latest(owner,teamId);
      }
    }
    const available=CatalogIdSchema.safeParse(team.opendota_team_id).success,run=row?historyRun(row):null;
    const messages={queued:'Обновление в очереди. Ожидаем обработку.',running:'Загружаем и проверяем завершённые профессиональные карты.',
      completed:'Обновление завершено. Описательная статистика перечитана.',partial:'Обновление завершено частично. Проверьте объём и ошибки.',
      error:'Не удалось завершить обновление. Повторите после указанного времени.'};
    return HistoryRefreshResponseSchema.parse({teamId,available,run,
      retryAt:row&&row.next_allowed_at.getTime()>Date.now()?row.next_allowed_at.toISOString():null,
      message:!available?'У организации нет подтверждённого числового ID OpenDota.':run?messages[run.status]:'Можно загрузить до 10 последних завершённых pro-карт организации.'});
  }
  async refresh(owner:string,teamId:string){
    const before=await this.read(owner,teamId);if(!before||!before.available)return before;
    await enqueueHistoryRefresh(await this.boss(),this.repo.db,owner,teamId);return this.read(owner,teamId);
  }
}
