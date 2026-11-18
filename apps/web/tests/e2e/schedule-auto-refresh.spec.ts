import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {scheduleToken,syntheticSchedule,syntheticRosters} from '../../../../tests/helpers/upcoming';
import {syntheticPlayerHistory} from '../../../../tests/helpers/player-history';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,calls:number[],fail:boolean;
const auto=(page:Page)=>page.getByRole('checkbox',{name:'Автообновление расписания раз в 5 минут',exact:true});
const choose=(page:Page)=>page.getByRole('button',{name:'Выбрать',exact:true});
async function expire(number=1){
 if(number===1)await sql`UPDATE upcoming_source_cache SET expires_at=clock_timestamp()-interval '1 second',retry_at='-infinity' WHERE cache_key='schedule'`.execute(database.db);
 else await sql`UPDATE upcoming_page_cache SET expires_at=clock_timestamp()-interval '1 second',retry_at='-infinity' WHERE page=${number}`.execute(database.db);
 await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity',blocked_until='-infinity'`.execute(database.db);
}
test.beforeEach(async({page})=>{
 test.setTimeout(60000);database=await testDatabase();calls=[];fail=false;const password=randomBytes(24).toString('hex');
 await new AuthService(database.db).provision('synthetic-auto-schedule',password);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:scheduleToken}),{
  db:database.db,logger:false,catalogueProvider:async()=>{throw Error('Synthetic catalogue unavailable');},playerHistoryProvider:()=>syntheticPlayerHistory({mode:'empty'}),pandascoreFetch:async url=>{
   if(url.pathname.endsWith('/rosters'))return new Response(JSON.stringify(syntheticRosters()));
   const number=Number(url.searchParams.get('page'));calls.push(number);if(fail)return new Response('{}',{status:403});
   return new Response(JSON.stringify(Array.from({length:20},(_,i)=>({...syntheticSchedule()[0],id:number*10000+i+1,
    scheduled_at:new Date(Date.now()+7*86400000).toISOString(),league:{...syntheticSchedule()[0]!.league,name:'Synthetic automatic calendar '+calls.length}}))));
  }});
 await api.listen({host:'127.0.0.1',port:3151});await page.clock.install({time:new Date()});await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-auto-schedule');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Предстоящие матчи →'}).click();
 await expect(choose(page)).toHaveCount(20);await expect(page.getByRole('button',{name:'Обновить расписание',exact:true})).toBeEnabled();
});
test.afterEach(async()=>{await api?.close();await database?.close();});
test('opens automatically, refreshes only after five minutes, and two tabs share the server lease/cache',async({page,browser})=>{
 expect(calls).toEqual([1]);await page.clock.fastForward(299000);expect(calls).toEqual([1]);
 // Simulate the server cache nearing expiry too; browser virtual time does not advance PostgreSQL's clock.
 await sql`UPDATE upcoming_source_cache SET expires_at=clock_timestamp()+interval '60 seconds' WHERE cache_key='schedule'`.execute(database.db);
 await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();await expect(page.getByRole('button',{name:'Обновить расписание',exact:true})).toBeEnabled();expect(calls).toEqual([1]);
 const otherContext=await browser.newContext();await otherContext.addCookies(await page.context().cookies());const other=await otherContext.newPage();await other.clock.install({time:new Date()});await other.goto('http://127.0.0.1:5179/upcoming');await expect(choose(other)).toHaveCount(20);
 await expire();await Promise.all([page.clock.fastForward(61000),other.clock.fastForward(61000)]);await expect.poll(()=>calls.length).toBe(2);expect(calls).toEqual([1,1]);
 await expect(page.getByRole('button',{name:'Обновить расписание',exact:true})).toBeEnabled();await expect(other.getByRole('button',{name:'Обновить расписание',exact:true})).toBeEnabled();
 await Promise.all([page.clock.fastForward(31000),other.clock.fastForward(31000)]);
 await expect(page.getByRole('table')).toContainText('Synthetic automatic calendar 2');expect(calls).toEqual([1,1]);await otherContext.close();
});
test('selection pauses work and preserves draft input; closing, toggle and visibility control refresh',async({page})=>{
 await choose(page).first().click();await expect(page.getByRole('button',{name:'Закрыть встречу',exact:true})).toBeVisible();
 await page.getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();const title=page.getByLabel('Название сценария',{exact:true});await title.fill('Synthetic unsaved selection');
 await expect(page.getByRole('button',{name:'Обновить составы',exact:true})).toBeEnabled();await expire();await page.clock.fastForward(601000);expect(calls).toEqual([1]);await expect(title).toHaveValue('Synthetic unsaved selection');await expect(page.getByText('Автообновление на паузе, пока открыта встреча.',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Закрыть встречу',exact:true}).click();await expect.poll(()=>calls.length).toBe(2);
 await auto(page).uncheck();await expire();await page.clock.fastForward(301000);expect(calls).toHaveLength(2);await auto(page).check();await expect.poll(()=>calls.length).toBe(3);
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));});await expire();await page.clock.fastForward(301000);expect(calls).toHaveLength(3);
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});await expect.poll(()=>calls.length).toBe(4);
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.tools/schedule-auto-refresh-20261112/mobile.png'});
});
test('updates only the current page and preserves cached matches with bounded retries on source failure',async({page})=>{
 await page.getByRole('button',{name:'Следующая страница',exact:true}).click();await expect(page.getByText('Страница 2',{exact:true})).toBeVisible();expect(calls).toEqual([1,2]);
 await expire(2);fail=true;await page.clock.fastForward(301000);await expect.poll(()=>calls.length).toBe(3);await expect(page.getByText('Не удалось обновить источник. Сохранённые данные показаны ниже.',{exact:true})).toBeVisible();await expect(choose(page)).toHaveCount(20);
 await page.clock.fastForward(61000);expect(calls).toEqual([1,2,2]);fail=false;await expire(2);await page.clock.fastForward(241000);await expect.poll(()=>calls.length).toBe(4);expect(calls).toEqual([1,2,2,2]);await expect(choose(page)).toHaveCount(20);
});
