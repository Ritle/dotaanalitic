import {test,expect} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {syntheticSchedule,scheduleToken} from '../../../../tests/helpers/upcoming';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,calls:number,mode:'normal'|'failed'|'empty';
test.beforeEach(async({page})=>{
 test.setTimeout(60000);database=await testDatabase();calls=0;mode='normal';const password=randomBytes(20).toString('hex');await new AuthService(database.db).provision('synthetic-live-ui',password);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:scheduleToken}),{db:database.db,logger:false,pandascoreFetch:async url=>{
  expect(url.pathname).toBe('/dota2/matches/running');calls++;if(mode==='failed')return new Response('{}',{status:403});
  const m=syntheticSchedule()[0]!;
  return new Response(JSON.stringify(mode==='empty'?[]:[{...m,status:'running',results:[{team_id:74002,score:0},{team_id:74001,score:1}]},
   {...m,id:70002,tournament:{id:71002,name:'Другая группа'},opponents:m.opponents.slice(0,1),status:'running',results:[]},
   {...m,id:70003,status:'finished'}]));
 }});
 await api.listen({host:'127.0.0.1',port:3151});await page.clock.install({time:new Date()});await page.goto('/live');await page.getByLabel('Логин').fill('synthetic-live-ui');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Live — матчи сейчас →'}).click();
 await expect(page.locator('.live-card')).toHaveCount(2);
});
test.afterEach(async()=>{await api?.close();await database?.close();});
const expire=async()=>{await sql`UPDATE live_schedule_cache SET expires_at=clock_timestamp()-interval '1 second',retry_at='-infinity'`.execute(database.db);await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity',blocked_until='-infinity'`.execute(database.db);};
test('live cards show series score, unknown participant and all groups, with no forecast action and no mobile overflow',async({page})=>{
 await expect(page.getByRole('heading',{name:'Матчи сейчас',exact:true})).toBeVisible();await expect(page.getByText('1 : 0',{exact:true})).toBeVisible();await expect(page.getByText('Нет данных',{exact:true})).toBeVisible();
 const labs=page.getByRole('link',{name:'Открыть Draft Lab'});
 await expect(labs).toHaveCount(2);
 await expect(labs.first()).toHaveAttribute('href','/live/70001/draft');
 await expect(labs.last()).toHaveAttribute('href','/live/70002/draft');
 expect(await page.getByLabel('Турнир',{exact:true}).locator('option').count()).toBe(2);await expect(page.getByRole('button',{name:/Получить прогноз/})).toHaveCount(0);
 expect(calls).toBe(1);await page.getByRole('button',{name:'Обновить Live',exact:true}).click();await expect(page.getByRole('button',{name:'Обновить Live',exact:true})).toBeEnabled();expect(calls).toBe(1);
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.tools/live-20261113/mobile.png',fullPage:true});
 await page.getByRole('checkbox',{name:'Автообновление раз в минуту'}).uncheck();await page.clock.fastForward(75000);await expect(page.getByText('Данные устарели: показан последний известный статус, матчи могли завершиться.')).toBeVisible();expect(calls).toBe(1);
});
test('partial Live matchup opens manual roles without assigning the sole team to a side',async({page})=>{
 await page.locator('.live-card').last().getByRole('link',{name:'Открыть Draft Lab'}).click();
 await expect(page.getByText(/Участники ещё не определены/)).toBeVisible();
 const lab=page.getByRole('region',{name:'Драфт Live-карты'});
 await expect(lab.getByRole('group',{name:'Герои A',exact:true})).toBeVisible();
 await expect(lab.getByRole('group',{name:'Герои B',exact:true})).toBeVisible();
 await expect(lab.getByRole('button',{name:'Сохранить карту'})).toBeDisabled();
});
test('automatic refresh respects cooldown, retains stale cards on failure, then replaces completed series with empty list',async({page})=>{
 await expire();mode='failed';await page.clock.fastForward(61000);await expect.poll(()=>calls).toBe(2);await expect(page.getByText('Не удалось обновить источник. Сохранённые данные могут быть устаревшими.')).toBeVisible();await expect(page.locator('.live-card')).toHaveCount(2);
 await page.clock.fastForward(30000);expect(calls).toBe(2);await expire();mode='empty';await page.clock.fastForward(61000);await expect.poll(()=>calls).toBe(3);await expect(page.locator('.live-card')).toHaveCount(0);await expect(page.getByText('Источник не сообщил о текущих матчах.')).toBeVisible();
});
