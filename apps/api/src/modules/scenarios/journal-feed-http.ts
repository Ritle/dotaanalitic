import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {V1JournalFeedCursorSchema} from '../../../../../packages/contracts/dist/journal/feed.js';
import {readV1JournalFeed} from '../../../../../packages/db/dist/journal/feed.js';
import type {Db} from '@dota/db';
const Query=z.union([z.object({}).strict(),V1JournalFeedCursorSchema]);
export function registerJournalFeed(app:FastifyInstance,db:Db){
  app.get('/api/v1/forecast-journal/current',async(req,reply)=>{
    const query=Query.safeParse(req.query);
    if(!query.success)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Некорректная страница журнала.',requestId:req.id}});
    try{return await readV1JournalFeed(db,req.ownerSession!.owner.id,'id' in query.data?query.data:null);}
    catch(error){if(error instanceof Error&&/integrity/.test(error.message))return reply.code(503).send({error:{code:'JOURNAL_INTEGRITY',message:'Не удалось проверить сохранённые расчёты.',requestId:req.id}});throw error;}
  });
}
