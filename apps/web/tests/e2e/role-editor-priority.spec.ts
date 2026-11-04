import {test,expect,type Page} from '@playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedProMaps} from '../../../../tests/helpers/pro-maps';
import {scenarioInput} from '../../../../tests/helpers/scenario';
import {RoleProfileRepository} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,calls=0,duplicate=false;
test.beforeEach(async()=>{
 database=await testDatabase();await seedProMaps(database.db);password=randomBytes(24).toString('base64url');calls=0;duplicate=false;
 const owner=await new AuthService(database.db).provision('synthetic-editor-roles',password),q=scenarioInput();
 await new RoleProfileRepository(database.db).saveBinding(owner.id,q.teamAId,{requestId:randomUUID(),expectedRevision:0,confirmedByOwner:true,
  binding:{stratzTeamId:null,pandaTournamentId:'55',pandaTeamId:'88',pandaPlayers:q.lineupA.map((p,i)=>({playerId:p.playerId!,providerPlayerId:String(2000+i)}))}});
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',ROLE_PROFILES_ENABLED:'true',PANDASCORE_API_TOKEN:'synthetic-editor-panda'}),
  {db:database.db,logger:false,roleProfileFetch:async()=>{calls++;return Response.json({type:'Team',rosters:[{id:88,name:'Synthetic',
   players:q.lineupA.map((_,i)=>({id:2000+i,name:'Synthetic player '+i,role:String(duplicate?1:5-i)}))}]});}});
 await api.listen({host:'127.0.0.1',port:3151});
});
test.afterEach(async()=>{await api?.close();await database?.close();});
const region=(page:Page)=>page.getByRole('region',{name:'Автоопределение ролей A',exact:true});
async function prepare(page:Page){
 await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-editor-roles');await page.getByLabel('Пароль').fill(password);
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/auth/login')),page.getByRole('button',{name:'Войти',exact:true}).click()]);
 await page.getByRole('heading',{name:'Справочники',exact:true}).waitFor();await page.goto('/scenarios/new');const q=scenarioInput();
 await page.getByLabel('Название',{exact:true}).fill('Синтетический приоритет ролей');await page.getByLabel('Команда A: ID организации',{exact:true}).fill(q.teamAId);
 await page.getByLabel('Команда B: ID организации',{exact:true}).fill(q.teamBId);await page.getByLabel('Срез данных UTC',{exact:true}).fill('2024-01-03T00:00');
 for(const p of q.lineupA)await page.getByLabel(`A: игрок роли ${6-p.rolePos}`,{exact:true}).fill(p.playerId!);
 for(const p of q.lineupB)await page.getByLabel(`B: игрок роли ${p.rolePos}`,{exact:true}).fill(p.playerId!);return q;
}
test('one history source automatically arranges the selected five without provider HTTP or consensus',async({page})=>{
 const q=await prepare(page);await expect(page.getByLabel('A: игрок роли 1',{exact:true})).toHaveValue(q.lineupA[0]!.playerId!);
 await expect(region(page).getByText('Определено автоматически · Pro-история',{exact:true})).toHaveCount(5);expect(calls).toBe(0);
});
test('Panda wins over conflicting history; manual correction locks auto until explicitly re-enabled',async({page})=>{
 const q=await prepare(page);await expect(page.getByLabel('A: игрок роли 1',{exact:true})).toHaveValue(q.lineupA[0]!.playerId!);
 const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/lineup-role-profiles')&&r.request().postDataJSON()?.refreshProfiles===true),
  region(page).getByRole('button',{name:'Обновить профили API A',exact:true}).click()]);
 expect((await response.json()).canAutoApply).toBe(false); // The versioned server consensus policy is deliberately unchanged.
 await expect(page.getByLabel('A: игрок роли 1',{exact:true})).toHaveValue(q.lineupA[4]!.playerId!);
 await expect(region(page).getByText('Определено автоматически · PandaScore',{exact:true})).toHaveCount(5);
 await expect(region(page).getByText('Источники расходятся',{exact:false}).first()).toBeVisible();
 await page.getByLabel('A: игрок роли 1',{exact:true}).fill(q.lineupA[0]!.playerId!);await page.getByLabel('A: игрок роли 5',{exact:true}).fill(q.lineupA[4]!.playerId!);
 const auto=region(page).getByLabel('Автоподстановка ролей A',{exact:true});await expect(auto).not.toBeChecked();
 await region(page).getByRole('button',{name:'Обновить профили API A',exact:true}).click();
 await expect(page.getByLabel('A: игрок роли 1',{exact:true})).toHaveValue(q.lineupA[0]!.playerId!);expect(calls).toBe(1);
 await auto.check();await expect(page.getByLabel('A: игрок роли 1',{exact:true})).toHaveValue(q.lineupA[4]!.playerId!);
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/role-editor-priority-mobile.png',fullPage:true});
});
test('duplicate proposed roles are shown without assigning the remaining positions',async({page})=>{
 duplicate=true;const q=await prepare(page);await expect(page.getByLabel('A: игрок роли 1',{exact:true})).toHaveValue(q.lineupA[0]!.playerId!);
 await region(page).getByRole('button',{name:'Обновить профили API A',exact:true}).click();
 await expect(region(page).getByText('Совпали позиции нескольких игроков. Расставьте их вручную.',{exact:true})).toBeVisible();
 await expect(region(page).getByRole('button',{name:'Применить роли A',exact:true})).toBeDisabled();
 for(const p of q.lineupA)await expect(page.getByLabel(`A: игрок роли ${p.rolePos}`,{exact:true})).toHaveValue(p.playerId!);
});
test('manual changes before the first role response survive its late arrival',async({page})=>{
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);let held=false;
 await page.route('**/api/v1/lineup-role-profiles',async route=>{
  if(route.request().postDataJSON().teamId===scenarioInput().teamAId&&!held){held=true;const response=await route.fetch();started();await gate;await route.fulfill({response});}
  else await route.continue();
 });
 const q=await prepare(page);await entered;
 await page.getByLabel('A: игрок роли 1',{exact:true}).fill(q.lineupA[3]!.playerId!);await page.getByLabel('A: игрок роли 2',{exact:true}).fill(q.lineupA[4]!.playerId!);
 release();await expect(region(page).getByText('Определено автоматически · Pro-история',{exact:true})).toHaveCount(5);
 await expect(region(page).getByLabel('Автоподстановка ролей A',{exact:true})).not.toBeChecked();
 await expect(page.getByLabel('A: игрок роли 1',{exact:true})).toHaveValue(q.lineupA[3]!.playerId!);
});
