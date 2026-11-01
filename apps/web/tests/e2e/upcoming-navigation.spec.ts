import {test,expect} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedCatalog} from '../../../../tests/helpers/catalog';
import {scheduleToken,syntheticSchedule,syntheticRosters} from '../../../../tests/helpers/upcoming';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
test.beforeAll(async()=>{
  database=await testDatabase();await seedCatalog(database.db);password=randomBytes(24).toString('base64url');
  await new AuthService(database.db).provision('synthetic-navigation-browser',password);
  const row=syntheticSchedule()[0]!,schedule=Array.from({length:20},(_,i)=>({...row,id:70001+i,name:`Синтетическая встреча навигации ${i+1}`}));
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:scheduleToken}),
    {db:database.db,logger:false,pandascoreFetch:async url=>new Response(JSON.stringify(url.pathname.endsWith('/rosters')?syntheticRosters():schedule))});
  await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
test('mobile and keyboard selection move focus and viewport to the chosen match below a full schedule',async({page})=>{
  await page.setViewportSize({width:360,height:800});await page.goto('/upcoming');
  await page.getByLabel('Логин').fill('synthetic-navigation-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Предстоящие матчи →'}).click();
  await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();
  const buttons=page.getByRole('button',{name:'Выбрать',exact:true});await expect(buttons).toHaveCount(20);
  const panel=page.getByRole('region',{name:'Ожидаемые составы',exact:true});
  await buttons.first().click();await expect(panel).toBeFocused();
  await expect(panel.getByRole('heading',{name:'Синтетическая встреча навигации 1',exact:true})).toBeVisible();
  expect(Math.abs((await panel.boundingBox())!.y)).toBeLessThan(2);
  await page.screenshot({path:'test-results/upcoming-selection-mobile.png'});
  await buttons.nth(1).focus();await buttons.nth(1).press('Enter');await expect(panel).toBeFocused();
  await expect(panel.getByRole('heading',{name:'Синтетическая встреча навигации 2',exact:true})).toBeVisible();
  expect(Math.abs((await panel.boundingBox())!.y)).toBeLessThan(2);
  await panel.getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();
  for(const label of ['Команда A в локальной базе','Команда B в локальной базе'])await expect(panel.getByRole('region',{name:label,exact:true}).getByRole('searchbox')).toHaveValue('');
  await expect(panel.getByRole('button',{name:'Создать ручной сценарий',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
