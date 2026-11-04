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
test.beforeAll(async()=>{
 database=await testDatabase();await seedProMaps(database.db);password=randomBytes(24).toString('base64url');
 await new AuthService(database.db).provision('synthetic-profile-browser',password);
 const owner=(await sql<{id:string}>`SELECT id FROM app_users`.execute(database.db)).rows[0]!.id,q=scenarioInput();
 await new RoleProfileRepository(database.db).saveBinding(owner,q.teamAId,{requestId:randomUUID(),expectedRevision:0,confirmedByOwner:true,
  binding:{stratzTeamId:'77',pandaTournamentId:'55',pandaTeamId:'88',pandaPlayers:q.lineupA.map((p,i)=>({playerId:p.playerId!,providerPlayerId:String(2000+i)}))}});
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',ROLE_PROFILES_ENABLED:'true',
  STRATZ_API_TOKEN:'synthetic-profile-stratz-key',PANDASCORE_API_TOKEN:'synthetic-profile-panda-key'}),{db:database.db,logger:false,roleProfileFetch:async(url,init)=>{
    if(String(url).includes('stratz')){const id=Number(String(init?.body).match(/steamAccountId:(\d+)/)?.[1]);return new Response(JSON.stringify({data:{player:{steamAccountId:id,
      steamAccount:{proSteamAccount:{id,name:'Synthetic profile',teamId:77,position:`POSITION_${id-999}`}}}}}));}
    return new Response(JSON.stringify({type:'Team',rosters:[{id:88,name:'Synthetic team',players:q.lineupA.map((_,i)=>({id:2000+i,name:'Synthetic player '+i,role:String(i+1)}))}]}));
  }});await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
async function prepare(page:Page){
 await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-profile-browser');await page.getByLabel('Пароль').fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();await page.goto('/scenarios/new');
 const q=scenarioInput();await page.getByLabel('Название',{exact:true}).fill('Синтетические роли API');
 await page.getByLabel('Команда A: ID организации',{exact:true}).fill(q.teamAId);await page.getByLabel('Команда B: ID организации',{exact:true}).fill(q.teamBId);
 await page.getByLabel('Автоподстановка ролей A',{exact:true}).uncheck();
 await page.getByLabel('Срез данных UTC',{exact:true}).fill('2024-01-03T00:00');
 for(const p of q.lineupA)await page.getByLabel(`A: игрок роли ${6-p.rolePos}`,{exact:true}).fill(p.playerId!);
 for(const p of q.lineupB)await page.getByLabel(`B: игрок роли ${p.rolePos}`,{exact:true}).fill(p.playerId!);
 return q;
}
test('API agreement automatically assigns roles, moves hero/stand-in, resets confirmation; saved/manual positions remain authoritative',async({page})=>{
 const debug:{kind:string;refresh?:boolean;status?:number;auto?:boolean;error?:string}[]=[];
 page.on('request',r=>{if(r.url().includes('/lineup-role-profiles'))debug.push({kind:'request',refresh:r.postDataJSON()?.refreshProfiles});});
 page.on('response',async r=>{if(r.url().includes('/lineup-role-profiles')){const body=await r.json().catch(()=>null);debug.push({kind:'response',status:r.status(),auto:body?.canAutoApply});}});
 page.on('pageerror',e=>debug.push({kind:'pageerror',error:e.message}));
 const q=await prepare(page),region=page.getByRole('region',{name:'Автоопределение ролей A',exact:true});
 await expect(region.getByRole('button',{name:'Обновить профили API A',exact:true})).toBeEnabled();
 await page.getByLabel('A: замена роли 5',{exact:true}).check();await page.getByRole('combobox',{name:'A: герой роли 5',exact:true}).selectOption('1');
 const confirm=page.getByLabel('Подтверждаю выбранные 5+5, роли и необязательные ожидаемые составы',{exact:true});await confirm.check();
 try{await Promise.all([page.waitForResponse(r=>r.url().endsWith('/lineup-role-profiles')&&r.request().method()==='POST'&&r.request().postDataJSON()?.refreshProfiles===true),region.getByRole('button',{name:'Обновить профили API A',exact:true}).click()]);}
 catch(e){console.log(JSON.stringify({roleBrowserDebug:debug}));throw e;}
 await region.getByLabel('Автоподстановка ролей A',{exact:true}).check();
 await expect(page.getByLabel('A: игрок роли 1',{exact:true})).toHaveValue(q.lineupA[0]!.playerId!);
 await expect(page.getByLabel('A: замена роли 1',{exact:true})).toBeChecked();await expect(page.getByRole('combobox',{name:'A: герой роли 1',exact:true})).toHaveValue('1');await expect(confirm).not.toBeChecked();
 await page.getByLabel('A: игрок роли 1',{exact:true}).fill(q.lineupA[4]!.playerId!);await page.getByLabel('A: игрок роли 5',{exact:true}).fill(q.lineupA[0]!.playerId!);
 await expect(region.getByLabel('Автоподстановка ролей A',{exact:true})).not.toBeChecked();
 await region.getByRole('button',{name:'Обновить профили API A',exact:true}).click();
 await expect(page.getByLabel('A: игрок роли 1',{exact:true})).toHaveValue(q.lineupA[4]!.playerId!);
 await confirm.check();await page.getByRole('button',{name:'Сохранить сценарий',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Сценарий · редакция 1',exact:true})).toBeVisible();await page.reload();
 await expect(page.getByLabel('A: игрок роли 1',{exact:true})).toHaveValue(q.lineupA[4]!.playerId!);
 await expect(page.getByLabel('Автоподстановка ролей A',{exact:true})).not.toBeChecked();
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/role-profiles-mobile.png',fullPage:true});
});
test('owner can edit explicit provider bindings from roster choices and persist a new revision',async({page})=>{
 const q=await prepare(page);const region=page.getByRole('region',{name:'Автоопределение ролей A',exact:true});
 await region.getByText('Сопоставление источников A',{exact:true}).click();
 await expect(region.getByLabel('ID команды STRATZ A',{exact:true})).toHaveValue('77');
 await region.getByLabel('ID команды STRATZ A',{exact:true}).fill('78');
 await region.getByLabel('Подтверждаю соответствие команды и игроков источникам A',{exact:true}).check();
 await region.getByRole('button',{name:'Сохранить сопоставление A',exact:true}).click();
 await expect(region.getByText('Редакция 2.',{exact:false})).toBeVisible();await page.reload();
 await page.getByLabel('Команда A: ID организации',{exact:true}).fill(q.teamAId);
 const after=page.getByRole('region',{name:'Автоопределение ролей A',exact:true});await after.getByText('Сопоставление источников A',{exact:true}).click();
 await expect(after.getByLabel('ID команды STRATZ A',{exact:true})).toHaveValue('78');
});
