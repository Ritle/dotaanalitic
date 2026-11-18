import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedDraft,draftInput} from '../../../../tests/helpers/draft';
import {ScenarioRepository,sql} from '../../../../packages/db/src/index';
import {OpenDotaClient,IngestionService} from '../../../../packages/ingestion/src/index';
import {DraftCaptureRepository} from '../../../api/src/modules/scenarios/draft-capture-repository';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,ownerId:string;
const matchId='9007199254742991';
test.setTimeout(60000);test.use({actionTimeout:15000});
test.beforeAll(async()=>{
  database=await testDatabase();await seedDraft(database.db);const q=draftInput();
  await sql`UPDATE teams SET opendota_team_id=CASE WHEN id=${q.teamAId}::bigint THEN 111 ELSE 222 END WHERE id IN (${q.teamAId}::bigint,${q.teamBId}::bigint)`.execute(database.db);
  await sql`UPDATE leagues SET opendota_league_id=1 WHERE id=1`.execute(database.db);
  const payload={match_id:matchId,start_time:Math.floor(Date.now()/1000)-600,duration:60,radiant_win:true,radiant_team_id:111,dire_team_id:222,leagueid:1,
    players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:i+123,hero_id:i+1,account_id:1000+i}))};
  const client=new OpenDotaClient({},{fetch:async url=>new Response(JSON.stringify(url.pathname==='/api/heroes'?
    Array.from({length:10},(_,i)=>({id:i+1,name:`synthetic_${i}`,localized_name:`Synthetic ${i}`})):
    url.pathname==='/api/leagues'?[{leagueid:1,name:'Synthetic event',tier:'professional'}]:payload))});
  await new IngestionService(database.db,client).ingest(matchId);
  password=randomBytes(24).toString('base64url');ownerId=(await new AuthService(database.db).provision('synthetic-native-browser',password)).id;
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});
  await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
async function open(page:Page){
  const q=draftInput();q.draft!.assignments=(['A','B'] as const).flatMap((teamSlot,j)=>Array.from({length:5},(_,i)=>({teamSlot,rolePos:i+1,heroId:j*5+i+1})));
  const s=await new ScenarioRepository(database.db).save(ownerId,q),capture=await new DraftCaptureRepository(database.db).create(ownerId,s.id,{expectedRevision:1});
  await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-native-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
  await page.goto(`/scenarios/${s.id}/draft`);await expect(panel(page)).toBeVisible();
  return {s,capture};
}
const panel=(page:Page)=>page.getByRole('region',{name:'Проверка фактической карты',exact:true});
async function expand(page:Page){await panel(page).getByText('Связать снимок с сыгранной картой',{exact:true}).click();}
test('missing map explains next action; verified map persists on reload with no repeat confirmation',async({page})=>{
  const {s,capture}=await open(page);let posts=0;page.on('request',r=>{if(r.url().endsWith('/native-binding')&&r.method()==='POST')posts++;});
  await expand(page);await panel(page).getByLabel('Dota match ID',{exact:true}).fill('123');
  await panel(page).getByRole('button',{name:'Проверить карту',exact:true}).click();await expect(panel(page)).toContainText('Этой карты ещё нет');
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await panel(page).screenshot({path:'test-results/draft-native-form-mobile.png'});
  await panel(page).getByLabel('Dota match ID',{exact:true}).fill(matchId);
  await panel(page).getByRole('button',{name:'Проверить карту',exact:true}).click();await expect(panel(page)).toContainText(`Карта ${matchId} проверена`);
  await expect(panel(page)).toContainText('не раньше');await expect(panel(page).getByLabel('Dota match ID',{exact:true})).toHaveCount(0);
  await page.reload();await expect(panel(page)).toContainText(`Карта ${matchId} проверена`);expect(posts).toBe(2);
  expect(await new DraftCaptureRepository(database.db).get(ownerId,s.id,1)).toEqual(capture);
  expect((await sql`SELECT id FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
  await panel(page).screenshot({path:'test-results/draft-native-bound-mobile.png'});
});
test('lost response retries the identical request; edits disable checking a stale saved revision',async({page})=>{
  const {s}=await open(page),requests:unknown[]=[];
  await page.route(`**/scenarios/${s.id}/draft-captures/1/native-binding`,async route=>{
    if(route.request().method()!=='POST'){await route.continue();return;}
    requests.push(route.request().postDataJSON());const response=await route.fetch();
    if(requests.length===1)await route.fulfill({status:503,json:{error:{code:'SYNTHETIC_LOST_RESPONSE'}}});else await route.fulfill({response});
  });
  await expand(page);await panel(page).getByLabel('Dota match ID',{exact:true}).fill(matchId);
  await page.getByRole('combobox',{name:'A: герой роли 1',exact:true}).selectOption('11');
  await expect(panel(page).getByRole('button',{name:'Проверить карту',exact:true})).toBeDisabled();
  await page.reload();await expand(page);await panel(page).getByLabel('Dota match ID',{exact:true}).fill(matchId);
  await panel(page).getByRole('button',{name:'Проверить карту',exact:true}).click();await expect(panel(page).getByRole('alert')).toContainText('Повторите запрос');
  await panel(page).getByRole('button',{name:'Проверить карту',exact:true}).click();await expect(panel(page)).toContainText(`Карта ${matchId} проверена`);
  expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);
});
