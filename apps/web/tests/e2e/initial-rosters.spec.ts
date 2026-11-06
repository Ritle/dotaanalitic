import {test,expect} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedTargetCatalog,publishTargetSchedule,syntheticTargetMatch} from '../../../../tests/helpers/schedule-target';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,calls=0,forbidden=false;
const team={providerTeamId:'137540',name:'Синтетическая Academy'};
const match=(id:string)=>syntheticTargetMatch({providerMatchId:id,tournament:{providerTournamentId:'22347',name:'Synthetic group'},
 opponents:[team,{providerTeamId:'139239',name:'Синтетический соперник'}]});
const roster={type:'Team',rosters:[{id:137540,name:team.name,players:Array.from({length:5},(_,i)=>({id:800+i,name:'Синтетический игрок '+(i+1)}))},
 {id:139239,name:'Синтетический соперник',players:[]}]};
test.beforeEach(async({page})=>{
 database=await testDatabase();await seedTargetCatalog(database.db);await publishTargetSchedule(database.db,[match('1'),match('2')]);calls=0;forbidden=false;
 const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-initial-rosters',password);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:'synthetic-rosters-token'}),
  {db:database.db,logger:false,catalogueProvider:async()=>{throw Error('Synthetic catalogue unavailable');},pandascoreFetch:async url=>{expect(url.pathname).toBe('/tournaments/22347/rosters');calls++;
    return Response.json(forbidden?{error:'synthetic forbidden'}:roster,{status:forbidden?403:200});}});
 await api.listen({host:'127.0.0.1',port:3151});await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-initial-rosters');await page.getByLabel('Пароль').fill(password);
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/auth/login')),page.getByRole('button',{name:'Войти',exact:true}).click()]);
 await page.getByRole('link',{name:'Предстоящие матчи →',exact:true}).click();
});
test.afterEach(async()=>{await api?.close();await database?.close();});
test('first selection loads a missing tournament roster once; selecting another match in the same tournament reuses it',async({page})=>{
 const rows=page.getByRole('row').filter({hasText:team.name});await expect(rows).toHaveCount(2);expect(calls).toBe(0);
 await rows.first().getByRole('button',{name:'Выбрать',exact:true}).click();
 const panel=page.getByRole('region',{name:'Ожидаемые составы',exact:true});
 const source=panel.locator('details').filter({has:page.getByText('Заявка турнира и участники источника',{exact:true})});
 const revealSource=async()=>{if(await source.getAttribute('open')===null)await source.locator('summary').click();};
 await revealSource();
 await expect(panel.getByText('Синтетический игрок 1',{exact:true})).toBeVisible();await expect(panel.getByText('В заявке: 5 игроков',{exact:true})).toBeVisible();expect(calls).toBe(1);
 await rows.last().getByRole('button',{name:'Выбрать',exact:true}).click();await revealSource();await expect(panel.getByText('Синтетический игрок 5',{exact:true})).toBeVisible();
 await expect(panel.getByRole('button',{name:'Обновить составы',exact:true})).toBeEnabled();expect(calls).toBe(1);
});
test('failed first roster fetch stays explicit and does not retry when selecting another match',async({page})=>{
 forbidden=true;const rows=page.getByRole('row').filter({hasText:team.name});await rows.first().getByRole('button',{name:'Выбрать',exact:true}).click();
 const panel=page.getByRole('region',{name:'Ожидаемые составы',exact:true});
 await expect(panel.getByText('Не удалось обновить источник. Сохранённые данные показаны ниже.',{exact:true})).toBeVisible();expect(calls).toBe(1);
 await expect(panel.getByText('Заявка ещё не загружена или отсутствует у источника.',{exact:true})).toHaveCount(2);
 await rows.last().getByRole('button',{name:'Выбрать',exact:true}).click();await expect(panel.getByText('Не удалось обновить источник. Сохранённые данные показаны ниже.',{exact:true})).toBeVisible();
 await expect(panel.getByRole('button',{name:'Обновить составы',exact:true})).toBeEnabled();expect(calls).toBe(1);
});
