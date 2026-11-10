import {test,expect,type Page} from '@playwright/test';
import {CompareResponseSchema} from '@dota/contracts';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedCompare} from '../../../../tests/helpers/compare';
import {catalogTeamId,catalogPlayerId} from '../../../../tests/helpers/catalog';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
test.beforeAll(async()=>{
 database=await testDatabase();await seedCompare(database.db);password=randomBytes(24).toString('base64url');
 await sql`INSERT INTO teams(id,name) VALUES(1101,'Synthetic opponent one'),(1102,'Synthetic opponent two'),(1103,'')`.execute(database.db);
 for(const [id,opponent] of [[8101,1101],[8102,1102],[8103,1103],[8104,null]] as const)
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id,dire_team_id)
   VALUES(${id},'2024-01-01T13:00:00Z',1800,true,true,${catalogTeamId},${opponent})`.execute(database.db);
 await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id,dire_team_id)
  VALUES(8105,'2024-01-01T14:00:00Z',1800,true,true,${catalogTeamId},9007199254740994)`.execute(database.db);
 await sql`UPDATE players SET nickname='' WHERE id=${String(BigInt(catalogPlayerId)+2n)}`.execute(database.db);
 await new AuthService(database.db).provision('synthetic-historical-labels',password);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
async function prepare(page:Page){
 await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-historical-labels');await page.getByLabel('Пароль').fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('heading',{name:'Справочники',exact:true}).waitFor();
 await page.goto(`/compare?teamA=${catalogTeamId}&teamB=9007199254740994`);
 await page.getByLabel('Сравнение: начало UTC',{exact:true}).fill('2024-01-01T00:00');await page.getByLabel('Сравнение: срез UTC',{exact:true}).fill('2024-01-03T00:00');
 const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/teams/compare'));
 await page.getByRole('button',{name:'Сравнить команды',exact:true}).click();
 const report=CompareResponseSchema.parse(await (await response).json());if(report.status==='unavailable')throw Error('Synthetic comparison unavailable');return report;
}
test('historical lineups and opponent pages use bounded lazy labels without changing observations',async({page})=>{
 const metadata:URL[]=[],profiles:string[]=[];let comparisons=0;
 page.on('request',r=>{if(r.url().includes('/api/v1/catalog-labels?'))metadata.push(new URL(r.url()));if(r.url().endsWith('/api/v1/teams/compare'))comparisons++;if(/\/api\/v1\/players\/\d+$/.test(r.url()))profiles.push(r.url());});
 const report=await prepare(page);expect(metadata).toEqual([]);
 const table=page.getByRole('table',{name:'Карты H2H',exact:true});await expect(table).toContainText('Dire / Radiant');
 const lineups=table.getByLabel('Составы карты 8001',{exact:true});await lineups.getByText('Составы A / B',{exact:true}).click();
 await expect(lineups.getByRole('link',{name:'Synthetic Twin',exact:true})).toHaveCount(2);
 await expect(lineups.locator(`a[href="/players/${catalogPlayerId}"]`)).toBeVisible();
 await expect(lineups.getByRole('link',{name:'Игрок без ника',exact:true})).toHaveCount(1);
 expect(metadata).toHaveLength(1);expect(metadata[0]!.searchParams.get('players')!.split(',')).toHaveLength(10);
 await expect(lineups.getByText('Внутренний ID: '+catalogPlayerId,{exact:true})).not.toBeVisible();
 await expect(lineups.getByRole('region',{name:'Фактическая пятёрка A',exact:true}).getByRole('listitem')).toHaveCount(5);
 const other=table.getByLabel('Составы карты 8002',{exact:true});await other.getByText('Составы A / B',{exact:true}).click();await expect(other.getByRole('link',{name:'Synthetic Twin',exact:true})).toHaveCount(2);expect(metadata).toHaveLength(1);
 const missing=table.getByLabel('Составы карты 8105',{exact:true});await missing.getByText('Составы A / B',{exact:true}).click();await expect(missing.getByText('Игрок не указан',{exact:true})).toHaveCount(10);expect(metadata).toHaveLength(1);
 await expect(missing.getByRole('button',{name:'Обновить подписи каталога',exact:true})).toBeDisabled();
 const opponents=page.getByLabel('Соперники команды A',{exact:true});await opponents.getByText('A · Соперники за период',{exact:true}).click();
 let expectedRequests=1;const seen:string[]=[];
 for(let pageIndex=0;pageIndex*2<report.teamA.opponents.length;pageIndex++){
  const rows=report.teamA.opponents.slice(pageIndex*2,pageIndex*2+2),known=rows.filter(op=>op.opponentId!==null);
  if(known.length){expectedRequests++;await expect(opponents.getByText(/Подписи прочитаны:/)).toBeVisible();}
  for(const op of rows){if(op.opponentId===null){await expect(opponents.getByText('Команда не указана',{exact:true})).toBeVisible();continue;}
   const link=opponents.locator(`a[href="/teams/${op.opponentId}"]`);await expect(link).toBeVisible();await expect(link).not.toHaveText('Имя недоступно');seen.push(op.opponentId);
   await expect(link.locator('..').locator('..')).toContainText('N = '+op.stats.nRaw);
  }
  if((pageIndex+1)*2<report.teamA.opponents.length)await opponents.getByRole('button',{name:'Следующие соперники',exact:true}).click();
 }
 expect(seen.sort()).toEqual(report.teamA.opponents.flatMap(op=>op.opponentId?[op.opponentId]:[]).sort());expect(metadata).toHaveLength(expectedRequests);
 await expect(opponents.getByRole('button',{name:'Следующие соперники',exact:true})).toBeDisabled();
 expect(metadata.every(url=>(url.searchParams.get('teams')?.split(',').filter(Boolean).length??0)<=2&&(url.searchParams.get('players')?.split(',').filter(Boolean).length??0)<=20)).toBe(true);
 expect(comparisons).toBe(1);expect(profiles).toEqual([]);await expect(page.getByRole('group',{name:'H2H двух организаций'})).toContainText('N = '+report.h2h.organizations.nRaw);
 await lineups.screenshot({path:'test-results/historical-lineups-desktop.png'});await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await table.locator('..').screenshot({path:'test-results/historical-lineups-mobile.png'});
});

test('metadata failures and delayed replies never replace the selected comparison',async({page})=>{
 await prepare(page);const result=page.getByRole('region',{name:'Результат сравнения',exact:true}),lineups=result.getByLabel('Составы карты 8001',{exact:true});
 await page.route('**/api/v1/catalog-labels?**',r=>r.fulfill({status:503,json:{error:{code:'SYNTHETIC_LABEL_FAILURE'}}}));
 await lineups.getByText('Составы A / B',{exact:true}).click();await expect(lineups.getByRole('status')).toContainText('Не удалось обновить подписи');await expect(lineups.getByRole('link',{name:'Имя недоступно',exact:true})).toHaveCount(10);
 await page.unroute('**/api/v1/catalog-labels?**');await lineups.getByRole('button',{name:'Обновить подписи каталога',exact:true}).click();await expect(lineups.getByRole('link',{name:'Synthetic Twin',exact:true})).toHaveCount(2);
 let release:()=>void=()=>undefined;const gate=new Promise<void>(r=>{release=r;});
 await page.route('**/api/v1/catalog-labels?**',async route=>{const response=await route.fetch();await gate;await route.fulfill({response}).catch(()=>undefined);});
 await lineups.getByRole('button',{name:'Обновить подписи каталога',exact:true}).click();await expect(lineups.getByRole('status')).toContainText('Чтение подписей');
 const team=page.getByRole('region',{name:'Команда B: поиск по названию',exact:true});await team.getByRole('searchbox').fill('Literal');await team.getByRole('searchbox').press('Enter');await team.locator('button[data-catalog-id="9007199254740995"]').click();await expect(result).toHaveCount(0);release();
 await page.unroute('**/api/v1/catalog-labels?**');await page.getByRole('button',{name:'Сравнить команды',exact:true}).click();await expect(result).toContainText('Нет наблюдаемых профессиональных личных встреч');await expect(result.getByLabel('Составы карты 8001',{exact:true})).toHaveCount(0);
});
