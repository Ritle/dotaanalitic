import {test,expect} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedDraft,draftInput} from '../../../../tests/helpers/draft';
import {ScenarioRepository} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,id:string;
test.beforeAll(async()=>{
 database=await testDatabase();await seedDraft(database.db);password=randomBytes(24).toString('base64url');
 const owner=await new AuthService(database.db).provision('synthetic-hero-fallback',password),q=draftInput();
 q.draft={assignments:[{teamSlot:'A',rolePos:1,heroId:1},{teamSlot:'B',rolePos:1,heroId:2}],bans:[{teamSlot:'B',heroId:3}]};
 id=(await new ScenarioRepository(database.db).save(owner.id,q)).id;
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
test('hero labels preserve IDs, blank/missing names, loaded choices through search/error, and frozen draft history',async({page})=>{
 let fail=false,searchCalls=0;
 await page.route('**/api/v1/heroes?*',async r=>{
  searchCalls++;if(fail){await r.fulfill({status:503,json:{error:{code:'SYNTHETIC_CATALOG_FAILURE'}}});return;}
  const response=await r.fetch(),d=await response.json();await r.fulfill({response,json:{...d,items:d.items.filter((h:{id:string})=>h.id!=='3').map((h:{id:string;name:string})=>h.id==='2'?{...h,name:' '}:h)}});
 });
 await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-hero-fallback');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();await page.goto('/scenarios/'+id);
 const editor=page.locator('#draftlab'),a=editor.getByRole('combobox',{name:'A: герой роли 1',exact:true}),b=editor.getByRole('combobox',{name:'B: герой роли 1',exact:true});
 await expect(editor.locator('[data-selected-hero="A:1"]')).toContainText('Synthetic Hero');await expect(editor.locator('[data-selected-hero="B:1"]')).toContainText('Герой без названия');
 const missing=editor.locator('[data-banned-hero="3"]');await expect(missing).toContainText('Название героя недоступно');await missing.getByText('Данные записи',{exact:true}).click();await expect(missing.getByText('Внутренний ID: 3',{exact:true})).toBeVisible();
 const frozen=(await(await page.request.get(`/api/v1/scenarios/${id}/history?offset=0`)).json()).items;
 const unsaved=page.getByText('Есть несохранённые изменения.',{exact:true});await expect(unsaved).toHaveCount(0);
 await editor.getByRole('searchbox').fill('synthetic-no-such-hero');await expect(editor.getByText('Герои по запросу не найдены.',{exact:false})).toBeVisible();
 await expect(a).toHaveValue('1');await expect(b).toHaveValue('2');await expect(a.locator('option:checked')).toHaveText('Synthetic Hero · ID 1');await expect(b.locator('option:checked')).toHaveText('Герой без названия · ID 2');await expect(unsaved).toHaveCount(0);
 fail=true;await editor.getByRole('searchbox').fill('synthetic-error');await expect(editor.getByRole('alert')).toBeVisible();await expect(editor.locator('[data-selected-hero="A:1"]')).toContainText('Synthetic Hero');
 const saved=page.waitForResponse(r=>r.url().endsWith('/api/v1/scenarios/'+id)&&r.request().method()==='PUT');await page.getByRole('button',{name:'Сохранить карту',exact:true}).click();const response=await saved;expect(response.status()).toBe(200);expect(response.request().postDataJSON().input.draft).toEqual({assignments:[{teamSlot:'A',rolePos:1,heroId:1},{teamSlot:'B',rolePos:1,heroId:2}],bans:[{teamSlot:'B',heroId:3}]});
 const history=(await(await page.request.get(`/api/v1/scenarios/${id}/history?offset=0`)).json()).items;expect(frozen).toHaveLength(1);expect(history).toContainEqual(frozen[0]);expect(searchCalls).toBe(3);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await editor.screenshot({path:'test-results/hero-fallback-mobile.png'});
});
