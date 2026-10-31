import type { FastifyInstance } from 'fastify';
import { CatalogIdSchema, CatalogQuerySchema } from '@dota/contracts';
import { CatalogRepository } from '@dota/db';

export function registerCatalog(app: FastifyInstance, repository: CatalogRepository) {
  for (const kind of ['teams','players','heroes'] as const) {
    app.get('/api/v1/'+kind, async (request,reply) => {
      const parsed=CatalogQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте строку поиска и страницу результатов.',requestId:request.id}});
      return repository.search(kind,parsed.data);
    });
  }
  for (const kind of ['teams','players'] as const) {
    app.get<{Params:{id:string}}>('/api/v1/'+kind+'/:id',async(request,reply)=>{
      const parsed=CatalogIdSchema.safeParse(request.params.id);
      if(!parsed.success) return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Некорректный идентификатор.',requestId:request.id}});
      const result=kind==='teams'?await repository.team(parsed.data):await repository.player(parsed.data);
      if(!result) return reply.code(404).send({error:{code:'NOT_FOUND',message:'Запись не найдена в локальном справочнике.',requestId:request.id}});
      return result;
    });
  }
}
