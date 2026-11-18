import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedDraft,draftInput} from '../../../../tests/helpers/draft';
import {sql,ScenarioRepository} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,owner:string;
let first:Awaited<ReturnType<ScenarioRepository['save']>>,second:typeof first,third:typeof first;
test.beforeAll(async()=>{
 database=await testDatabase();await seedDraft(database.db);password=randomBytes(24).toString('base64url');
 owner=(await new AuthService(database.db).provision('synthetic-history-heroes',password)).id;
 await sql`INSERT INTO heroes(id,localized_name,internal_name) SELECT n,'Synthetic History Hero '||n,'synthetic_history_'||n FROM generate_series(15,50) n`.execute(database.db);
 await sql`UPDATE heroes SET localized_name='Synthetic Duplicate Hero' WHERE id IN(1,2)`.execute(database.db);
 await sql`UPDATE heroes SET localized_name='' WHERE id=3`.execute(database.db);
 const q=draftInput();q.title='Synthetic hero history';q.draft={assignments:Array.from({length:10},(_,i)=>({teamSlot:i<5?'A':'B',rolePos:i%5+1,heroId:i+1})),bans:Array.from({length:40},(_,i)=>({teamSlot:i%2?'A':'B',heroId:i+11}))};
 const repo=new ScenarioRepository(database.db);first=await repo.save(owner,q);second=await repo.save(owner,{...q,title:'Synthetic second hero history'},{id:first.id,expectedRevision:1});
 third=await repo.save(owner,{...q,title:'Synthetic current hero history',draft:{...q.draft!,bans:q.draft!.bans.filter(h=>h.heroId!==50)}},{id:first.id,expectedRevision:2});
 // Hero50 no longer has a current FK, but remains in the two immutable historical JSON snapshots.
 await sql`DELETE FROM heroes WHERE id=50`.execute(database.db);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});await api.listen({host:'127.0.0.1',port:3151});
},30000);
test.afterAll(async()=>{await api?.close();await database?.close();},30000);
async function enter(page:Page){
 await page.goto('/login');await page.getByLabel('Логин',{exact:true}).fill('synthetic-history-heroes');await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('heading',{name:'Справочники',exact:true}).waitFor();await page.goto('/scenarios/'+first.id);
}
test('history batches50 hero IDs lazily, preserves picks/bans, caches identical revisions and leaves immutable snapshots intact',async({page},info)=>{
 expect((await page.request.get('/api/v1/catalog-labels?heroes=1')).status()).toBe(401);
 const requests:string[]=[];page.on('request',r=>{if(r.url().includes('/api/v1/catalog-labels?')&&new URL(r.url()).searchParams.get('heroes')&&new URL(r.url()).searchParams.get('teams'))requests.push(r.url());});await enter(page);
 await page.getByRole('heading',{name:/^Сценарий · редакция \d+$/}).waitFor();if(await page.getByText('История карты',{exact:true}).count())await page.getByText('История карты',{exact:true}).click();
 const history=page.getByRole('region',{name:'История сценария',exact:true}),old=history.locator(':scope > details').filter({hasText:'Редакция 1 · Synthetic hero history'});
 await expect(old.locator('summary').first()).toBeVisible();expect(requests).toEqual([]);await old.locator('summary').first().click();
 const draft=old.getByRole('group',{name:'Герои драфта редакции',exact:true});
 await expect(draft.locator('[data-history-hero-id]')).toHaveCount(50);
 await expect(draft.locator('[data-history-hero-id]').getByText('Synthetic Duplicate Hero',{exact:true})).toHaveCount(2);await expect(draft.locator('[data-history-hero-id]').getByText('Герой без названия',{exact:true})).toHaveCount(1);
 await expect(draft.locator('[data-history-hero-id]').getByText('Название героя недоступно',{exact:true})).toHaveCount(1);expect(requests).toHaveLength(1);
 const params=new URL(requests[0]!).searchParams;expect(params.get('heroes')!.split(',')).toHaveLength(50);expect(new Set(params.get('heroes')!.split(',')).size).toBe(50);expect(params.get('players')!.split(',')).toHaveLength(10);
 const pick=draft.locator('[data-history-hero-id="1"]');await expect(pick).toContainText('A · роль 1');await expect(pick).toHaveAttribute('data-history-draft-action','pick');
 const ban=draft.locator('[data-history-hero-id="50"]');await expect(ban).toContainText('Бан A');await expect(ban).toHaveAttribute('data-history-draft-action','ban');
 await expect(pick.getByText('Внутренний ID: 1',{exact:true})).not.toBeVisible();await pick.getByText('Данные записи',{exact:true}).click();await expect(pick.getByText('Внутренний ID: 1',{exact:true})).toBeVisible();await expect(draft.getByRole('link')).toHaveCount(0);
 await old.locator('summary').first().click();await old.locator('summary').first().click();await expect(draft.locator('[data-history-hero-id]').getByText('Synthetic Duplicate Hero',{exact:true})).toHaveCount(2);expect(requests).toHaveLength(1);
 const latest=history.locator(':scope > details').filter({hasText:'Редакция 2 · Synthetic second hero history'});await latest.locator('summary').first().click();await expect(latest.getByRole('group',{name:'Герои драфта редакции',exact:true}).locator('[data-history-hero-id]')).toHaveCount(50);expect(requests).toHaveLength(1);await latest.locator('summary').first().click();
 await sql`UPDATE heroes SET localized_name='Synthetic renamed hero' WHERE id=1`.execute(database.db);
 await old.getByRole('button',{name:'Обновить подписи каталога',exact:true}).click();await expect(pick).toContainText('Synthetic renamed hero');expect(requests).toHaveLength(2);
 await page.route('**/api/v1/catalog-labels?*',r=>r.fulfill({status:503,json:{error:{code:'SYNTHETIC_LABEL_FAILURE'}}}));
 await old.getByRole('button',{name:'Обновить подписи каталога',exact:true}).click();await expect(old.getByRole('status')).toContainText('Не удалось обновить подписи');await expect(pick).toContainText('Synthetic renamed hero');
 await page.unroute('**/api/v1/catalog-labels?*');await old.getByRole('button',{name:'Обновить подписи каталога',exact:true}).click();await expect(old.getByRole('status')).toHaveCount(0);
 const frozen=(await(await page.request.get('/api/v1/scenarios/'+first.id+'/history?offset=0')).json()).items;expect(frozen).toEqual([third,second,first]);
 for(const query of ['heroes=0','heroes=9223372036854775808','heroes='+Array(51).fill('1').join(','),'heroes=1&refresh=true'])expect((await page.request.get('/api/v1/catalog-labels?'+query)).status()).toBe(400);
 const missing=await(await page.request.get('/api/v1/catalog-labels?heroes=1,1,9223372036854775807')).json();expect(missing.heroes).toEqual([{id:'1',name:'Synthetic renamed hero'}]);
 const legacy=await(await page.request.get('/api/v1/catalog-labels?teams=1')).json();expect(legacy).not.toHaveProperty('heroes');
 await pick.screenshot({path:info.outputPath('history-heroes-desktop.png')});await ban.screenshot({path:info.outputPath('history-heroes-missing.png')});await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await pick.screenshot({path:info.outputPath('history-heroes-mobile.png')});
});
