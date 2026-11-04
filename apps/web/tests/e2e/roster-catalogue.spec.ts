import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {sql} from '../../../../packages/db/dist/index.js';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {syntheticSchedule,syntheticRosters,scheduleToken} from '../../../../tests/helpers/upcoming';
import {syntheticCatalogue} from '../../../../tests/helpers/roster-catalogue';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
const source=syntheticCatalogue();
test.beforeAll(async()=>{
 database=await testDatabase();password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-catalogue-ui',password);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:scheduleToken}),{
  db:database.db,logger:false,catalogueProvider:source.provider,pandascoreFetch:async url=>new Response(JSON.stringify(url.pathname.endsWith('/rosters')?syntheticRosters():syntheticSchedule()))});
 await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
async function sourcePick(page:Page,label:string,id:string){const field=page.getByRole('region',{name:label,exact:true});
 await field.getByRole('searchbox').fill(id);await field.getByRole('button',{name:'Найти в OpenDota',exact:true}).click();
 await field.getByRole('button',{name:new RegExp(' · ID '+id+'$')}).click();
}
test('expected roster to explicit numeric catalogue, manual scenario and saved reuse without provider spam',async({page})=>{
 test.setTimeout(90000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-catalogue-ui');await page.getByLabel('Пароль').fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Предстоящие матчи →'}).click();
 await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
 await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();
 const a=page.getByRole('region',{name:'Соединение A',exact:true});
 await expect(a.getByText('Выбрано участников: 0 / 5.',{exact:true})).toBeVisible();
 await sourcePick(page,'Команда OpenDota A','71');
 for(let i=0;i<5;i++){
  await a.getByLabel(`Синтетический игрок 1-${i+1} — включить в пятёрку`,{exact:true}).check();
  await sourcePick(page,`Аккаунт Синтетический игрок 1-${i+1} (A)`,String(1001+i));
 }
 await expect(a.getByRole('button',{name:'Сохранить связи и подставить пятёрку A',exact:true})).toBeDisabled();
 await a.getByLabel('Подтверждаю соответствие команды и пяти аккаунтов A',{exact:true}).check();
 await a.getByRole('button',{name:'Сохранить связи и подставить пятёрку A',exact:true}).click();
 await expect(page.getByRole('region',{name:'Команда A в локальной базе',exact:true})).toContainText('Выбрано: Synthetic Alpha');
 await expect(a).toContainText('локальных pro-карт: 0');
 await sourcePick(page,'Команда OpenDota B','72');
 for(let i=0;i<5;i++)await sourcePick(page,`Аккаунт Синтетический игрок 2-${i+1} (B)`,String(1007+i));
 await page.getByLabel('Подтверждаю соответствие команды и пяти аккаунтов B',{exact:true}).check();
 await page.getByRole('button',{name:'Сохранить связи и подставить пятёрку B',exact:true}).click();
 await expect(page.getByRole('region',{name:'Команда B в локальной базе',exact:true})).toContainText('Выбрано: Synthetic Beta');
 const confirm=page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true});await expect(confirm).not.toBeChecked();
 await confirm.check();await expect(page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Создать ручной сценарий',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Сценарий · редакция 1',exact:true})).toBeVisible();
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM players`.execute(database.db)).rows[0]!.n).toBe(10);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM expected_roster_catalogue_bindings`.execute(database.db)).rows[0]!.n).toBe(2);
 expect(source.calls).toEqual(['registry','team:71','team:72']);
 await page.goto('/upcoming');await page.getByRole('button',{name:'Выбрать',exact:true}).click();await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();
 await page.getByRole('button',{name:'Подставить сохранённую пятёрку A',exact:true}).click();
 const first=page.getByRole('region',{name:'A: игрок роли 1',exact:true});await expect(first).toContainText('Synthetic Twin');
 await first.getByRole('button',{name:'Сбросить',exact:true}).click();await page.getByRole('button',{name:'Перечитать связи',exact:true}).click();
 await expect(first.getByRole('status')).toHaveCount(0);expect(source.calls).toHaveLength(3);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('region',{name:'Подготовка составов из заявки',exact:true}).screenshot({path:'test-results/roster-catalogue-mobile.png'});
 expect(errors).toEqual([]);
});
