import {beforeAll,afterAll,test,expect} from 'vitest';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {sql} from '@dota/db';
import {SeriesForecastReadinessSchema} from '../../../packages/contracts/dist/series/forecast.js';
import {testDatabase} from '../../../tests/helpers/postgres';
import {publishTargetSchedule,syntheticTargetMatch} from '../../../tests/helpers/schedule-target';
import {buildApp} from '../src/app';
import {readConfig} from '../src/config';
import {AuthService} from '../src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,fetches=0;
beforeAll(async()=>{
 database=await testDatabase();const password=randomBytes(24).toString('hex');await new AuthService(database.db).provision('synthetic-series',password);
 await publishTargetSchedule(database.db,[syntheticTargetMatch({providerMatchId:'901',seriesBestOf:3}),syntheticTargetMatch({providerMatchId:'902',seriesBestOf:2}),syntheticTargetMatch({providerMatchId:'903',seriesBestOf:null})]);
 app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false,pandascoreFetch:async()=>{fetches++;throw Error('unexpected_source_request');}});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-series',password}});
 const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');
},60000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
const path=(id:string)=>'/api/v1/upcoming/'+id+'/series-forecast/readiness';
test('series gate is separate, authenticated and read-only; map readiness cannot issue series probability',async()=>{
 expect((await app.inject({url:path('901')})).statusCode).toBe(401);
 expect((await app.inject({url:path('901')+'?probability=0.7',headers:{cookie}})).statusCode).toBe(400);
 const result=await app.inject({url:path('901'),headers:{cookie}});expect(result.statusCode).toBe(200);
 expect(SeriesForecastReadinessSchema.parse(result.json())).toMatchObject({targetUnit:'series',bestOf:3,status:'unavailable',teamAWinProbability:null,modelVersion:null,reasons:['SERIES_MODEL_NOT_VALIDATED']});
 expect(fetches).toBe(0);
 for(const table of ['prediction_runs','upcoming_forecast_preparations','v1_schedule_targets'])expect((await sql`SELECT 1 FROM ${sql.table(table)}`.execute(database.db)).rows).toHaveLength(0);
});
test('unknown format, BO2 and missing schedule never silently become BO3',async()=>{
 for(const [id,reason] of [['902','SERIES_FORMAT_UNSUPPORTED'],['903','SERIES_FORMAT_UNKNOWN'],['999','SERIES_SCHEDULE_UNAVAILABLE']]){
  const result=await app.inject({url:path(id!),headers:{cookie}});expect(result.statusCode).toBe(200);expect(result.json().reasons).toContain(reason);expect(result.json().teamAWinProbability).toBeNull();
 }
 expect(fetches).toBe(0);
});
