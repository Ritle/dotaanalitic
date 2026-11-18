import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedDraft,draftInput,draftRule} from '../../../../tests/helpers/draft';
import {sql,ScenarioRepository} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,owner:string,id:string;
const league='9007199254742999';
test.beforeAll(async()=>{
 database=await testDatabase();await seedDraft(database.db);await draftRule(database.db,1,true);await draftRule(database.db,12,false);password=randomBytes(24).toString('base64url');
 owner=(await new AuthService(database.db).provision('synthetic-draft-context',password)).id;
 await sql`INSERT INTO leagues(id,name,opendota_league_id) VALUES(${league},'Synthetic Named League B',8800)`.execute(database.db);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
test.beforeEach(async({page})=>{
 const q=draftInput();q.title='Synthetic named draft';q.draft={assignments:[{teamSlot:'A',rolePos:1,heroId:1},{teamSlot:'B',rolePos:1,heroId:2}],bans:[]};
 const repo=new ScenarioRepository(database.db),first=await repo.save(owner,q);id=first.id;await repo.save(owner,{...q,title:'Synthetic empty current draft',draft:{assignments:[],bans:[]}},{id,expectedRevision:1});
 await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-draft-context');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
});
async function choose(page:Page,label:string,query:string,key:string){const field=page.getByRole('region',{name:label,exact:true});await field.getByRole('searchbox').fill(query);await field.getByRole('button',{name:'Найти',exact:true}).click();await field.locator(`button[data-context-id="${key}"]`).click();return field;}

test('draft players and frozen availability use readable names, inherit history metadata and never rewrite decisions on rename or503',async({page})=>{
 const requests:string[]=[];page.on('request',r=>{if(r.url().includes('/catalog-labels?'))requests.push(r.url());});
 await page.goto('/scenarios/'+id);const editor=page.locator('#draftlab');
 await expect(editor.getByRole('link',{name:'Synthetic Twin',exact:true})).toHaveCount(2);
 const frozen=(await(await page.request.get(`/api/v1/scenarios/${id}/history?offset=0`)).json()).items;
 await page.getByText('История карты',{exact:true}).click();
 const history=page.getByRole('region',{name:'История сценария',exact:true}),old=history.locator(':scope > details').filter({hasText:'Редакция 1 · Synthetic named draft'});
 await old.locator('summary').first().click();const assessment=old.getByRole('region',{name:'Сохранённая проверка драфта',exact:true});
 await expect(assessment.locator('[data-assessment-hero-id="1"]')).toContainText('Synthetic Hero');await expect(assessment).toContainText('synthetic draft patch');await expect(assessment).toContainText('Synthetic draft league');
 await expect(assessment.locator('[data-assessment-hero-id="1"]').locator('strong')).toHaveText('доступен');
 await expect(old.getByRole('button',{name:'Обновить подписи каталога',exact:true})).toHaveCount(1);
 expect(requests.filter(url=>new URL(url).searchParams.get('heroes'))).toHaveLength(1);
 await sql`UPDATE heroes SET localized_name='Synthetic Renamed Eligibility Hero' WHERE id=1`.execute(database.db);
 await old.getByRole('button',{name:'Обновить подписи каталога',exact:true}).click();await expect(assessment.locator('[data-assessment-hero-id="1"]')).toContainText('Synthetic Renamed Eligibility Hero');await expect(assessment.locator('[data-assessment-hero-id="1"]').locator('strong')).toHaveText('доступен');
 expect((await(await page.request.get(`/api/v1/scenarios/${id}/history?offset=0`)).json()).items).toEqual(frozen);
 await editor.getByRole('combobox',{name:'A: герой роли 1',exact:true}).selectOption('12');
 const checked=page.waitForResponse(r=>r.url().endsWith('/scenarios/draft-check')&&r.request().method()==='POST');await page.getByRole('button',{name:'Проверить доступность героев',exact:true}).click();
 const original=await(await checked).json(),preview=page.getByRole('region',{name:'Проверка доступности драфта',exact:true});expect(original.status).toBe('blocked');await expect(preview).toContainText('Есть подтверждённый запрет');await expect(preview.locator('[data-assessment-hero-id="12"]')).toContainText('Synthetic Draft Hero 12');
 await page.route('**/api/v1/catalog-labels?*',r=>r.fulfill({status:503,json:{error:{code:'SYNTHETIC_METADATA_FAILURE'}}}));
 await preview.getByText('Герои, патч и источники проверки',{exact:true}).click();await preview.getByRole('button',{name:'Обновить подписи каталога',exact:true}).click();await expect(preview.getByText('Не удалось обновить подписи каталога.',{exact:false})).toBeVisible();await expect(preview).toContainText('Есть подтверждённый запрет');
 await page.getByRole('button',{name:'Сохранить карту',exact:true}).click();await expect(page.getByRole('alert')).toContainText('недоступен по подтверждённому источнику');
 expect((await(await page.request.get(`/api/v1/scenarios/${id}/history?offset=0`)).json()).items).toEqual(frozen);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await preview.screenshot({path:'test-results/draft-context-labels-mobile.png'});
});

test('named local league selection retains exact bigint and null semantics; searching or loading names does not confirm or edit a scenario',async({page})=>{
 await page.goto('/scenarios/'+id);await page.getByText('Параметры карты и составы',{exact:true}).click();const picker=page.getByRole('region',{name:'Турнир карты',exact:true});await expect(picker.locator('[data-selected-id]')).toHaveAttribute('data-selected-id','1');
 const unsaved=page.getByText('Есть несохранённые изменения.',{exact:true});await expect(unsaved).toHaveCount(0);
 await picker.getByRole('searchbox').fill('Synthetic Named League');await picker.getByRole('button',{name:'Найти',exact:true}).click();await expect(unsaved).toHaveCount(0);await expect(picker.locator('[data-selected-id]')).toHaveAttribute('data-selected-id','1');
 await picker.locator(`button[data-context-id="${league}"]`).click();await expect(unsaved).toBeVisible();await expect(picker.locator('[data-selected-id]')).toHaveAttribute('data-selected-id',league);
 const saved=page.waitForResponse(r=>r.url().endsWith('/api/v1/scenarios/'+id)&&r.request().method()==='PUT');await page.getByRole('button',{name:'Сохранить карту',exact:true}).click();const response=await saved;expect(response.status()).toBe(200);expect(response.request().postDataJSON().input.context.leagueId).toBe(league);await expect(page.getByRole('heading',{name:'Сценарий · редакция 3',exact:true})).toBeVisible();
 await picker.getByRole('button',{name:'Сбросить',exact:true}).click();await expect(picker.locator('[data-selected-id]')).toHaveAttribute('data-selected-id','');await expect(picker.locator('[data-selected-id]')).toContainText('Не указан');
 const cleared=page.waitForResponse(r=>r.url().endsWith('/api/v1/scenarios/'+id)&&r.request().method()==='PUT');await page.getByRole('button',{name:'Сохранить карту',exact:true}).click();expect((await cleared).request().postDataJSON().input.context.leagueId).toBeNull();
});
