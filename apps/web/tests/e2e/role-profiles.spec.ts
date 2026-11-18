import {pickScenario,scenarioPicker,clearScenario} from './helpers/scenario-picker';
import {test,expect,type Page} from '@playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedProMaps} from '../../../../tests/helpers/pro-maps';
import {scenarioInput} from '../../../../tests/helpers/scenario';
import {RoleProfileRepository,sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
let startedCases=0;
async function startApi(){const q=scenarioInput();
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',ROLE_PROFILES_ENABLED:'true',
  STRATZ_API_TOKEN:'synthetic-profile-stratz-key',PANDASCORE_API_TOKEN:'synthetic-profile-panda-key'}),{db:database.db,logger:false,roleProfileFetch:async(url,init)=>{
    if(String(url).includes('stratz')){const id=Number(String(init?.body).match(/steamAccountId:(\d+)/)?.[1]);return new Response(JSON.stringify({data:{player:{steamAccountId:id,
      steamAccount:{proSteamAccount:{id,name:'Synthetic profile',teamId:77,position:`POSITION_${id-999}`}}}}}));}
    return new Response(JSON.stringify({type:'Team',rosters:[{id:88,name:'Synthetic team',players:q.lineupA.map((_,i)=>({id:2000+i,name:'Synthetic player '+i,role:String(i+1)}))}]}));
  }});await api.listen({host:'127.0.0.1',port:3151});
}
test.beforeAll(async()=>{
 database=await testDatabase();await seedProMaps(database.db);password=randomBytes(24).toString('base64url');
 await new AuthService(database.db).provision('synthetic-profile-browser',password);
 const owner=(await sql<{id:string}>`SELECT id FROM app_users`.execute(database.db)).rows[0]!.id,q=scenarioInput();
 await new RoleProfileRepository(database.db).saveBinding(owner,q.teamAId,{requestId:randomUUID(),expectedRevision:0,confirmedByOwner:true,
  binding:{stratzTeamId:'77',pandaTournamentId:'55',pandaTeamId:'88',pandaPlayers:q.lineupA.map((p,i)=>({playerId:p.playerId!,providerPlayerId:String(2000+i)}))}});
 await startApi();
});
test.afterAll(async()=>{await api?.close();await database?.close();});
// Keep the shared fixture's bindings/cache, but isolate the per-case HTTP/IP budget.
test.beforeEach(async()=>{if(startedCases++>0){await api.close();await startApi();}});
async function prepare(page:Page){
 await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-profile-browser');await page.getByLabel('Пароль').fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();await page.goto('/scenarios/new');
 const q=scenarioInput();await page.getByLabel('Название',{exact:true}).fill('Синтетические роли API');
 await pickScenario(page,'Команда A: поиск по названию',q.teamAId);await pickScenario(page,'Команда B: поиск по названию',q.teamBId);
 await page.getByLabel('Автоподстановка ролей A',{exact:true}).uncheck();
 await page.getByLabel('Срез данных UTC',{exact:true}).fill('2024-01-03T00:00');
 for(const p of q.lineupA)await pickScenario(page,`A: игрок ${6-p.rolePos}`,p.playerId!);
 for(const p of q.lineupB)await pickScenario(page,`B: игрок ${p.rolePos}`,p.playerId!);
 return q;
}
test('API agreement automatically assigns roles, moves hero/stand-in, resets confirmation; saved/manual positions remain authoritative',async({page})=>{
 const debug:{kind:string;refresh?:boolean;status?:number;auto?:boolean;error?:string}[]=[];
 page.on('request',r=>{if(r.url().includes('/lineup-role-profiles'))debug.push({kind:'request',refresh:r.postDataJSON()?.refreshProfiles});});
 page.on('response',async r=>{if(r.url().includes('/lineup-role-profiles')){const body=await r.json().catch(()=>null);debug.push({kind:'response',status:r.status(),auto:body?.canAutoApply});}});
 page.on('pageerror',e=>debug.push({kind:'pageerror',error:e.message}));
 const q=await prepare(page),region=page.getByRole('region',{name:'Автоопределение ролей A',exact:true});
 await expect(region.getByRole('button',{name:'Обновить профили API A',exact:true})).toBeEnabled();
 await page.getByLabel('A: замена игрока 5',{exact:true}).check();await page.getByRole('combobox',{name:'A: герой роли 5',exact:true}).selectOption('1');
 const confirm=page.getByLabel('Подтверждаю выбранные 5+5, роли и необязательные ожидаемые составы',{exact:true});await confirm.check();
 try{await Promise.all([page.waitForResponse(r=>r.url().endsWith('/lineup-role-profiles')&&r.request().method()==='POST'&&r.request().postDataJSON()?.refreshProfiles===true),region.getByRole('button',{name:'Обновить профили API A',exact:true}).click()]);}
 catch(e){console.log(JSON.stringify({roleBrowserDebug:debug}));throw e;}
 await region.getByLabel('Автоподстановка ролей A',{exact:true}).check();
 await expect(region).toContainText('Synthetic player 0');
 const roleRow=region.locator(`[data-role-player-id="${q.lineupA[0]!.playerId}"]`);
 await expect(roleRow.locator('[data-role-label]')).toHaveText('Synthetic player 0');
 await expect(roleRow.getByText('Локальный ID игрока: '+q.lineupA[0]!.playerId,{exact:true})).not.toBeVisible();
 await roleRow.locator('details > summary').first().click();
 await expect(roleRow.getByText('Локальный ID игрока: '+q.lineupA[0]!.playerId,{exact:true})).toBeVisible();
 await roleRow.locator('details > summary').first().click();
 await expect(scenarioPicker(page,'A: игрок 5').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[0]!.playerId!);await expect(page.getByLabel('A: роль игрока 5',{exact:true})).toHaveValue('1');
 await expect(page.getByLabel('A: замена игрока 5',{exact:true})).toBeChecked();await expect(page.getByRole('combobox',{name:'A: герой роли 1',exact:true})).toHaveValue('1');await expect(confirm).not.toBeChecked();
 const applyRoles=region.getByRole('button',{name:'Применить роли A',exact:true});
 await expect(applyRoles).toBeDisabled();await expect(region).toContainText('Роли A уже расставлены в форме.');
 await page.getByLabel('A: роль игрока 5',{exact:true}).selectOption('2');
 await expect(applyRoles).toBeEnabled();await applyRoles.click();
 await expect(page.getByLabel('A: роль игрока 5',{exact:true})).toHaveValue('1');
 await expect(applyRoles).toBeDisabled();await expect(page.getByLabel('A: замена игрока 5',{exact:true})).toBeChecked();
 await expect(page.getByRole('combobox',{name:'A: герой роли 1',exact:true})).toHaveValue('1');
 await clearScenario(page,'A: игрок 5');await pickScenario(page,'A: игрок 1',q.lineupA[0]!.playerId!);await pickScenario(page,'A: игрок 5',q.lineupA[4]!.playerId!);
 await expect(region.getByLabel('Автоподстановка ролей A',{exact:true})).not.toBeChecked();
 await region.getByRole('button',{name:'Обновить профили API A',exact:true}).click();
 await expect(scenarioPicker(page,'A: игрок 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[0]!.playerId!);
 await confirm.check();await page.getByRole('button',{name:'Сохранить сценарий',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Сценарий · редакция 1',exact:true})).toBeVisible();await page.reload();
 await expect(scenarioPicker(page,'A: игрок 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[4]!.playerId!);
 await expect(page.getByLabel('Автоподстановка ролей A',{exact:true})).not.toBeChecked();
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await region.screenshot({path:'test-results/role-profiles-mobile.png'});
});
test('owner can edit explicit provider bindings from roster choices and persist a new revision',async({page})=>{
 const q=await prepare(page);const region=page.getByRole('region',{name:'Автоопределение ролей A',exact:true});
 await region.getByText('Сопоставление источников A',{exact:true}).click();
 await expect(region.getByLabel('ID команды STRATZ A',{exact:true})).toHaveValue('77');
 await region.getByText('Идентификаторы источников A',{exact:true}).click();
 await region.getByLabel('ID команды STRATZ A',{exact:true}).fill('78');
 await region.getByLabel('Подтверждаю соответствие команды и игроков источникам A',{exact:true}).check();
 await region.getByRole('button',{name:'Сохранить сопоставление A',exact:true}).click();
 await expect(region.getByText('Редакция 2.',{exact:false})).toBeVisible();await page.reload();
 await pickScenario(page,'Команда A: поиск по названию',q.teamAId);
 const after=page.getByRole('region',{name:'Автоопределение ролей A',exact:true});await after.getByText('Сопоставление источников A',{exact:true}).click();
 await expect(after.getByLabel('ID команды STRATZ A',{exact:true})).toHaveValue('78');
});
test('source diagnostics separate missing profile, unknown team and stale cache without refreshing or changing manual roles',async({page})=>{
 const q=scenarioInput(),refreshes:boolean[]=[],errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/v1/lineup-role-profiles',async route=>{
  const input=route.request().postDataJSON();refreshes.push(input.refreshProfiles===true);
  const response=await route.fetch(),body=await response.json();
  if(input.teamId===q.teamAId){
   // Synthetic response states only; no live provider requests or saved binding changes.
   for(const [index,p] of body.players.entries()){
    const source=body.sources.find((s:{sourceKey:string})=>s.sourceKey===`stratz:player:${p.accountIds[0]}`);
    if(!source||index>2)continue;
    source.status=index===2?'stale':'ready';source.reason=null;
    source.observation={provider:'stratz',sourceKey:source.sourceKey,fetchedAt:'2026-11-05T00:00:00.000Z',knownAt:null,eventAt:null,payloadSha256:'a'.repeat(64),players:index===1?[]:[{accountId:p.accountIds[0],providerPlayerId:p.accountIds[0],providerTeamId:null,name:'Synthetic unknown team',roles:[3]}]};
    const candidate=p.candidates.find((c:{source:string})=>c.source==='stratz');
    candidate.eligible=false;candidate.reason='TEAM_BINDING_MISSING';candidate.roles=index===1?[]:[3];
   }
  }
  await route.fulfill({response,json:body});
 });
 await prepare(page);const region=page.getByRole('region',{name:'Автоопределение ролей A',exact:true});
 for(const p of q.lineupA)await region.locator(`[data-role-player-id="${p.playerId}"] > details`).locator('summary').first().click();
 await expect(region).toContainText('STRATZ не указал команду игрока');
 await expect(region).toContainText('STRATZ не вернул профессиональный профиль');
 await expect(region).toContainText('Данные устарели и не участвуют в автоподстановке');
 await region.getByText('Время обновления источников A',{exact:true}).click();
 await expect(region).toContainText('Ответ получен, но профиль не найден');
 expect(refreshes.every(v=>!v)).toBe(true);
 await expect(page.getByLabel('Автоподстановка ролей A',{exact:true})).not.toBeChecked();
 for(const p of q.lineupA)await expect(scenarioPicker(page,`A: игрок ${6-p.rolePos}`).getByRole('status')).toHaveAttribute('data-selected-id',p.playerId!);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await region.screenshot({path:'test-results/role-source-status-mobile.png'});expect(errors).toEqual([]);
});

test('matching names keep duplicate players distinct, preserve external IDs and save only the explicit numeric choices',async({page})=>{
 const refreshes:boolean[]=[],metadata:string[]=[];
 page.on('request',r=>{if(r.url().endsWith('/lineup-role-profiles'))refreshes.push(r.postDataJSON()?.refreshProfiles===true);if(/\/(catalog-labels|context-catalog)\?/.test(r.url()))metadata.push(r.url());});
 const q=await prepare(page),region=page.getByRole('region',{name:'Автоопределение ролей A',exact:true});
 const prepared=page.waitForResponse(r=>r.url().endsWith('/lineup-role-profiles')&&r.request().postDataJSON()?.refreshProfiles===true);await region.getByRole('button',{name:'Обновить профили API A',exact:true}).click();await prepared;refreshes.length=0;metadata.length=0;
 await region.getByText('Сопоставление источников A',{exact:true}).click();const matching=region.locator('[data-source-matching="A"]');
 await expect(matching.locator('[data-matching-player-id]')).toHaveCount(5);
 const first=matching.locator(`[data-matching-player-id="${q.lineupA[0]!.playerId}"]`),second=matching.locator(`[data-matching-player-id="${q.lineupA[1]!.playerId}"]`);
 await expect(first.locator('[data-matching-name]')).toHaveText('Synthetic Twin');await expect(second.locator('[data-matching-name]')).toHaveText('Synthetic Twin');
 await expect(matching.getByText('Ник повторяется. Сверьте локальный ID и выбранную запись источника.',{exact:true})).toHaveCount(2);
 await expect(first.getByText('Локальный ID игрока: '+q.lineupA[0]!.playerId,{exact:true})).not.toBeVisible();await first.getByText('Данные выбранного игрока',{exact:true}).click();await expect(first.getByText('Локальный ID игрока: '+q.lineupA[0]!.playerId,{exact:true})).toBeVisible();
 await expect(matching.getByLabel('ID команды STRATZ A',{exact:true})).not.toBeVisible();await matching.getByText('Идентификаторы источников A',{exact:true}).click();
 const before=await(await page.request.get('/api/v1/teams/'+q.teamAId+'/role-profile-binding')).json();
 await expect(matching.getByLabel('ID турнира PandaScore A',{exact:true})).toHaveValue('55');await expect(matching.getByLabel('ID команды PandaScore A',{exact:true})).toHaveValue('88');
 const confirm=matching.getByLabel('Подтверждаю соответствие команды и игроков источникам A',{exact:true});await confirm.check();
 await first.getByRole('combobox').selectOption('2001');await expect(confirm).not.toBeChecked();await second.getByRole('combobox').selectOption('2000');
 const response=page.waitForResponse(r=>r.url().endsWith('/role-profile-binding')&&r.request().method()==='POST');await confirm.check();await matching.getByRole('button',{name:'Сохранить сопоставление A',exact:true}).click();
 const saved=await response;expect(saved.status(),await saved.text()).toBe(200);const input=saved.request().postDataJSON();expect(input.expectedRevision).toBe(before.revision);
 expect(input.binding).toMatchObject({stratzTeamId:before.binding.stratzTeamId,pandaTournamentId:'55',pandaTeamId:'88'});
 expect(Object.fromEntries(input.binding.pandaPlayers.map((p:{playerId:string;providerPlayerId:string})=>[p.playerId,p.providerPlayerId]))).toEqual(Object.fromEntries(q.lineupA.map((p,i)=>[p.playerId,String(i===0?2001:i===1?2000:2000+i)])));
 expect((await saved.json()).revision).toBe(before.revision+1);expect(refreshes.every(v=>!v)).toBe(true);expect(metadata).toEqual([]);
 await expect(region.getByLabel('Автоподстановка ролей A',{exact:true})).not.toBeChecked();for(const p of q.lineupA)await expect(page.getByLabel(`A: роль игрока ${6-p.rolePos}`,{exact:true})).toHaveValue(String(6-p.rolePos));
 await matching.screenshot({path:'test-results/source-matching-desktop.png'});await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await first.screenshot({path:'test-results/source-matching-mobile.png'});
});

test('a saved Panda entry missing from the loaded roster remains selected without inventing its name or rewriting the binding',async({page})=>{
 const q=scenarioInput(),owner=(await sql<{id:string}>`SELECT id FROM app_users`.execute(database.db)).rows[0]!.id,repo=new RoleProfileRepository(database.db),old=await repo.binding(owner,q.teamAId);
 await repo.saveBinding(owner,q.teamAId,{requestId:randomUUID(),expectedRevision:old.revision,confirmedByOwner:true,binding:{...old.binding,pandaPlayers:old.binding.pandaPlayers.map(p=>p.playerId===q.lineupA[0]!.playerId?{...p,providerPlayerId:'2999'}:p)}});
 await prepare(page);const before=await(await page.request.get('/api/v1/teams/'+q.teamAId+'/role-profile-binding')).json(),region=page.getByRole('region',{name:'Автоопределение ролей A',exact:true});
 const prepared=page.waitForResponse(r=>r.url().endsWith('/lineup-role-profiles')&&r.request().postDataJSON()?.refreshProfiles===true);await region.getByRole('button',{name:'Обновить профили API A',exact:true}).click();await prepared;
 await region.getByText('Сопоставление источников A',{exact:true}).click();const first=region.locator(`[data-matching-player-id="${q.lineupA[0]!.playerId}"]`);
 await expect(first.locator('[data-matching-name]')).toHaveText('Synthetic Twin');await expect(first.getByRole('combobox')).toHaveValue('2999');await expect(first.getByRole('option',{selected:true})).toContainText('2999');await expect(first.getByRole('option',{selected:true})).toContainText('нет в загруженной заявке');
 expect(await(await page.request.get('/api/v1/teams/'+q.teamAId+'/role-profile-binding')).json()).toEqual(before);
});
