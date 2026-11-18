import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedCompare} from '../../../../tests/helpers/compare';
import {catalogTeamId} from '../../../../tests/helpers/catalog';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
const leagueId='9007199254741999';
test.beforeAll(async()=>{
 database=await testDatabase();await seedCompare(database.db);password=randomBytes(24).toString('base64url');
 await sql`INSERT INTO leagues(id,opendota_league_id,name) VALUES(${leagueId},777,'Synthetic context tournament'),(1231,778,'Synthetic context tournament'),(1232,779,'Synthetic %_ league')`.execute(database.db);
 for(let i=0;i<22;i++)await sql`INSERT INTO leagues(id,name) VALUES(${2000+i},${'Synthetic page '+String(i).padStart(2,'0')})`.execute(database.db);
 await sql`UPDATE matches SET league_id=${leagueId} WHERE id=8001`.execute(database.db);
 await new AuthService(database.db).provision('synthetic-context-browser',password);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
async function prepare(page:Page){
 await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-context-browser');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('heading',{name:'Справочники',exact:true}).waitFor();
 await page.goto(`/compare?teamA=${catalogTeamId}&teamB=9007199254740994`);
 await page.getByLabel('Сравнение: начало UTC',{exact:true}).fill('2024-01-01T00:00');await page.getByLabel('Сравнение: срез UTC',{exact:true}).fill('2024-01-03T00:00');
}
test('named context filters preserve exact local IDs and the selected cohort',async({page})=>{
 const requests:unknown[]=[],lookups:string[]=[];page.on('request',r=>{if(r.url().endsWith('/teams/compare'))requests.push(r.postDataJSON());if(r.url().includes('/context-catalog?'))lookups.push(r.url());});
 await prepare(page);expect(lookups).toEqual([]);
 const patch=page.getByRole('region',{name:'Сравнение: патч',exact:true});await patch.getByRole('searchbox').fill('synthetic comparison patch');await patch.getByRole('searchbox').press('Enter');await patch.locator('button[data-context-id="1"]').click();
 await expect(patch.getByRole('status')).toContainText('synthetic comparison patch');
 const league=page.getByRole('region',{name:'Сравнение: турнир',exact:true});await league.getByRole('searchbox').fill('Synthetic context tournament');await league.getByRole('searchbox').press('Enter');
 await expect(league.locator('button[data-context-id]')).toHaveCount(2);await league.locator(`button[data-context-id="${leagueId}"]`).click();
 await expect(league.getByRole('status')).not.toContainText(leagueId);expect(lookups).toHaveLength(2);expect(requests).toEqual([]);
 await page.getByRole('button',{name:'Сравнить команды',exact:true}).click();const result=page.getByRole('region',{name:'Результат сравнения',exact:true});
 await expect(result.getByRole('row').filter({hasText:'Организация · весь период'})).toContainText('N = 1');
 expect(requests[0]).toEqual({teamAId:catalogTeamId,teamBId:'9007199254740994',lineupA:Array.from({length:5},(_,i)=>({rolePos:i+1,playerId:null,isStandin:false})),lineupB:Array.from({length:5},(_,i)=>({rolePos:i+1,playerId:null,isStandin:false})),fromAt:'2024-01-01T00:00:00.000Z',cutoffAt:'2024-01-03T00:00:00.000Z',patchId:'1',leagueId});
 await expect(result).toContainText('Synthetic context tournament');expect(lookups).toHaveLength(2);
 await league.getByRole('searchbox').fill('missing name');await league.getByRole('searchbox').press('Enter');await expect(league.getByText('Подходящие записи не найдены. Текущий фильтр сохранён.',{exact:true})).toBeVisible();await expect(league.getByRole('status')).toHaveAttribute('data-selected-id',leagueId);await expect(result).toBeVisible();expect(requests).toHaveLength(1);
 await league.screenshot({path:'test-results/context-filter-desktop.png'});await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await league.screenshot({path:'test-results/context-filter-mobile.png'});
});

test('context catalog protects scope, pages literal searches and retains unknown IDs',async({page})=>{
 expect((await page.request.get('/api/v1/context-catalog?kind=patches')).status()).toBe(401);await prepare(page);
 for(const query of ['kind=matches','kind=patches&offset=10001','kind=patches&id=1&query=x','kind=leagues&id=9223372036854775808'])expect((await page.request.get('/api/v1/context-catalog?'+query)).status()).toBe(400);
 const league=page.getByRole('region',{name:'Сравнение: турнир',exact:true});await league.getByRole('searchbox').fill('Synthetic page');await league.getByRole('searchbox').press('Enter');await expect(league.locator('button[data-context-id]')).toHaveCount(20);await league.getByRole('button',{name:'Следующие названия',exact:true}).click();await expect(league.locator('button[data-context-id]')).toHaveCount(2);
 await league.getByRole('searchbox').fill('%_');await league.getByRole('searchbox').press('Enter');await expect(league.locator('button[data-context-id]')).toHaveCount(1);await league.locator('button[data-context-id="1232"]').click();
  await league.getByText('Технический ID',{exact:true}).click();const id=league.getByLabel('Сравнение: ID лиги',{exact:true});
  const exactReads:string[]=[];page.on('request',r=>{if(r.url().includes('/context-catalog?')&&new URL(r.url()).searchParams.has('id'))exactReads.push(r.url());});
  await id.fill('');await id.pressSequentially('9223372036854775807');expect(exactReads).toEqual([]);await id.press('Tab');
  await expect(league.getByRole('status')).toContainText('Название недоступно');expect(exactReads).toHaveLength(1);await expect(id).toHaveValue('9223372036854775807');
 await page.getByRole('button',{name:'Сравнить команды',exact:true}).click();await expect(page.getByRole('row').filter({hasText:'Организация · весь период'})).toContainText('N = 0');await expect(id).toHaveValue('9223372036854775807');
 await page.route('**/api/v1/context-catalog?**',r=>r.fulfill({status:503,json:{error:{code:'SYNTHETIC_CONTEXT_FAILURE'}}}));await league.getByRole('searchbox').fill('Synthetic');await league.getByRole('searchbox').press('Enter');await expect(league.getByRole('alert')).toBeVisible();await expect(id).toHaveValue('9223372036854775807');
 await page.unroute('**/api/v1/context-catalog?**');await league.getByRole('button',{name:'Повторить поиск',exact:true}).click();await expect(league.locator('button[data-context-id]')).toHaveCount(20);
 await league.getByRole('button',{name:'Сбросить',exact:true}).click();await expect(id).toHaveValue('');
});
