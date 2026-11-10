import {pickScenario,scenarioPicker,clearScenario} from './helpers/scenario-picker';
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
async function prepare(page:Page,manualSwapBeforePlayers=false){
 await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-editor-roles');await page.getByLabel('Пароль').fill(password);
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/auth/login')),page.getByRole('button',{name:'Войти',exact:true}).click()]);
 await page.getByRole('heading',{name:'Справочники',exact:true}).waitFor();await page.goto('/scenarios/new');const q=scenarioInput();
 await page.getByLabel('Название',{exact:true}).fill('Синтетический приоритет ролей');await pickScenario(page,'Команда A: поиск по названию',q.teamAId);
 await pickScenario(page,'Команда B: поиск по названию',q.teamBId);await page.getByLabel('Срез данных UTC',{exact:true}).fill('2024-01-03T00:00');
 if(manualSwapBeforePlayers){await page.getByLabel('A: герой роли 1',{exact:true}).selectOption('1');await page.getByLabel('A: сменить роль 1',{exact:true}).selectOption('5');}
 for(const p of q.lineupA)await pickScenario(page,`A: игрок роли ${6-p.rolePos}`,p.playerId!);
 for(const p of q.lineupB)await pickScenario(page,`B: игрок роли ${p.rolePos}`,p.playerId!);return q;
}
test('one history source automatically arranges the selected five without provider HTTP or consensus',async({page})=>{
 const q=await prepare(page);await expect(scenarioPicker(page,'A: игрок роли 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[0]!.playerId!);
 await expect(region(page).getByText('Определено автоматически · Pro-история',{exact:true})).toHaveCount(5);expect(calls).toBe(0);
});

test('a role selected before all five players are filled stays manual and does not duplicate draft positions',async({page})=>{
 const q=await prepare(page,true);
 await expect(region(page).getByText('Определено автоматически · Pro-история',{exact:true})).toHaveCount(5);
 await expect(region(page).getByLabel('Автоподстановка ролей A',{exact:true})).not.toBeChecked();
 await expect(scenarioPicker(page,'A: игрок роли 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[4]!.playerId!);
 await expect(scenarioPicker(page,'A: игрок роли 5').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[0]!.playerId!);
 await expect(page.getByLabel('A: герой роли 5',{exact:true})).toHaveValue('1');await expect(page.getByLabel('A: герой роли 1',{exact:true})).toHaveValue('');
 expect(calls).toBe(0);
});

test('manual role dropdown swaps players, moves the hero and stand-in, clears confirmation and survives saving',async({page})=>{
 const q=await prepare(page);await expect(scenarioPicker(page,'A: игрок роли 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[0]!.playerId!);
 await page.getByLabel('A: замена роли 1',{exact:true}).check();
 await page.getByLabel('A: герой роли 1',{exact:true}).selectOption('1');
 const confirmed=page.getByLabel('Подтверждаю выбранные 5+5, роли и необязательные ожидаемые составы',{exact:true});await confirmed.check();
 await page.getByLabel('A: сменить роль 1',{exact:true}).selectOption('5');
 for(let role=1;role<=5;role++)await expect(page.getByLabel(`A: сменить роль ${role}`,{exact:true})).toHaveValue(String(role));
 await expect(confirmed).not.toBeChecked();await expect(region(page).getByLabel('Автоподстановка ролей A',{exact:true})).not.toBeChecked();
 await expect(scenarioPicker(page,'A: игрок роли 5').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[0]!.playerId!);
 await expect(scenarioPicker(page,'A: игрок роли 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[4]!.playerId!);
 await expect(page.getByLabel('A: герой роли 5',{exact:true})).toHaveValue('1');await expect(page.getByLabel('A: герой роли 1',{exact:true})).toHaveValue('');
 await expect(page.getByLabel('A: замена роли 5',{exact:true})).toBeChecked();
 await confirmed.check();await page.getByRole('button',{name:'Сохранить сценарий',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Сценарий · редакция 1',exact:true})).toBeVisible();await page.reload();
 await expect(scenarioPicker(page,'A: игрок роли 5').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[0]!.playerId!);
 await expect(page.getByLabel('A: герой роли 5',{exact:true})).toHaveValue('1');
 for(let role=1;role<=5;role++)await expect(page.getByLabel(`A: сменить роль ${role}`,{exact:true})).toHaveValue(String(role));
 expect(calls).toBe(0);
});
test('Panda wins over conflicting history; manual correction locks auto until explicitly re-enabled',async({page})=>{
 const q=await prepare(page);await expect(scenarioPicker(page,'A: игрок роли 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[0]!.playerId!);
 const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/lineup-role-profiles')&&r.request().postDataJSON()?.refreshProfiles===true),
  region(page).getByRole('button',{name:'Обновить профили API A',exact:true}).click()]);
 expect((await response.json()).canAutoApply).toBe(false); // The versioned server consensus policy is deliberately unchanged.
 await expect(scenarioPicker(page,'A: игрок роли 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[4]!.playerId!);
 await expect(region(page).getByText('Определено автоматически · PandaScore',{exact:true})).toHaveCount(5);
 const grounds=region(page).locator('details').filter({has:page.getByText(`Основания игрока ${q.lineupA[0]!.playerId}`,{exact:true})});
 await expect(grounds.getByText(/^STRATZ:/)).not.toBeVisible();await grounds.getByText(`Основания игрока ${q.lineupA[0]!.playerId}`,{exact:true}).click();
 await expect(grounds.getByText('PandaScore: 5 · учтено',{exact:true})).toBeVisible();await expect(grounds.getByText(/^STRATZ:/)).toContainText('Источник не настроен');
 await grounds.getByText(`Основания игрока ${q.lineupA[0]!.playerId}`,{exact:true}).click();
 await expect(region(page).getByText('Источники расходятся',{exact:false}).first()).toBeVisible();
 await clearScenario(page,'A: игрок роли 5');await pickScenario(page,'A: игрок роли 1',q.lineupA[0]!.playerId!);await pickScenario(page,'A: игрок роли 5',q.lineupA[4]!.playerId!);
 const auto=region(page).getByLabel('Автоподстановка ролей A',{exact:true});await expect(auto).not.toBeChecked();
 await region(page).getByRole('button',{name:'Обновить профили API A',exact:true}).click();
 await expect(scenarioPicker(page,'A: игрок роли 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[0]!.playerId!);expect(calls).toBe(1);
 await auto.check();await expect(scenarioPicker(page,'A: игрок роли 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[4]!.playerId!);
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await region(page).screenshot({path:'test-results/role-editor-priority-mobile.png'});
});
test('duplicate proposed roles are shown without assigning the remaining positions',async({page})=>{
 duplicate=true;const q=await prepare(page);await expect(scenarioPicker(page,'A: игрок роли 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[0]!.playerId!);
 await region(page).getByRole('button',{name:'Обновить профили API A',exact:true}).click();
 await expect(region(page).getByText('Совпали позиции нескольких игроков. Расставьте их вручную.',{exact:true})).toBeVisible();
 await expect(region(page).getByRole('button',{name:'Применить роли A',exact:true})).toBeDisabled();
 for(const p of q.lineupA)await expect(scenarioPicker(page,`A: игрок роли ${p.rolePos}`).getByRole('status')).toHaveAttribute('data-selected-id',p.playerId!);
});
test('manual changes before the first role response survive its late arrival',async({page})=>{
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);let held=false;
 await page.route('**/api/v1/lineup-role-profiles',async route=>{
  if(route.request().postDataJSON().teamId===scenarioInput().teamAId&&!held){held=true;const response=await route.fetch();started();await gate;await route.fulfill({response});}
  else await route.continue();
 });
 const q=await prepare(page);await entered;
 await clearScenario(page,'A: игрок роли 2');await pickScenario(page,'A: игрок роли 1',q.lineupA[3]!.playerId!);await pickScenario(page,'A: игрок роли 2',q.lineupA[4]!.playerId!);
 release();await expect(region(page).getByText('Определено автоматически · Pro-история',{exact:true})).toHaveCount(5);
 await expect(region(page).getByLabel('Автоподстановка ролей A',{exact:true})).not.toBeChecked();
 await expect(scenarioPicker(page,'A: игрок роли 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[3]!.playerId!);
});
