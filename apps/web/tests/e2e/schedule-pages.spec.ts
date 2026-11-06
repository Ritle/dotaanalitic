import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedStrength} from '../../../../tests/helpers/strength';
import {scenarioInput} from '../../../../tests/helpers/scenario';
import {scheduleToken,syntheticSchedule,syntheticRosters} from '../../../../tests/helpers/upcoming';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,calls:number[],fail:boolean;
const next=(page:Page)=>page.getByRole('button',{name:'Следующая страница',exact:true});
const previous=(page:Page)=>page.getByRole('button',{name:'Предыдущая страница',exact:true});
const panel=(page:Page)=>page.getByRole('region',{name:'Ожидаемые составы',exact:true});
test.beforeEach(async({page})=>{
 database=await testDatabase();await seedStrength(database.db);calls=[];fail=false;
 const password=randomBytes(24).toString('hex');await new AuthService(database.db).provision('synthetic-pages-browser',password);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:scheduleToken}),{
  db:database.db,logger:false,catalogueProvider:async()=>{throw Error('Synthetic catalogue unavailable');},pandascoreFetch:async url=>{
   if(url.pathname.endsWith('/rosters'))return new Response(JSON.stringify(syntheticRosters()));
   const number=Number(url.searchParams.get('page'));calls.push(number);
   const rows=number===3?[]:Array.from({length:20},(_,i)=>({...syntheticSchedule()[0],id:number*10000+i+1,name:`Synthetic page ${number} match ${i+1}`,
    tournament:{id:71000+number,name:`Synthetic page ${number} tournament`},opponents:[{type:'Team',opponent:{id:74001,name:`Synthetic page ${number} A${i+1}`}},{type:'Team',opponent:{id:74002,name:'Synthetic rival'}}]}));
   return new Response(JSON.stringify(fail?{}:rows),{status:fail?403:200});
  }});
 await api.listen({host:'127.0.0.1',port:3151});await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-pages-browser');await page.getByLabel('Пароль').fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Предстоящие матчи →',exact:true}).click();
 await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();await expect(next(page)).toBeEnabled();
});
test.afterEach(async()=>{await api?.close();await database?.close();});
test('explicit page navigation loads once, returns from empty end, reuses server cache and stays within the page filter',async({page})=>{
 expect(calls).toEqual([1]);await expect(previous(page)).toBeDisabled();
 await next(page).click();await expect(page.getByText('Страница 2',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Выбрать',exact:true})).toHaveCount(20);
 await page.getByLabel('Турнир в сохранённом расписании',{exact:true}).selectOption('71002');
 await previous(page).click();await expect(page.getByText('Страница 1',{exact:true})).toBeVisible();await expect(page.getByLabel('Турнир в сохранённом расписании',{exact:true})).toHaveValue('');
 await next(page).click();await expect(page.getByText('Страница 2',{exact:true})).toBeVisible();expect(calls).toEqual([1,2]);
 await next(page).click();await expect(page.getByText('Страница 3',{exact:true})).toBeVisible();await expect(next(page)).toBeDisabled();
 await expect(page.getByText('На этой странице предстоящих встреч нет.',{exact:false})).toBeVisible();
 await previous(page).click();await expect(page.getByText('Страница 2',{exact:true})).toBeVisible();expect(calls).toEqual([1,2,3]);
 await page.reload();await expect(next(page)).toBeEnabled();await next(page).click();await expect(page.getByText('Страница 2',{exact:true})).toBeVisible();expect(calls).toEqual([1,2,3]);
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('navigation',{name:'Страницы расписания',exact:true}).screenshot({path:'test-results/schedule-pages-mobile.png'});
});
async function pick(page:Page,label:string,id:string){
 const field=page.getByRole('region',{name:label,exact:true});await field.getByRole('searchbox').fill(id);await field.getByRole('searchbox').press('Enter');
 await field.getByRole('button',{name:new RegExp(' · ID '+id+'$')}).click();
}
test('page-two match loads its roster, supports confirmed comparison and clears the unsaved form on page changes',async({page})=>{
 await next(page).click();await expect(page.getByText('Страница 2',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Выбрать',exact:true}).first().click();
  await expect(panel(page).getByText('Зафиксировать назначение первой карты',{exact:true})).toBeVisible();
 await expect(panel(page).getByText('Получено:',{exact:false})).toBeVisible();
 await panel(page).getByText('Заявка турнира и участники источника',{exact:true}).click();
 await expect(panel(page).getByText('В заявке: 6 игроков',{exact:true})).toBeVisible();
 await panel(page).getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();const q=scenarioInput();
 await pick(page,'Команда A в локальной базе',q.teamAId);await pick(page,'Команда B в локальной базе',q.teamBId);
 for(const [slot,line] of [['A',q.lineupA],['B',q.lineupB]] as const)for(const p of line)await pick(page,`${slot}: игрок роли ${p.rolePos}`,p.playerId!);
 await page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true}).check();
 await page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true}).click();
 await expect(page.getByRole('region',{name:'Результат сравнения пятёрок',exact:true})).toBeVisible();
 await previous(page).click();await expect(panel(page)).toHaveCount(0);await next(page).click();
 await expect(page.getByText('Страница 2',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Выбрать',exact:true}).first().click();
 await expect(page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true})).not.toBeChecked();
 await expect(page.getByRole('region',{name:'Результат сравнения пятёрок',exact:true})).toHaveCount(0);
 expect((await sql`SELECT id FROM scenarios`.execute(database.db)).rows).toHaveLength(0);
});

test('page-two first-map assignment saves its real source and refreshes only that page',async({page})=>{
 await next(page).click();await expect(page.getByText('Страница 2',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Выбрать',exact:true}).first().click();
 await page.getByText('Зафиксировать назначение первой карты',{exact:true}).click();
 await expect(page.getByRole('region',{name:'Свежесть расписания'})).toContainText('страница 2');
 await page.getByLabel('Участник источника для команды A',{exact:true}).selectOption('74001');
 const q=scenarioInput();await pick(page,'Назначение: локальная команда A',q.teamAId);await pick(page,'Назначение: локальная команда B',q.teamBId);
 await page.getByLabel('Источник сопоставления · HTTPS',{exact:true}).fill('https://example.test/synthetic-pages');
 await page.getByLabel('Обоснование сопоставления',{exact:true}).fill('Синтетическая проверка сопоставления двух разных команд');
 await page.getByLabel('Подтверждаю соответствие участников и назначение карты 1',{exact:true}).check();
 await page.getByRole('button',{name:'Сохранить назначение карты 1',exact:true}).click();
 await page.getByRole('link',{name:'Открыть сохранённое назначение →',exact:true}).click();
 await expect(page.getByRole('article',{name:'Сохранённое назначение карты'})).toBeVisible();
 await expect(page.getByRole('region',{name:'Свежесть расписания'})).toContainText('страница 2');
 await sql`UPDATE upcoming_page_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity'`.execute(database.db);
 await page.reload();await page.getByRole('button',{name:'Обновить расписание перед прогнозом',exact:true}).click();
 await expect.poll(()=>calls).toEqual([1,2,2]);
 const records=(await sql<{record_text:string}>`SELECT record_text FROM v1_schedule_targets`.execute(database.db)).rows;
 expect(records).toHaveLength(1);expect(JSON.parse(records[0]!.record_text).observation.endpoint).toContain('page=2&');
 expect((await sql`SELECT * FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/page-two-target-mobile.png',fullPage:true});
});
test('a failed explicit refresh keeps the selected page and cached matches without repeated provider requests',async({page})=>{
 await next(page).click();await expect(page.getByText('Страница 2',{exact:true})).toBeVisible();
 await sql`UPDATE upcoming_page_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity'`.execute(database.db);fail=true;
 await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();
 await expect(page.getByText('Сохранённое расписание устарело.',{exact:false})).toBeVisible();
 await expect(page.getByText('Страница 2',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Выбрать',exact:true})).toHaveCount(20);
 await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();await expect(page.getByText('Обновить расписание',{exact:true})).toBeEnabled();expect(calls).toEqual([1,2,2]);
});
