import {test,expect,type Page} from '@playwright/test';
import {randomBytes,createHash} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedProMaps} from '../../../../tests/helpers/pro-maps';
import {catalogTeamId,catalogPlayerId} from '../../../../tests/helpers/catalog';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,calls=0,transfer=false,fail=false,memberCount:number|null=null;
test.beforeEach(async()=>{
 database=await testDatabase();await seedProMaps(database.db);calls=0;transfer=false;fail=false;memberCount=null;
 await sql`UPDATE teams SET opendota_team_id=CASE WHEN id=${catalogTeamId} THEN 71 ELSE 72 END WHERE id IN (${catalogTeamId},9007199254740994)`.execute(database.db);
 password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-roster-cards',password);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false,catalogueProvider:async key=>{
  expect(key).toBe('registry');calls++;if(fail)throw Error('synthetic-provider-unavailable');
  const rawBody=JSON.stringify(Array.from({length:memberCount??6},(_,i)=>({account_id:1000+i,steamid:String(76561197960265728n+1000n+BigInt(i)),
   name:i===0||i===5?'Current alias':'Synthetic member '+i,team_id:memberCount===null&&(i===5||i===0&&transfer)?72:71,team_name:memberCount===null&&(i===5||i===0&&transfer)?'Synthetic Beta':'Synthetic Alpha'})));
  return {rawBody,source:{endpoint:'/proPlayers',fetchedAt:new Date().toISOString(),payloadSha256:createHash('sha256').update(rawBody).digest('hex')}};
 }});await api.listen({host:'127.0.0.1',port:3151});
});
test.afterEach(async()=>{await api?.close();await database?.close();});
async function login(page:Page){await page.goto('/login');await page.getByLabel('Логин',{exact:true}).fill('synthetic-roster-cards');await page.getByLabel('Пароль',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('heading',{name:'Справочники',exact:true}).waitFor();}
const teamCard=(page:Page)=>page.getByRole('region',{name:'Состав по OpenDota',exact:true});
const playerCard=(page:Page)=>page.getByRole('region',{name:'Команда по OpenDota',exact:true});

test('registry counts are not a selected lineup or an activity verdict; comparison starts with owner selection',async({page})=>{
 await login(page);await page.goto(`/teams/${catalogTeamId}`);
 for(const count of [0,1,4,5,6]){
  memberCount=count;await sql`UPDATE roster_catalogue_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE source_key='registry'`.execute(database.db);
  const response=page.waitForResponse(r=>r.url().endsWith('/roster-context/refresh')&&r.request().method()==='POST');
  await teamCard(page).getByRole('button',{name:'Обновить из OpenDota',exact:true}).click();await response;
  await expect(teamCard(page).getByRole('listitem')).toHaveCount(count);
  await expect(teamCard(page)).toContainText(count===0?'Пятёрка не определена':count<5?'Список неполный':count===5?'Пять записей не подтверждают участие':'В списке больше пяти игроков');
  await expect(teamCard(page)).toContainText('Статус активности команды по этому реестру не определяется');
  await expect(teamCard(page).getByRole('link',{name:'Проверить команду в OpenDota',exact:true})).toHaveAttribute('href','https://www.opendota.com/teams/71');
 }
 expect(calls).toBe(5);await page.setViewportSize({width:360,height:800});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await teamCard(page).getByRole('link',{name:'Выбрать пятёрку для сравнения',exact:true}).click();
 await expect(page).toHaveURL(new RegExp('/compare\\?teamA='+catalogTeamId+'$'));
 const params=new URL(page.url()).searchParams;expect([...params.keys()]).toEqual(['teamA']);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM prediction_runs`.execute(database.db)).rows[0]!.n).toBe(0);
});
test('one source refresh connects team and player cards; stale and failed refresh remain visible on mobile',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await login(page);await page.goto(`/teams/${catalogTeamId}`);
 await expect(teamCard(page)).toContainText('Реестр ещё не загружен');expect(calls).toBe(0);
 await teamCard(page).getByRole('button',{name:'Обновить из OpenDota',exact:true}).click();await expect(teamCard(page).getByRole('listitem')).toHaveCount(5);expect(calls).toBe(1);
 await expect(teamCard(page)).toContainText('подтверждённых локальных аккаунтов: 5');
 await expect(page.getByRole('heading',{name:'Последний наблюдавшийся состав',exact:true})).toBeVisible();
 await teamCard(page).getByRole('link',{name:'Current alias',exact:true}).click();await expect(page).toHaveURL(new RegExp('/players/'+catalogPlayerId+'$'));
 await expect(playerCard(page).getByRole('link',{name:'Synthetic Alpha',exact:true})).toHaveAttribute('href','/teams/'+catalogTeamId);
 expect(calls).toBe(1);await playerCard(page).getByRole('button',{name:'Обновить из OpenDota',exact:true}).click();
 await expect(playerCard(page).getByRole('button',{name:'Обновить из OpenDota',exact:true})).toBeEnabled();expect(calls).toBe(1);
 await playerCard(page).getByRole('link',{name:'Synthetic Alpha',exact:true}).click();await sql`UPDATE roster_catalogue_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);await page.reload();
 await expect(teamCard(page)).toContainText('Сведения устарели');fail=true;await teamCard(page).getByRole('button',{name:'Обновить из OpenDota',exact:true}).click();
 await expect(teamCard(page)).toContainText('Источник не удалось обновить');await expect(teamCard(page).getByRole('listitem')).toHaveCount(5);expect(calls).toBe(2);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await teamCard(page).screenshot({path:'test-results/roster-context-mobile.png'});expect(errors).toEqual([]);
});
test('refreshing a player transfer invalidates the old team card while preserving old map participants',async({page})=>{
 await login(page);await page.goto(`/teams/${catalogTeamId}`);await teamCard(page).getByRole('button',{name:'Обновить из OpenDota',exact:true}).click();
 await teamCard(page).getByRole('link',{name:'Current alias',exact:true}).click();await expect(playerCard(page)).toContainText('Synthetic Alpha');
 await sql`UPDATE roster_catalogue_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);transfer=true;
 await playerCard(page).getByRole('button',{name:'Обновить из OpenDota',exact:true}).click();await expect(playerCard(page)).toContainText('Synthetic Beta');
 await page.goto(`/teams/${catalogTeamId}`);await expect(teamCard(page).getByRole('listitem')).toHaveCount(4);await expect(teamCard(page).getByRole('link',{name:'Current alias',exact:true})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Последний наблюдавшийся состав',exact:true})).toBeVisible();expect(calls).toBe(2);
 const old=(await sql<{n:number}>`SELECT count(*)::int n FROM match_players WHERE player_id=${catalogPlayerId}`.execute(database.db)).rows[0]!.n;expect(old).toBe(4);
});

test('a delayed cached GET cannot overwrite the newly refreshed roster',async({page})=>{
 await login(page);await page.goto(`/teams/${catalogTeamId}`);await teamCard(page).getByRole('button',{name:'Обновить из OpenDota',exact:true}).click();
 await teamCard(page).getByRole('link',{name:'Current alias',exact:true}).click();await expect(playerCard(page)).toContainText('Synthetic Alpha');
 let release!:()=>void,entered!:()=>void,finished!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r),done=new Promise<void>(r=>finished=r);
 await page.route(`**/api/v1/teams/${catalogTeamId}/roster-context`,async route=>{const response=await route.fetch();entered();await gate;
  try{await route.fulfill({response});}finally{finished();}});
 await playerCard(page).getByRole('link',{name:'Synthetic Alpha',exact:true}).click();await ready;
 await expect(teamCard(page).getByRole('listitem')).toHaveCount(5);
 await sql`UPDATE roster_catalogue_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);transfer=true;
 try{await teamCard(page).getByRole('button',{name:'Обновить из OpenDota',exact:true}).click();await expect(teamCard(page).getByRole('listitem')).toHaveCount(4);}
 finally{release();}
 await done;await expect(teamCard(page).getByRole('listitem')).toHaveCount(4);expect(calls).toBe(2);
});
