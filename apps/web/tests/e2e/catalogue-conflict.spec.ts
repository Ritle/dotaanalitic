import {test,expect,type Page} from '@playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {syntheticSchedule,syntheticRosters,scheduleToken} from '../../../../tests/helpers/upcoming';
import {syntheticCatalogue} from '../../../../tests/helpers/roster-catalogue';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';

let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
const source=syntheticCatalogue(),route='/api/v1/upcoming/70001/catalogue';
test.beforeAll(async()=>{
 database=await testDatabase();password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-conflict',password);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:scheduleToken}),{
  db:database.db,logger:false,catalogueProvider:source.provider,pandascoreFetch:async url=>Response.json(url.pathname.endsWith('/rosters')?syntheticRosters():syntheticSchedule())});
 await api.listen({host:'127.0.0.1',port:3151});
},30000);
test.afterAll(async()=>{await api?.close();await database?.close();},30000);
async function login(page:Page){
 await page.goto('/upcoming');await page.getByLabel('Логин',{exact:true}).fill('synthetic-conflict');await page.getByLabel('Пароль',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Предстоящие матчи →'}).click();
}
test('real stale link conflict preserves manual five and reread permits an explicit fresh confirmation',async({page},testInfo)=>{
 test.setTimeout(90000);await login(page);
 // Independent authenticated HTTP requests represent another editor, no intercepted API responses.
 const auth=await page.request.get('/api/v1/auth/me'),csrf=(await auth.json()).csrfToken;
 const post=async(url:string,data:unknown)=>{const r=await page.request.post(url,{headers:{origin:'http://127.0.0.1:5179','x-csrf-token':csrf},data});expect(r.status(),await r.text()).toBe(200);return r.json();};
 await post('/api/v1/upcoming/refresh',{});await post('/api/v1/upcoming/tournaments/71001/refresh',{});
 const state=await(await page.request.get(route)).json();
 const base={providerTeamId:'74001',teamId:'74001',teamProvider:'pandascore',expectedRevision:0,rosterSha256:state.rosterSha256,
  registrySha256:source.registry.source.payloadSha256,players:Array.from({length:5},(_,i)=>({providerPlayerId:String(75001+i),accountId:String(1001+i)})),confirmedByOwner:true};
 const first=await post(route+'/apply',{...base,requestId:randomUUID()});
 await page.reload();await page.getByRole('button',{name:'Выбрать',exact:true}).click();await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();
 await page.getByRole('button',{name:'Подготовить игроков',exact:true}).click();await expect(page.getByText(/^Подготовлено /)).toBeVisible();
 const a=page.getByRole('region',{name:'Соединение A',exact:true});await a.getByText('Выбрать или исправить аккаунты A',{exact:true}).click();
 await a.getByLabel('Показать подтверждённые аккаунты A',{exact:true}).check();
 const player=page.getByRole('region',{name:'Аккаунт Синтетический игрок 1-1 (A)',exact:true});
 await player.getByRole('searchbox').fill('1006');await player.getByRole('button',{name:'Найти в OpenDota',exact:true}).click();
 await player.getByRole('button',{name:/ · ID 1006$/}).click();
 const current=await(await page.request.get(route)).json();
 const concurrent=await post(route+'/apply',{...base,requestId:randomUUID(),expectedRevision:first.revision,
  players:first.players.map((p:{providerPlayerId:string;accountId:string;playerId:string})=>({providerPlayerId:p.providerPlayerId,accountId:p.accountId,localPlayerId:p.playerId,
   linkToken:current.teams[0].players.find((r:{providerPlayerId:string})=>r.providerPlayerId===p.providerPlayerId).linkToken})),registrySha256:null});
 const confirm=a.getByLabel('Подтверждаю соответствие команды и пяти аккаунтов A',{exact:true});await confirm.check();
 const save=a.getByRole('button',{name:'Сохранить связи и подставить пятёрку A',exact:true});
 const failed=page.waitForResponse(r=>r.url().endsWith('/catalogue/apply'));await save.click();const failure=await failed;expect(failure.status()).toBe(409);
 await expect(a.getByRole('alert')).toContainText('Перечитайте связи');await expect(a.getByRole('alert')).not.toContainText('Сценарий');
 await expect(confirm).not.toBeChecked();await expect(save).toBeDisabled();await expect(player).toContainText('Выбрано: Synthetic Player 6 · ID 1006');
 await a.getByRole('alert').screenshot({path:testInfo.outputPath('conflict-desktop.png')});
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await a.getByRole('alert').screenshot({path:testInfo.outputPath('conflict-mobile.png')});await page.setViewportSize({width:1280,height:900});
 // Synthetic transport failure only: an unsuccessful reread must not unlock a stale confirmation.
 await page.route('**/api/v1/upcoming/70001/catalogue',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}),{times:1});
 await page.getByRole('button',{name:'Перечитать связи',exact:true}).click();
 await expect(page.getByRole('button',{name:'Повторить чтение составов',exact:true})).toBeVisible();
 await expect(confirm).toBeDisabled();await expect(save).toBeDisabled();await expect(player).toContainText('Выбрано: Synthetic Player 6 · ID 1006');
 const read=page.waitForResponse(r=>r.url().endsWith('/70001/catalogue')&&r.request().method()==='GET');
 await page.getByRole('button',{name:'Повторить чтение составов',exact:true}).click();expect((await read).status()).toBe(200);
 await expect(a).toContainText('редакция '+concurrent.revision);await expect(confirm).not.toBeChecked();
 await expect(player).toContainText('Выбрано: Synthetic Player 6 · ID 1006');await confirm.check();
 const success=page.waitForResponse(r=>r.url().endsWith('/catalogue/apply'));await save.click();const result=await success;expect(result.status(),await result.text()).toBe(200);
 const request=result.request().postDataJSON();expect(request.requestId).not.toBe(failure.request().postDataJSON().requestId);
 expect(request.expectedRevision).toBe(concurrent.revision);expect(request.players.map((p:{accountId:string})=>p.accountId)).toEqual(['1006','1002','1003','1004','1005']);
 expect((await result.json()).revision).toBe(concurrent.revision+1);
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
