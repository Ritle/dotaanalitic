import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedPlayerHeroes} from '../../../../tests/helpers/player-hero';
import {catalogPlayerId,catalogTeamId} from '../../../../tests/helpers/catalog';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,cases=0;
const opponentId='9007199254740994';
async function startApi(){api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});await api.listen({host:'127.0.0.1',port:3151});}
test.beforeAll(async()=>{
 database=await testDatabase();await seedPlayerHeroes(database.db);password=randomBytes(24).toString('base64url');
 await sql`UPDATE heroes SET localized_name='Synthetic Hero' WHERE id=2`.execute(database.db);
 await sql`UPDATE teams SET opendota_team_id=777 WHERE id=${opponentId}`.execute(database.db);
 for(let i=0;i<22;i++)await sql`INSERT INTO heroes(id,localized_name,internal_name) VALUES(${100+i},${'Synthetic Page '+String(i).padStart(2,'0')},${'synthetic_page_'+i})`.execute(database.db);
 await sql`INSERT INTO heroes(id,localized_name,internal_name) VALUES(999,'Синтетический %_ герой','synthetic_literal')`.execute(database.db);
 await sql`INSERT INTO heroes(id,localized_name,internal_name) VALUES(1998,'','synthetic_unnamed')`.execute(database.db);
 await new AuthService(database.db).provision('synthetic-reference-browser',password);await startApi();
},30000);
test.beforeEach(async()=>{if(cases++>0){await api.close();await startApi();}});
test.afterAll(async()=>{await api?.close();await database?.close();},30000);
async function enter(page:Page,path=`/teams/${catalogTeamId}`){
 await page.goto('/login');await page.getByLabel('Логин',{exact:true}).fill('synthetic-reference-browser');await page.getByLabel('Пароль',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('heading',{name:'Справочники',exact:true}).waitFor();await page.goto(path);
}
async function named(page:Page,label:string,query:string,id:string){const picker=page.getByRole('region',{name:label,exact:true});
 await picker.getByRole('searchbox').fill(query);await picker.getByRole('button',{name:'Найти',exact:true}).click();await picker.locator(`button[data-context-id="${id}"]`).click();return picker;
}
async function mapsWindow(page:Page){await page.getByLabel('С даты (UTC)',{exact:true}).fill('2024-01-01T00:00');await page.getByLabel('До момента (UTC)',{exact:true}).fill('2024-01-03T00:00');}
test('named opponent and role-player preserve exact bigint IDs, search state and applied cohort',async({page},info)=>{
 const requests:string[]=[],labels:string[]=[];page.on('request',r=>{if(r.url().includes('/matches?'))requests.push(r.url());if(r.url().includes('/context-catalog?')&&!new URL(r.url()).searchParams.has('ids'))labels.push(r.url());});
 await enter(page);await mapsWindow(page);
 const opponent=await named(page,'Карты: соперник','Synthetic Aurora',opponentId);
 const player=await named(page,'Карты: игрок для фильтра роли','Synthetic Twin',catalogPlayerId);
 await expect(opponent.getByRole('status')).not.toContainText(opponentId);await expect(player.getByRole('status')).not.toContainText(catalogPlayerId);
 const before=requests.length;await page.getByLabel('Подтверждённая роль',{exact:true}).selectOption('1');
 const response=page.waitForResponse(r=>r.url().includes('/matches?')&&new URL(r.url()).searchParams.get('rolePos')==='1');
 await page.getByRole('button',{name:'Применить фильтры',exact:true}).click();const body=await(await response).json();
 expect(body.filters).toMatchObject({opponentId,playerId:catalogPlayerId,rolePos:1,limit:20,fromAt:'2024-01-01T00:00:00.000Z',cutoffAt:'2024-01-03T00:00:00.000Z'});expect(body.summary.nRaw).toBe(1);
 await expect(page.getByRole('group',{name:'Показатели выборки',exact:true})).toContainText('N = 1');expect(requests).toHaveLength(before+1);expect(labels).toHaveLength(2);
 await opponent.getByRole('searchbox').fill('missing opponent');await opponent.getByRole('searchbox').press('Enter');await expect(opponent.getByText('Подходящие записи не найдены. Текущий фильтр сохранён.',{exact:true})).toBeVisible();
 await expect(opponent.getByRole('status')).toHaveAttribute('data-selected-id',opponentId);expect(requests).toHaveLength(before+1);
 await opponent.screenshot({path:info.outputPath('reference-desktop.png')});await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await opponent.screenshot({path:info.outputPath('reference-mobile.png')});
});
test('hero names, duplicate names and explicit reset preserve the request and nullable empty statistics',async({page})=>{
 const lookups:string[]=[];page.on('request',r=>{if(r.url().includes('/context-catalog?')&&!new URL(r.url()).searchParams.has('ids'))lookups.push(r.url());});
 await enter(page,'/players/'+catalogPlayerId);await page.getByLabel('Герои: срез истории (UTC)',{exact:true}).fill('2024-01-03T00:00');
 const hero=await named(page,'Герои: герой','Synthetic Hero','1');
 await expect(hero.getByRole('status')).toContainText('Synthetic Hero');
 const response=page.waitForResponse(r=>r.url().includes('/heroes?')&&new URL(r.url()).searchParams.get('heroId')==='1');
 await page.getByRole('button',{name:'Применить фильтры героев',exact:true}).click();const body=await(await response).json();expect(body.filters.heroId).toBe('1');expect(body.summary.nRaw).toBe(2);expect(lookups.filter(url=>new URL(url).searchParams.get('kind')==='heroes')).toHaveLength(1);expect(lookups.some(url=>new URL(url).searchParams.get('kind')==='players')).toBe(false);
 await hero.getByRole('searchbox').fill('Synthetic Hero');await hero.getByRole('searchbox').press('Enter');await expect(hero.getByText('Название повторяется. Сверьте локальный ID.',{exact:true})).toHaveCount(2);
 await hero.getByText('Технический ID',{exact:true}).click();await hero.getByLabel('Герои: ID героя',{exact:true}).fill('998');await hero.getByLabel('Герои: ID героя',{exact:true}).press('Tab');
 await expect(hero.getByRole('status')).toContainText('Название недоступно');await expect(hero.getByRole('status')).toHaveAttribute('data-selected-id','998');
 const empty=page.waitForResponse(r=>r.url().includes('/heroes?')&&new URL(r.url()).searchParams.get('heroId')==='998');
 await page.getByRole('button',{name:'Применить фильтры героев',exact:true}).click();expect((await(await empty).json()).summary).toMatchObject({nRaw:0,winRate:null});await expect(page.getByRole('group',{name:'Показатели игрока на героях',exact:true})).toContainText('N = 0');
 await hero.getByRole('button',{name:'Сбросить',exact:true}).click();await expect(hero.getByRole('status')).toContainText('Все герои');
 const cleared=page.waitForResponse(r=>r.url().includes('/heroes?')&&!new URL(r.url()).searchParams.has('heroId'));await page.getByRole('button',{name:'Применить фильтры героев',exact:true}).click();expect((await(await cleared).json()).filters.heroId).toBeUndefined();
 await named(page,'Герои: герой','1998','1998');await expect(hero.getByRole('status')).toContainText('Герой без названия');await expect(hero.getByRole('status')).toHaveAttribute('data-selected-id','1998');
});
test('reference lookup is private, bounded, literal, Unicode-aware and never coerces unknown IDs',async({page})=>{
 expect((await page.request.get('/api/v1/context-catalog?kind=heroes')).status()).toBe(401);await enter(page);
 for(const kind of ['heroes','players','teams']){
  const response=await page.request.get('/api/v1/context-catalog?'+new URLSearchParams({kind,id:'9223372036854775807'}));expect(response.status()).toBe(200);expect((await response.json()).items).toEqual([]);
 }
 for(const q of ['kind=matches','kind=heroes&offset=10001','kind=players&id=1&query=x','kind=teams&id=9223372036854775808'])expect((await page.request.get('/api/v1/context-catalog?'+q)).status()).toBe(400);
 const first=await(await page.request.get('/api/v1/context-catalog?kind=heroes&query=Synthetic%20Page')).json();expect(first.items).toHaveLength(20);expect(first.hasMore).toBe(true);
 expect((await(await page.request.get('/api/v1/context-catalog?kind=heroes&query=Synthetic%20Page&offset=20')).json()).items).toHaveLength(2);
 const literal=await(await page.request.get('/api/v1/context-catalog?'+new URLSearchParams({kind:'heroes',query:'синтетический %_'}))).json();expect(literal.items).toEqual([{id:'999',name:'Синтетический %_ герой'}]);
 const picker=page.getByRole('region',{name:'Карты: соперник',exact:true});await picker.getByText('Технический ID',{exact:true}).click();
 const exact:string[]=[];page.on('request',r=>{if(r.url().includes('/context-catalog?')&&new URL(r.url()).searchParams.has('id'))exact.push(r.url());});
 await picker.getByLabel('ID соперника',{exact:true}).pressSequentially('9223372036854775807');expect(exact).toEqual([]);await picker.getByLabel('ID соперника',{exact:true}).press('Tab');
 await expect(picker.getByRole('status')).toContainText('Название недоступно');expect(exact).toHaveLength(1);
});
test('failed or delayed reference search cannot clear or replace a chosen filter',async({page})=>{
 await enter(page);const picker=await named(page,'Карты: соперник','Synthetic Aurora',opponentId);
 await page.route('**/context-catalog?kind=teams&query=*',route=>route.fulfill({status:503,body:'{}'}),{times:1});
 await picker.getByRole('searchbox').fill('unavailable');await picker.getByRole('searchbox').press('Enter');await expect(picker.getByRole('alert')).toBeVisible();await expect(picker.getByRole('status')).toHaveAttribute('data-selected-id',opponentId);
 await picker.getByRole('button',{name:'Повторить поиск',exact:true}).click();await expect(picker.getByText('Подходящие записи не найдены. Текущий фильтр сохранён.',{exact:true})).toBeVisible();
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 await page.route('**/context-catalog?kind=teams&query=*',async route=>{await gate;await route.continue().catch(()=>{});},{times:1});
 await picker.getByRole('searchbox').fill('Synthetic');await picker.getByRole('searchbox').press('Enter');await expect(picker.getByText('Поиск названий…',{exact:true})).toBeVisible();
 await picker.getByRole('button',{name:'Сбросить',exact:true}).click();release();await expect(picker.getByRole('status')).toHaveAttribute('data-selected-id','');await expect(picker.locator('button[data-context-id]')).toHaveCount(0);
});
