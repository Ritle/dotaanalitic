import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedPredictionScenario} from '../../../../tests/helpers/predictions';
import {publishTargetSchedule,syntheticTargetMatch} from '../../../../tests/helpers/schedule-target';
import {sql} from '../../../../packages/db/src/index';

// A complete no-model acceptance path against the compiled API, never a live provider/model.
let database:Awaited<ReturnType<typeof testDatabase>>,server:ChildProcess|undefined,password:string;
const secret=randomBytes(32).toString('base64url'),login='synthetic-v1-acceptance';
const serverPath=fileURLToPath(new URL('../../../api/dist/server.js',import.meta.url));
const cliPath=fileURLToPath(new URL('../../../api/dist/modules/auth/owner-cli.js',import.meta.url));
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(){
  server=spawn(process.execPath,[serverPath],{windowsHide:true,stdio:'ignore',env:{...process.env,
    DATABASE_URL:database.url,NODE_ENV:'development',API_HOST:'127.0.0.1',API_PORT:'3151',
    WEB_ORIGIN:'http://127.0.0.1:5179',AUTH_COOKIE_SECRET:secret,PANDASCORE_API_TOKEN:''}});
  let failure:Error|undefined;server.once('error',e=>failure=e);
  for(let i=0;i<100;i++){
    if(failure||server.exitCode!==null)throw Error('Synthetic acceptance API did not start');
    try{if((await fetch('http://127.0.0.1:3151/health',{signal:AbortSignal.timeout(500)})).ok)return;}catch{/* bounded readiness poll */}
    await sleep(100);
  }
  throw Error('Synthetic acceptance API readiness timeout');
}
async function stop(){
  if(!server||server.exitCode!==null||server.signalCode!==null)return;
  const child=server,exit=once(child,'exit');child.kill();await exit;server=undefined;
}
test.beforeAll(async()=>{
  database=await testDatabase();await seedPredictionScenario(database.db);
  await publishTargetSchedule(database.db,[syntheticTargetMatch({scheduledAt:'2099-01-02T00:00:00.000Z'})]);
  password=randomBytes(24).toString('base64url');
  const output=execFileSync(process.execPath,[cliPath,'create','--login',login,'--password-stdin'],{
    env:{...process.env,DATABASE_URL:database.url},input:password+'\n',encoding:'utf8',stdio:['pipe','pipe','pipe'],windowsHide:true});
  expect(JSON.parse(output)).toEqual({status:'owner_created'});await start();
});
test.afterAll(async()=>{await stop();await database?.close();});
async function pick(page:Page,label:string,id:string){
  const region=page.getByRole('region',{name:label,exact:true});
  await region.getByRole('searchbox').fill(id);await region.getByRole('searchbox').press('Enter');
  await region.getByRole('button',{name:new RegExp(' · ID '+id+'$')}).click();
}
async function lifecycle(page:Page,action:string){
  const region=page.getByRole('region',{name:'Отмена и открытие встречи',exact:true});
  await region.getByLabel('Источник отметки',{exact:true}).fill('https://example.test/synthetic-acceptance');
  await region.getByLabel('Причина отметки',{exact:true}).fill('Synthetic owner-reviewed acceptance lifecycle');
  await region.getByLabel('Подтверждаю изменение состояния всей встречи',{exact:true}).check();
  await region.getByRole('button',{name:action,exact:true}).click();return region;
}
test('compiled owner CLI and API preserve the full no-model owner journey across a process restart and logout',async({page})=>{
  test.setTimeout(60000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/login');await page.getByLabel('Логин',{exact:true}).fill(login);await page.getByLabel('Пароль',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.getByRole('link',{name:'Предстоящие матчи →',exact:true}).click();
  await page.getByRole('button',{name:'Выбрать',exact:true}).click();
  await page.getByText('Зафиксировать назначение первой карты',{exact:true}).click();
  await page.getByLabel('Участник источника для команды A',{exact:true}).selectOption('74');
  await pick(page,'Назначение: локальная команда A','11');await pick(page,'Назначение: локальная команда B','22');
  await page.getByLabel('ID локального турнира · необязательно',{exact:true}).fill('77');
  await page.getByLabel('Источник сопоставления · HTTPS',{exact:true}).fill('https://example.test/synthetic-acceptance');
  await page.getByLabel('Обоснование сопоставления',{exact:true}).fill('Synthetic acceptance mapping by explicit organization and source IDs');
  await page.getByLabel('Подтверждаю соответствие участников и назначение карты 1',{exact:true}).check();
  await page.getByRole('button',{name:'Сохранить назначение карты 1',exact:true}).click();
  await page.getByRole('link',{name:'Открыть сохранённое назначение →',exact:true}).click();const targetUrl=page.url();
  await page.getByRole('link',{name:'Подготовить новый сценарий для этой встречи →',exact:true}).click();
  for(let i=1;i<=5;i++){
    await page.getByLabel('A: игрок роли '+i,{exact:true}).fill(String(100+i));
    await page.getByLabel('B: игрок роли '+i,{exact:true}).fill(String(105+i));
  }
  await page.getByLabel('Подтверждаю выбранные 5+5, роли и необязательные ожидаемые составы',{exact:true}).check();
  await page.getByRole('button',{name:'Сохранить сценарий',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Сценарий · редакция 1',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'← Вернуться к назначению карты',exact:true}).click();
  await page.getByRole('button',{name:'Рассчитать назначенную карту',exact:true}).click();
  const result=page.getByRole('article',{name:'Сохранённый расчёт',exact:true});
  await expect(result).toContainText('Нет активной проверенной модели');await expect(result).not.toContainText('50 %');
  const forecastUrl=page.url();
  const frozen=(await sql<{snapshot_text:string;snapshot_sha256:string}>`SELECT snapshot_text,snapshot_sha256 FROM v1_runtime_snapshots`.execute(database.db)).rows;
  expect(frozen).toHaveLength(1);expect(JSON.parse(frozen[0]!.snapshot_text)).toMatchObject({status:'unavailable',teamAWinProbability:null});
  await expect(await lifecycle(page,'Отметить отмену встречи')).toContainText('Отмечена отмена владельцем');
  await page.goto('/forecast-journal');await page.getByRole('button',{name:'Создать и сохранить отчёт',exact:true}).click();
  const report=page.getByRole('article',{name:'Сохранённый отчёт журнала',exact:true});
  await expect(report).toContainText('Метрики · N=0');await expect(report).toContainText('Отменённых назначений карты: 1');
  const reportUrl=page.url(),before=(await sql<{report_text:string;report_sha256:string}>`SELECT report_text,report_sha256 FROM v1_journal_reports`.execute(database.db)).rows;
  expect(before).toHaveLength(1);
  await page.screenshot({path:'test-results/v1-acceptance-desktop.png',fullPage:true});
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/v1-acceptance-mobile.png',fullPage:true});
  // Restart the actual compiled process against the same disposable PostgreSQL database.
  const oldPid=server!.pid;await stop();await start();expect(server!.pid).not.toBe(oldPid);
  await page.goto(reportUrl);await expect(report).toContainText('Отменённых назначений карты: 1');
  await page.goto(targetUrl);await expect(await lifecycle(page,'Повторно открыть встречу')).toContainText('Повторно открыта владельцем');
  await page.goto(reportUrl);await expect(report).toContainText('Отменённых назначений карты: 1');
  expect((await sql`SELECT report_text,report_sha256 FROM v1_journal_reports`.execute(database.db)).rows).toEqual(before);
  await page.goto(forecastUrl);await expect(result).toContainText('Нет активной проверенной модели');
  expect((await sql`SELECT snapshot_text,snapshot_sha256 FROM v1_runtime_snapshots`.execute(database.db)).rows).toEqual(frozen);
  expect((await sql`SELECT 1 FROM v1_scheduled_lifecycle`.execute(database.db)).rows).toHaveLength(2);
  expect((await sql`SELECT 1 FROM prediction_model_versions WHERE is_active`.execute(database.db)).rows).toHaveLength(0);
  const sessionCookies=await page.context().cookies();
  await page.goto('/');await page.getByRole('button',{name:'Выйти',exact:true}).click();await expect(page).toHaveURL(/\/login$/);
  const revoked=await fetch('http://127.0.0.1:3151/api/v1/schedule-targets/'+targetUrl.split('/').at(-1),{
    headers:{cookie:sessionCookies.map(c=>`${c.name}=${c.value}`).join(';')}});
  expect(revoked.status).toBe(401);
  await page.goto(reportUrl);await expect(page).toHaveURL(/\/login(?:\?|$)/);expect(errors).toEqual([]);
});
