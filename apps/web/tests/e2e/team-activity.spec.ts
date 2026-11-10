import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedProMaps} from '../../../../tests/helpers/pro-maps';
import {catalogTeamId} from '../../../../tests/helpers/catalog';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
import {sql} from '../../../../packages/db/src/index';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
test.beforeEach(async()=>{database=await testDatabase();await seedProMaps(database.db);password=randomBytes(24).toString('base64url');
 await new AuthService(database.db).provision('synthetic-activity-ui',password);api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});await api.listen({host:'127.0.0.1',port:3151});});
test.afterEach(async()=>{await api?.close();await database?.close();});
async function login(page:Page){await page.goto('/login');await page.getByLabel('Логин',{exact:true}).fill('synthetic-activity-ui');await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('heading',{name:'Справочники',exact:true}).waitFor();}
const activity=(page:Page)=>page.getByRole('region',{name:'Активность команды',exact:true});
async function edit(page:Page){await activity(page).getByText('Изменить статус команды',{exact:true}).click();await expect(activity(page).getByRole('combobox',{name:'Статус',exact:true})).toBeVisible();}
test('owner archive filters the directory without hiding history; unknown restores it and preserves revisions',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await login(page);await page.goto('/teams/'+catalogTeamId);
 await expect(activity(page)).toContainText('Нет подтверждённой отметки');await edit(page);
 await activity(page).getByRole('combobox',{name:'Статус',exact:true}).selectOption('inactive');await activity(page).getByLabel('Пояснение',{exact:true}).fill('Synthetic owner preference');
 await activity(page).getByRole('button',{name:'Сохранить статус',exact:true}).click();await expect(activity(page)).toContainText('Команда находится в архиве');
 await expect(page.getByRole('heading',{name:'Последний наблюдавшийся состав',exact:true})).toBeVisible();await page.reload();await expect(activity(page)).toContainText('решение владельца');
 await page.goto('/');await expect(page.locator(`a[href="/teams/${catalogTeamId}"]`)).toHaveCount(0);
 await page.getByRole('combobox',{name:'Показывать команды',exact:true}).selectOption('archived');await expect(page.locator(`a[href="/teams/${catalogTeamId}"]`)).toBeVisible();
 await page.locator(`a[href="/teams/${catalogTeamId}"]`).click();await edit(page);await activity(page).getByRole('combobox',{name:'Статус',exact:true}).selectOption('unknown');await activity(page).getByLabel('Пояснение',{exact:true}).fill('Synthetic status needs review');
 await activity(page).getByRole('button',{name:'Сохранить статус',exact:true}).click();await expect(activity(page)).toContainText('Команда остаётся в обычном списке');
 await activity(page).getByText('История отметок',{exact:true}).click();await expect(activity(page).getByRole('listitem')).toHaveCount(2);
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await activity(page).screenshot({path:'test-results/team-activity-mobile.png'});
 await page.goto('/');await expect(page.locator(`a[href="/teams/${catalogTeamId}"]`)).toBeVisible();expect(errors).toEqual([]);
});
test('source review rejects future checks, preserves source and permits explicit archive selection',async({page})=>{
 await login(page);await page.goto('/teams/'+catalogTeamId);await edit(page);const card=activity(page);
 await card.getByRole('combobox',{name:'Статус',exact:true}).selectOption('inactive');await card.getByRole('combobox',{name:'Основание',exact:true}).selectOption('source');
 await card.getByLabel('Ссылка на источник',{exact:true}).fill('https://example.com/synthetic');await card.getByLabel('Пояснение',{exact:true}).fill('Synthetic <b>source</b> review');
 await card.getByLabel('Когда проверено основание',{exact:true}).fill('2999-01-01T00:00');await card.getByRole('button',{name:'Сохранить статус',exact:true}).click();await expect(card.getByRole('alert')).toContainText('будущем');
 await card.getByLabel('Когда проверено основание',{exact:true}).fill('2026-01-01T00:00');await card.getByRole('button',{name:'Сохранить статус',exact:true}).click();await expect(card).toContainText('Команда находится в архиве');
 await page.reload();await expect(card.getByRole('link',{name:'Источник отметки',exact:true})).toHaveAttribute('href','https://example.com/synthetic');await expect(card).toContainText('Synthetic <b>source</b> review');
 await page.goto('/compare');const picker=page.getByRole('region',{name:'Команда A: поиск по названию',exact:true});
 await picker.getByRole('searchbox').fill('Synthetic Aurora');await picker.getByRole('button',{name:'Найти',exact:true}).click();
 const choose=picker.locator(`button[data-catalog-id="${catalogTeamId}"]`);await expect(choose).toHaveCount(0);
 await picker.getByLabel('Искать также в архиве команд',{exact:true}).check();await expect(choose).toBeVisible();await choose.click();await expect(picker.getByRole('status')).toContainText('Выбрано: Synthetic Aurora');
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM prediction_runs`.execute(database.db)).rows[0]!.n).toBe(0);
});
