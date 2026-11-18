import {test,expect,type Page} from '@playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedDraft,draftInput} from '../../../../tests/helpers/draft';
import {ScenarioRepository,sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';

let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,ownerId:string;
test.setTimeout(60000);
test.use({actionTimeout:20000});
test.beforeAll(async()=>{
  database=await testDatabase();await seedDraft(database.db);
  password=randomBytes(24).toString('base64url');ownerId=(await new AuthService(database.db).provision('synthetic-capture-browser',password)).id;
});
// Each navigation-heavy case gets the real, unchanged rate limit independently.
test.beforeEach(async()=>{
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});
  await api.listen({host:'127.0.0.1',port:3151});
});
test.afterEach(async()=>{await api?.close();});
test.afterAll(async()=>{await database?.close();});
async function open(page:Page,targetId?:string){
  const s=await new ScenarioRepository(database.db).save(ownerId,draftInput());
  await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-capture-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
  await page.goto(`/scenarios/${s.id}/draft${targetId?'?scheduleTarget='+targetId:''}`);
  await expect(page.getByRole('heading',{name:'Сценарий · редакция 1',exact:true})).toBeVisible({timeout:20000});return s.id;
}
async function fill(page:Page){for(let i=0;i<10;i++)await page.getByRole('combobox',{name:`${i<5?'A':'B'}: герой роли ${i%5+1}`,exact:true}).selectOption(String(i+1));}
const panel=(page:Page)=>page.getByRole('region',{name:'Снимок драфта',exact:true});
const save=(page:Page)=>page.getByRole('button',{name:'Сохранить карту',exact:true}).click();

test('history summary shows saved counts, retries read failure and explains legacy absence at 360px',async({page})=>{
  const id=await open(page);let reads=0;
  await page.route(`**/scenarios/${id}/draft-captures/*/history-summary`,async route=>{
    if(++reads===1)await route.fulfill({status:503,json:{error:{code:'SYNTHETIC_READ_FAILURE'}}});
    else await route.continue();
  });
  await fill(page);await save(page);
  const history=page.getByRole('region',{name:'Проверенная история драфта',exact:true});
  await expect(history.getByRole('alert')).toContainText('Не удалось прочитать');
  await history.getByRole('button',{name:'Повторить чтение истории'}).click();
  await expect(history).toContainText('нет доступного подтверждения источника исходов');
  await expect(history).toContainText('модель ещё не активирована');expect(reads).toBe(2);
  await page.unroute(`**/scenarios/${id}/draft-captures/*/history-summary`);
  await page.route(`**/scenarios/${id}/draft-captures/*/history-summary`,route=>route.fulfill({json:{status:'saved',
    recordedAt:'2026-11-14T12:00:00.000001Z',readAt:'2026-11-14T12:00:00.000000Z',maps:2,verifiedMaps:1,excludedMaps:1,reasons:['TEAM_SIDES_UNKNOWN'],forecastStatus:'unavailable'}}));
  await page.reload();await expect(history).toContainText('Проверенных исходов: 1 из 2');
  await expect(history).toContainText('неизвестны команды или стороны');
  await page.unroute(`**/scenarios/${id}/draft-captures/*/history-summary`);
  await page.route(`**/scenarios/${id}/draft-captures/*/history-summary`,route=>route.fulfill({json:{status:'missing',
    recordedAt:null,readAt:null,maps:null,verifiedMaps:null,excludedMaps:null,reasons:['PRE_CUTOFF_HISTORY_OBSERVATION_MISSING'],forecastStatus:'unavailable'}}));
  await page.reload();await expect(history).toContainText('Сохраните новую редакцию полного драфта');
  await expect(history).not.toContainText('0 из 0');
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await history.screenshot({path:'test-results/draft-history-summary-mobile.png'});
});

test('full save captures once with appointment; partial stays uncaptured and reload reads identical snapshot',async({page})=>{
  const target=randomUUID(),id=await open(page,target),posts:unknown[]=[];
  page.on('request',r=>{if(r.url().endsWith('/draft-captures')&&r.method()==='POST')posts.push(r.postDataJSON());});
  await page.getByRole('combobox',{name:'A: герой роли 1',exact:true}).selectOption('1');await save(page);
  await expect(page.getByRole('heading',{name:'Сценарий · редакция 2',exact:true})).toBeVisible();expect(posts).toHaveLength(0);await expect(panel(page)).toHaveCount(0);
  await fill(page);await save(page);
  await expect(panel(page)).toContainText('Снимок сохранён с ограничениями.');expect(posts).toEqual([{expectedRevision:3,scheduleTargetRequestId:target}]);
  const shadow=page.getByRole('region',{name:'Исследовательский расчёт драфта',exact:true});
  await expect(shadow).toContainText('Попытка расчёта сохранена.');await expect(shadow).toContainText('Запись результата подтверждена');
  await expect(panel(page)).toContainText('Нет проверенной ссылки');
  const before=await sql<{id:string;snapshot_sha256:string}>`SELECT id,snapshot_sha256 FROM owner_draft_captures WHERE scenario_id=${id}::uuid`.execute(database.db);expect(before.rows).toHaveLength(1);
  await page.goto(`/scenarios/${id}/draft`);await expect(panel(page)).toContainText('Снимок сохранён с ограничениями.');expect(posts).toHaveLength(1);
  const after=await sql<{id:string;snapshot_sha256:string}>`SELECT id,snapshot_sha256 FROM owner_draft_captures WHERE scenario_id=${id}::uuid`.execute(database.db);expect(after.rows).toEqual(before.rows);
  await page.setViewportSize({width:360,height:800});await panel(page).getByText('Данные снимка',{exact:true}).click();
  await expect(panel(page)).toContainText('не прогноз');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await panel(page).screenshot({path:'test-results/draft-capture-mobile.png'});
});

test('unfinished shadow persistence resumes without a new scenario or duplicate result and respects dirty edits',async({page})=>{
  await open(page);
  const q=draftInput();q.draft!.assignments=(['A','B'] as const).flatMap((teamSlot,j)=>Array.from({length:5},(_,i)=>({teamSlot,rolePos:i+1,heroId:j*5+i+1})));
  const s=await new ScenarioRepository(database.db).save(ownerId,q);
  const {DraftCaptureRepository}=await import('../../../api/src/modules/scenarios/draft-capture-repository.js');
  const c=await new DraftCaptureRepository(database.db).create(ownerId,s.id,{expectedRevision:1});
  await page.goto(`/scenarios/${s.id}/draft`);
  const shadow=page.getByRole('region',{name:'Исследовательский расчёт драфта',exact:true});
  await expect(shadow).toContainText('Сохранение исследовательского расчёта ещё не завершено');
  const button=shadow.getByRole('button',{name:'Завершить сохранение расчёта'});
  await page.getByRole('combobox',{name:'A: герой роли 1',exact:true}).selectOption('11');await expect(button).toBeDisabled();
  await page.reload();await button.click();await expect(shadow).toContainText('Попытка расчёта сохранена.');
  await expect(shadow).toContainText('Запись результата подтверждена');
  const rows=(await sql`SELECT result_sha256 FROM owner_draft_shadow_runs WHERE capture_id=${c.id}::uuid`.execute(database.db)).rows;
  expect(rows).toHaveLength(1);await page.reload();await expect(shadow).toContainText('Попытка расчёта сохранена.');
  expect((await sql`SELECT result_sha256 FROM owner_draft_shadow_runs WHERE capture_id=${c.id}::uuid`.execute(database.db)).rows).toEqual(rows);
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await shadow.screenshot({path:'test-results/draft-shadow-mobile.png'});
});

test('lost POST response recovers committed snapshot with GET, preserving edits and avoiding duplicate POST',async({page})=>{
  const id=await open(page);let posts=0;
  await page.route(`**/scenarios/${id}/draft-captures`,async route=>{
    posts++;const response=await route.fetch();expect(response.status()).toBe(200);
    await route.fulfill({status:503,json:{error:{code:'SYNTHETIC_LOST_RESPONSE'}}});
  });
  await fill(page);await save(page);await expect(panel(page).getByRole('alert')).toContainText('Сама редакция карты сохранена');
  await panel(page).getByRole('button',{name:'Повторить запрос снимка'}).click();
  await expect(panel(page)).toContainText('Снимок сохранён с ограничениями.');expect(posts).toBe(1);
  const hero=page.getByRole('combobox',{name:'A: герой роли 1',exact:true});await hero.selectOption('11');
  await expect(panel(page)).toContainText('Есть новые правки');await expect(hero).toHaveValue('11');
  await hero.selectOption('1'); // Form remains dirty until explicitly saved/reloaded.
  await page.reload();await expect(panel(page)).toContainText('Снимок сохранён с ограничениями.');expect(posts).toBe(1);
  await expect(hero).toHaveValue('1');
});

test('failed read and POST can retry; conflict offers reload and next revision has independent status',async({page})=>{
  const id=await open(page);let reads=0,posts=0;
  await page.route(`**/scenarios/${id}/draft-captures/*`,async route=>{
    if(++reads===1)await route.fulfill({status:503,json:{error:{code:'SYNTHETIC_READ_FAILURE'}}});else await route.continue();
  });
  await page.route(`**/scenarios/${id}/draft-captures`,async route=>{
    if(++posts===1)await route.fulfill({status:503,json:{error:{code:'SYNTHETIC_WRITE_FAILURE'}}});
    else if(posts===2)await route.fulfill({status:409,json:{error:{code:'CONFLICT'}}});else await route.continue();
  });
  await fill(page);await save(page);await expect(panel(page).getByRole('alert')).toContainText('Не удалось прочитать');
  await panel(page).getByRole('button',{name:'Повторить запрос снимка'}).click();await expect(panel(page).getByRole('alert')).toContainText('Сама редакция карты сохранена');
  await panel(page).getByRole('button',{name:'Повторить запрос снимка'}).click();await expect(panel(page).getByRole('alert')).toContainText('Редакция или назначение карты изменились');
  await panel(page).getByRole('button',{name:'Загрузить сохранённую редакцию · заменить мои правки'}).click();
  await page.getByRole('combobox',{name:'A: герой роли 1',exact:true}).selectOption('11');await save(page);
  await expect(panel(page)).toContainText('редакция 3');await expect(panel(page)).toContainText('Снимок сохранён с ограничениями.');
  await expect(panel(page).getByRole('alert')).toHaveCount(0);expect(posts).toBe(3);
});

test('leaving during capture cannot attach a delayed response to another scenario',async({page})=>{
  const id=await open(page),other=await new ScenarioRepository(database.db).save(ownerId,draftInput());
  let release!:()=>void;const delayed=new Promise<void>(resolve=>{release=resolve;});
  let committed!:()=>void;const received=new Promise<void>(resolve=>{committed=resolve;});
  await page.route(`**/scenarios/${id}/draft-captures`,async route=>{
    const response=await route.fetch();expect(response.status()).toBe(200);committed();await delayed;
    await route.fulfill({response}).catch(()=>{}); // Navigation may already have aborted the browser request.
  });
  try{
    await fill(page);await save(page);await received;
    await expect(panel(page)).toContainText('Фиксируем игроков');
    await page.goto(`/scenarios/${other.id}/draft`);release();
    await expect(page.getByRole('heading',{name:'Сценарий · редакция 1',exact:true})).toBeVisible();await expect(panel(page)).toHaveCount(0);
    await page.goto(`/scenarios/${id}/draft`);await expect(panel(page)).toContainText('Снимок сохранён с ограничениями.');
  }finally{release();}
});
