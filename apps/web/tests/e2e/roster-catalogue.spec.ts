import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {sql,IdentityRepository} from '../../../../packages/db/dist/index.js';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {syntheticSchedule,syntheticRosters,scheduleToken} from '../../../../tests/helpers/upcoming';
import {syntheticCatalogue} from '../../../../tests/helpers/roster-catalogue';
import {syntheticPlayerHistory} from '../../../../tests/helpers/player-history';
import {createPlayerHistoryQueue,registerPlayerHistoryWorker} from '../../../../packages/ingestion/dist/index.js';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
// These steps deliberately reuse the roster saved by the preceding owner journey.
// A worker restart cannot safely continue the later steps on a fresh database.
test.describe.configure({mode:'serial'});
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
let historyBoss:Awaited<ReturnType<typeof createPlayerHistoryQueue>>;const historyCalls:string[]=[];
const source=syntheticCatalogue({withoutMembership:true});
async function startApi(){
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:scheduleToken}),{
  db:database.db,logger:false,catalogueProvider:source.provider,pandascoreFetch:async url=>new Response(JSON.stringify(url.pathname.endsWith('/rosters')?syntheticRosters():syntheticSchedule()))});
 await api.listen({host:'127.0.0.1',port:3151});
}
test.beforeAll(async()=>{
 database=await testDatabase();password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-catalogue-ui',password);
 await startApi();
 historyBoss=await createPlayerHistoryQueue(database.url);await registerPlayerHistoryWorker(historyBoss,database.db,()=>syntheticPlayerHistory({onCall:n=>historyCalls.push(n)}));
});
test.afterAll(async()=>{await historyBoss?.stop({graceful:true,timeout:10000});await api?.close();await database?.close();});
async function sourcePick(page:Page,label:string,id:string,query=id){const field=page.getByRole('region',{name:label,exact:true});
 if(label.startsWith('Аккаунт ')&&!await field.isVisible()){const show=page.getByLabel('Показать подтверждённые аккаунты '+(label.endsWith('(B)')?'B':'A'),{exact:true});if(await show.isVisible())await show.check();}
 if(label.startsWith('Команда OpenDota ')){const switcher=page.getByRole('button',{name:'Выбрать команду OpenDota '+label.slice(-1),exact:true});if(await switcher.isVisible())await switcher.click();}
 await field.getByRole('searchbox').fill(query);await field.getByRole('button',{name:'Найти в OpenDota',exact:true}).click();
 await field.getByRole('button',{name:new RegExp(' · ID '+id+'$')}).click();
}
test('expected roster to explicit numeric catalogue, manual scenario and saved reuse without provider spam',async({page})=>{
 test.setTimeout(90000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-catalogue-ui');await page.getByLabel('Пароль').fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Предстоящие матчи →'}).click();
 await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
 await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();
 const a=page.getByRole('region',{name:'Соединение A',exact:true});
 await expect(a.getByText('Выбрано участников: 0 / 5.',{exact:true})).toBeVisible();
 await sourcePick(page,'Команда OpenDota A','71','Synthetic Alpha');
 for(let i=0;i<5;i++){
  await a.getByLabel(`Синтетический игрок 1-${i+1} — включить в пятёрку`,{exact:true}).check();
  await sourcePick(page,`Аккаунт Синтетический игрок 1-${i+1} (A)`,String(1001+i));
 }
 await expect(a.getByRole('button',{name:'Сохранить связи и подставить пятёрку A',exact:true})).toBeDisabled();
 await a.getByLabel('Подтверждаю соответствие команды и пяти аккаунтов A',{exact:true}).check();
 await a.getByRole('button',{name:'Сохранить связи и подставить пятёрку A',exact:true}).click();
 await expect(page.getByRole('region',{name:'Команда A в локальной базе',exact:true})).toContainText('Выбрано: Synthetic Alpha');
 await expect(a).toContainText('локальных pro-карт: 0');
 await expect(page.getByRole('region',{name:'Автоопределение ролей A',exact:true})).toContainText('Локальная pro-история: 0 / 5 игроков');
 await sourcePick(page,'Команда OpenDota B','72','Synthetic Beta');
 for(let i=0;i<5;i++)await sourcePick(page,`Аккаунт Синтетический игрок 2-${i+1} (B)`,String(1007+i));
 await page.getByLabel('Подтверждаю соответствие команды и пяти аккаунтов B',{exact:true}).check();
 await page.getByRole('button',{name:'Сохранить связи и подставить пятёрку B',exact:true}).click();
 await expect(page.getByRole('region',{name:'Команда B в локальной базе',exact:true})).toContainText('Выбрано: Synthetic Beta');
 const confirm=page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true});await expect(confirm).not.toBeChecked();
 await confirm.check();await expect(page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Создать ручной сценарий',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Сценарий · редакция 1',exact:true})).toBeVisible();
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM players`.execute(database.db)).rows[0]!.n).toBe(10);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM expected_roster_catalogue_bindings`.execute(database.db)).rows[0]!.n).toBe(2);
 expect([...source.calls].sort()).toEqual(['directory','registry','team:71','team:72'].sort());
 await page.goto('/upcoming');await page.getByRole('button',{name:'Выбрать',exact:true}).click();
 // Saved identities make comparison possible without opening technical forms or writing a scenario.
 await expect(page.getByRole('article',{name:'Выбранный состав A',exact:true})).toContainText('Synthetic Twin');
 await expect(page.getByRole('article',{name:'Выбранный состав B',exact:true})).toContainText('Выбрано 5 / 5');
 await expect(page.getByRole('region',{name:'Ожидаемые составы',exact:true}).getByRole('searchbox')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true})).toBeDisabled();
 const comparisons:Record<string,unknown>[]=[];page.on('request',r=>{if(r.url().endsWith('/teams/compare'))comparisons.push(r.postDataJSON());});
 await confirm.check();await page.getByLabel('Период сравнения',{exact:true}).selectOption('365');
 await page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true}).click();
 await expect(page.getByRole('region',{name:'Результат сравнения пятёрок',exact:true})).toBeVisible();
 await expect(page.getByRole('table',{name:'Личная статистика A',exact:true})).toContainText('Synthetic Twin');
 expect(Date.now()-Date.parse(comparisons[0]!.fromAt as string)).toBeGreaterThan(364*86400000);
 expect((await sql`SELECT id FROM scenarios`.execute(database.db)).rows).toHaveLength(1);
 expect([...source.calls].sort()).toEqual(['directory','registry','team:71','team:72'].sort());
 await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();
 await page.getByRole('region',{name:'Соединение B',exact:true}).getByText('Выбрать или исправить аккаунты B',{exact:true}).click();
 await page.getByRole('button',{name:'Подготовить игроков',exact:true}).click();
 await expect(page.getByRole('region',{name:'Команда OpenDota B',exact:true})).toContainText('Выбрано: Synthetic Beta · ID 72');
 await page.getByRole('button',{name:'Подставить сохранённую пятёрку A',exact:true}).click();
 const first=page.getByRole('region',{name:'A: игрок роли 1',exact:true});await expect(first).toContainText('Synthetic Twin');
 await first.getByRole('button',{name:'Сбросить',exact:true}).click();await page.getByRole('button',{name:'Перечитать связи',exact:true}).click();
 await expect(first.getByRole('status')).toHaveCount(0);expect(source.calls).toHaveLength(5);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('region',{name:'Подготовка составов из заявки',exact:true}).screenshot({path:'test-results/roster-catalogue-mobile.png'});
 expect(errors).toEqual([]);
});
test('a new organization can use its Panda identity without an OpenDota profile or invented team number',async({page})=>{
 test.setTimeout(60000);
 await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-catalogue-ui');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('link',{name:'Предстоящие матчи →'}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();
 const a=page.getByRole('region',{name:'Соединение A',exact:true});await a.getByText('Выбрать или исправить аккаунты A',{exact:true}).click();
 await a.getByLabel('Показать подтверждённые аккаунты A',{exact:true}).check();
 await a.getByRole('button',{name:'Использовать команду из заявки A',exact:true}).click();await expect(a).toContainText('Профиль организации OpenDota не требуется');
 for(let i=0;i<5;i++){await a.getByLabel(`Синтетический игрок 1-${i+1} — включить в пятёрку`,{exact:true}).check();await sourcePick(page,`Аккаунт Синтетический игрок 1-${i+1} (A)`,String(1001+i));}
 await a.getByLabel('Подтверждаю соответствие команды и пяти аккаунтов A',{exact:true}).check();
 const response=page.waitForResponse(r=>r.url().endsWith('/catalogue/apply')&&r.request().postDataJSON()?.teamProvider==='pandascore');
 await a.getByRole('button',{name:'Сохранить связи и подставить пятёрку A',exact:true}).click();const binding=await(await response).json();
 expect(binding.source.team.provider).toBe('pandascore');expect((await sql`SELECT opendota_team_id FROM teams WHERE id=${binding.teamId}`.execute(database.db)).rows[0]!.opendota_team_id).toBeNull();
 await expect(page.getByRole('region',{name:'Команда A в локальной базе',exact:true})).toContainText('Синтетическая Alpha');expect(source.calls).toHaveLength(5);
 const history=page.getByRole('region',{name:'Личная pro-история A',exact:true});
 await expect(history.getByLabel('Период истории A',{exact:true})).toHaveValue('365');await expect(history.getByLabel('Глубина истории A',{exact:true})).toHaveValue('25');
 await expect(history.getByRole('button',{name:'Загрузить историю игроков',exact:true})).toBeEnabled();
 const before=await page.getByRole('region',{name:'A: игрок роли 1',exact:true}).textContent();
 const historyStart=page.waitForResponse(r=>r.url().endsWith('/players/history-refresh')&&r.request().method()==='POST');
 const historyFinished=page.waitForResponse(async r=>{
  if(new URL(r.url()).pathname!=='/api/v1/players/history-refresh'||r.status()!==200)return false;
  const body=await r.json();return !!body.run?.finishedAt;
 });
 await history.getByRole('button',{name:'Загрузить историю игроков',exact:true}).click();
 expect((await historyStart).request().postDataJSON()).toMatchObject({windowDays:365,maxMaps:25});
 await historyFinished;
 await expect(history.getByText(/Принято 2 из 2 карт/)).toBeVisible();expect(historyCalls).toHaveLength(5);
 await expect(history.getByText(/Подготовка истории: подтверждено аккаунтов/)).toBeVisible();
 await expect(history.getByText(/Проверка истории V1:/)).toBeVisible();
 await expect(history.getByText(/допущено к истории Elo 0 \/ минимум 5/)).toHaveCount(5);
 await expect(history.getByRole('button',{name:'Загрузить историю игроков',exact:true})).toBeDisabled();
 await history.getByLabel('Период истории A',{exact:true}).selectOption('90');await history.getByLabel('Глубина истории A',{exact:true}).selectOption('10');
 await expect(history.getByText(/Принято 2 из 2 карт/)).toHaveCount(0);await expect(history.getByRole('button',{name:'Загрузить историю игроков',exact:true})).toBeEnabled();
 await history.getByLabel('Период истории A',{exact:true}).selectOption('365');await history.getByLabel('Глубина истории A',{exact:true}).selectOption('25');
 await expect(history.getByText(/Принято 2 из 2 карт/)).toBeVisible();expect(historyCalls).toHaveLength(5);
 expect(await page.getByRole('region',{name:'A: игрок роли 1',exact:true}).textContent()).toBe(before);
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await history.screenshot({path:'test-results/player-history-mobile.png'});
 await page.reload();await page.getByRole('button',{name:'Выбрать',exact:true}).click();await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();
 await page.getByRole('button',{name:'Подставить сохранённую пятёрку A',exact:true}).click();await expect(page.getByRole('region',{name:'Команда A в локальной базе',exact:true})).toContainText('Синтетическая Alpha');
 await expect(history.getByText(/Принято 2 из 2 карт/)).toBeVisible();expect(historyCalls).toHaveLength(5);
 await page.getByRole('region',{name:'A: игрок роли 1',exact:true}).getByRole('button',{name:'Сбросить',exact:true}).click();
 await expect(history.getByText('Сначала выберите пять различных игроков.',{exact:true})).toBeVisible();await expect(history.getByText(/Принято 2 из 2 карт/)).toHaveCount(0);
});

test('STRATZ profile absent from registry can join four catalogue accounts without clearing their selections',async({page})=>{
 await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-catalogue-ui');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('link',{name:'Предстоящие матчи →'}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();
 const b=page.getByRole('region',{name:'Соединение B',exact:true});await b.getByText('Выбрать или исправить аккаунты B',{exact:true}).click();await b.getByRole('button',{name:'Использовать команду из заявки B',exact:true}).click();
 for(let i=1;i<5;i++)await sourcePick(page,`Аккаунт Синтетический игрок 2-${i+1} (B)`,String(1007+i));
 const label='Аккаунт Синтетический игрок 2-1 (B)',profile=page.getByRole('region',{name:label,exact:true});
 await profile.getByRole('button',{name:'Найти в OpenDota',exact:true}).click();await expect(profile.getByRole('button',{name:/ · ID 1007$/})).toBeVisible();
 await sourcePick(page,label,'199','https://stratz.com/players/199?utm_source=twitch');
 await expect(b.getByText(/^Выбрано:/)).toHaveCount(5);await expect(profile).toContainText('отдельному профилю OpenDota');
 await b.getByLabel('Подтверждаю соответствие команды и пяти аккаунтов B',{exact:true}).check();
 const response=page.waitForResponse(r=>r.url().endsWith('/catalogue/apply'));
 await b.getByRole('button',{name:'Сохранить связи и подставить пятёрку B',exact:true}).click();const result=await(await response).json();
 expect(result.players[0]).toMatchObject({accountId:'199',identityStatus:'verified'});expect(result.source.profiles).toHaveLength(1);
 await expect(page.getByRole('region',{name:'Команда B в локальной базе',exact:true})).toContainText('Синтетическая Beta');
 expect(source.calls.filter(k=>k==='player:199')).toHaveLength(1);
 await page.reload();await page.getByRole('button',{name:'Выбрать',exact:true}).click();await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();
 await expect(page.getByRole('region',{name:'Соединение B',exact:true})).toContainText('Synthetic new nickname 199 · аккаунт 199');
 await page.getByRole('button',{name:'Подставить сохранённую пятёрку B',exact:true}).click();await expect(page.getByRole('region',{name:'B: игрок роли 1',exact:true})).toContainText('Synthetic new nickname 199');
});
test('batch preparation reuses saved identities, counts accounts and preserves manual corrections',async({page})=>{
 await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-catalogue-ui');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('link',{name:'Предстоящие матчи →'}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();
 const b=page.getByRole('region',{name:'Соединение B',exact:true});await b.getByText('Выбрать или исправить аккаунты B',{exact:true}).click();
 await expect(b).toContainText('Выбрано аккаунтов: 5 / 5.');
 await page.getByRole('button',{name:'Подготовить игроков',exact:true}).click();await expect(b).toContainText('Связь сохранена');await expect(b).toContainText('Выбрано аккаунтов: 5 / 5.');
 await expect(b.getByRole('region',{name:'Аккаунт Синтетический игрок 2-2 (B)',exact:true})).not.toBeVisible();
 await expect(b).toContainText('Все аккаунты этой команды подтверждены');
 const showConfirmed=b.getByLabel('Показать подтверждённые аккаунты B',{exact:true});await showConfirmed.check();
 await expect(b.getByLabel('Подтверждаю соответствие команды и пяти аккаунтов B',{exact:true})).not.toBeChecked();
 const picker=page.getByRole('region',{name:'Аккаунт Синтетический игрок 2-2 (B)',exact:true});
 await sourcePick(page,'Аккаунт Синтетический игрок 2-2 (B)','199','Synthetic undiscovered');await expect(picker.getByText('Выбрано: Synthetic new nickname 199 · ID 199',{exact:true})).toBeVisible();
 await b.getByLabel('Подтверждаю соответствие команды и пяти аккаунтов B',{exact:true}).check();await expect(b.getByRole('button',{name:'Сохранить связи и подставить пятёрку B',exact:true})).toBeDisabled();
 await sourcePick(page,'Аккаунт Синтетический игрок 2-2 (B)','1003');
 await expect(picker.getByText('Выбрано: Synthetic Player 3 · ID 1003',{exact:true})).toBeVisible();const calls=source.calls.length;
 await showConfirmed.uncheck();await expect(picker).toBeVisible();
 await expect(b.getByRole('region',{name:'Аккаунт Синтетический игрок 2-3 (B)',exact:true})).not.toBeVisible();
 await expect(b).toContainText('Выбран другой аккаунт — изменение ещё не сохранено');
 await page.getByRole('button',{name:'Подготовить игроков',exact:true}).click();await expect(page.getByRole('button',{name:'Подготовить игроков',exact:true})).toBeEnabled();
 await expect(picker.getByText('Выбрано: Synthetic Player 3 · ID 1003',{exact:true})).toBeVisible();expect(source.calls).toHaveLength(calls);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('region',{name:'Подготовка составов из заявки',exact:true}).screenshot({path:'test-results/unified-player-catalogue-mobile.png'});
});

test('an unusable saved five is not auto-applied and a delayed binding cannot overwrite manual input',async({page})=>{
 // Keep the saved synthetic records, but isolate this race test's HTTP quota from earlier searches.
 await api.close();await startApi();
 await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-catalogue-ui');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('link',{name:'Предстоящие матчи →'}).click();
 await expect(page.getByRole('button',{name:'Выбрать',exact:true})).toBeVisible();
 await page.route('**/api/v1/upcoming/*/catalogue',async route=>{
  const response=await route.fetch(),data=await response.json();data.teams[0].binding.usable=false;await route.fulfill({response,json:data});
 });
 await page.getByRole('button',{name:'Выбрать',exact:true}).click();
 await expect(page.getByRole('article',{name:'Выбранный состав B',exact:true})).toContainText('Выбрано 5 / 5');
 await expect(page.getByRole('article',{name:'Выбранный состав A',exact:true})).toContainText('Выбрано 0 / 5');
 await page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true}).check();
 await expect(page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true})).toBeDisabled();
 await page.unroute('**/api/v1/upcoming/*/catalogue');await page.reload();
 await expect(page.getByRole('button',{name:'Выбрать',exact:true})).toBeVisible();
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 await page.route('**/api/v1/upcoming/*/catalogue',async route=>{const response=await route.fetch();await gate;await route.fulfill({response});});
 await page.getByRole('button',{name:'Выбрать',exact:true}).click();await page.getByRole('button',{name:'Изменить игроков и роли',exact:true}).click();
 const picker=page.getByRole('region',{name:'Команда A в локальной базе',exact:true});await picker.getByRole('searchbox').fill('Synthetic');
 await picker.getByRole('searchbox').press('Enter');await picker.getByRole('button',{name:/^Выбрать Synthetic Alpha · ID /}).click();
 const response=page.waitForResponse(r=>r.url().endsWith('/catalogue'));release();await response;
 await expect(page.getByRole('article',{name:'Выбранный состав A',exact:true})).toContainText('Synthetic Alpha');
 await expect(page.getByRole('article',{name:'Выбранный состав A',exact:true})).toContainText('Выбрано 0 / 5');
 await expect(page.getByRole('article',{name:'Выбранный состав B',exact:true})).toContainText('Выбрано 0 / 5');
 await expect(page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true})).toBeDisabled();
});

test('a saved five can correct one local account without preparing the roster again',async({page})=>{
 const at=new Date().toISOString();
 await sql`INSERT INTO players(id,nickname) VALUES(99007,'Synthetic saved correction')`.execute(database.db);
 await new IdentityRepository(database.db).appendAccountEvidence({playerId:'99007',externalAccountId:'299007',provider:'opendota',status:'verified',eventAt:null,knownAt:at,fetchedAt:at,source:'synthetic',evidenceRef:'synthetic saved-five correction'});
 await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-catalogue-ui');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('link',{name:'Предстоящие матчи →'}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
 await expect(page.getByRole('article',{name:'Выбранный состав B',exact:true})).toContainText('Выбрано 5 / 5');
 const preparationRequests:string[]=[];page.on('request',r=>{if(r.url().endsWith('/catalogue/prepare'))preparationRequests.push(r.url());});
 await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();
 const b=page.getByRole('region',{name:'Соединение B',exact:true});await b.getByText('Выбрать или исправить аккаунты B',{exact:true}).click();
 await b.getByLabel('Показать подтверждённые аккаунты B',{exact:true}).check();
 const before=source.calls.length,save=b.getByRole('button',{name:'Сохранить связи и подставить пятёрку B',exact:true});
 await sourcePick(page,'Аккаунт Синтетический игрок 2-2 (B)','299007');
 await expect(b).toContainText('Выбрано участников: 5 / 5.');await expect(b).toContainText('Выбрано аккаунтов: 5 / 5.');
 await expect(save).toBeDisabled();
 await b.getByLabel('Подтверждаю соответствие команды и пяти аккаунтов B',{exact:true}).check();await expect(save).toBeEnabled();
 const applied=page.waitForResponse(r=>r.url().endsWith('/catalogue/apply')&&r.request().method()==='POST');await save.click();expect((await applied).status()).toBe(200);
 await expect(page.getByRole('article',{name:'Выбранный состав B',exact:true})).toContainText('Synthetic saved correction');
 expect(source.calls).toHaveLength(before);expect(preparationRequests).toEqual([]);
 await page.reload();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
 await expect(page.getByRole('article',{name:'Выбранный состав B',exact:true})).toContainText('Synthetic saved correction');
});

test('continues evidence checks in the selected history without downloading or changing the five',async({page})=>{
 await sql`UPDATE player_history_runs SET next_allowed_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-catalogue-ui');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('link',{name:'Предстоящие матчи →'}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
 await page.getByRole('button',{name:'Изменить игроков и роли',exact:true}).click();
 const history=page.getByRole('region',{name:'Личная pro-история A',exact:true}),resume=history.getByRole('button',{name:'Продолжить проверку загруженных карт',exact:true});
 await expect(resume).toBeEnabled();
 const before=historyCalls.length,selection=await page.getByRole('article',{name:'Выбранный состав A',exact:true}).innerText();
 const response=page.waitForResponse(r=>r.url().endsWith('/players/history-refresh/resume')&&r.request().method()==='POST');
 await resume.click();expect((await response).status()).toBe(202);
 await expect(history.getByText(/Повторно проверено 2 из 2 карт/)).toBeVisible({timeout:15000});
 await expect(history.getByText(/Исходные записи и время получения сохранены отдельно/)).toBeVisible();
 expect(historyCalls).toHaveLength(before);expect(await page.getByRole('article',{name:'Выбранный состав A',exact:true}).innerText()).toBe(selection);
 await expect(resume).toBeDisabled();
 await page.reload();await page.getByRole('button',{name:'Выбрать',exact:true}).click();await page.getByRole('button',{name:'Изменить игроков и роли',exact:true}).click();
 await expect(history.getByText(/Повторно проверено 2 из 2 карт/)).toBeVisible();expect(historyCalls).toHaveLength(before);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
