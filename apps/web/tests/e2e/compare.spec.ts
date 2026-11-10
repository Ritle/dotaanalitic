import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedCompare} from '../../../../tests/helpers/compare';
import {catalogTeamId,catalogPlayerId} from '../../../../tests/helpers/catalog';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
import {roleName} from '../../src/role-suggestions';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
test.beforeAll(async()=>{
  database=await testDatabase();await seedCompare(database.db);password=randomBytes(24).toString('base64url');
  await new AuthService(database.db).provision('synthetic-compare-browser',password);
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
const playerField=(slot:string,role:number)=>`${slot}: игрок роли ${role} · ${roleName(role)}`;
async function pick(page:Page,label:string,query:string,id:string){const field=page.getByRole('region',{name:label,exact:true});
 await field.getByRole('searchbox').fill(query);await field.getByRole('searchbox').press('Enter');await field.getByRole('button',{name:new RegExp(' · ID '+id+'$')}).click();}
test('compare keeps organization, actual H2H and selected fives separate with replacement, missing IDs and mobile layout',async({page})=>{
  await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-compare-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
  await page.goto('/compare');
  await pick(page,'Команда A: поиск по названию','Aurora',catalogTeamId);
  await pick(page,'Команда B: поиск по названию','Aurora','9007199254740994');
  await page.getByLabel('Сравнение: начало UTC',{exact:true}).fill('2024-01-01T00:00');await page.getByLabel('Сравнение: срез UTC',{exact:true}).fill('2024-01-03T00:00');
  for(let i=0;i<5;i++){
    await pick(page,playerField('A',i+1),i<2?'Twin':`Synthetic Player ${i}`,String(BigInt(catalogPlayerId)+BigInt(i)));
    await pick(page,playerField('B',i+1),i===0?'Synthetic Player 5':'strength',String(BigInt(catalogPlayerId)+5n+BigInt(i)));
  }
  await page.getByLabel('A: stand-in роли 1',{exact:true}).check();
  await page.getByLabel('A: сменить роль 1',{exact:true}).selectOption('5');
  for(let role=1;role<=5;role++)await expect(page.getByLabel(`A: сменить роль ${role}`,{exact:true})).toHaveValue(String(role));
  await expect(page.getByRole('region',{name:playerField('A',5),exact:true}).getByRole('status')).toContainText(catalogPlayerId);
  await expect(page.getByLabel('A: stand-in роли 5',{exact:true})).toBeChecked();
  await page.getByLabel('A: сменить роль 5',{exact:true}).selectOption('1');
  const submit=page.getByRole('button',{name:'Сравнить команды',exact:true});await submit.click();
  const result=page.getByRole('region',{name:'Результат сравнения',exact:true}),table=page.getByRole('table',{name:'Показатели двух команд',exact:true});
  await expect(result).toBeVisible();await expect(table.getByRole('row').filter({hasText:'Выбранная пятёрка · эта организация'})).toContainText('N = 2');
  await expect(page.getByRole('group',{name:'H2H двух организаций'})).toContainText('N = 2');await expect(page.getByRole('table',{name:'Карты H2H'})).toContainText('Dire / Radiant');
  await result.screenshot({path:'test-results/compare-desktop.png'});
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await result.screenshot({path:'test-results/compare-mobile.png'});
  await pick(page,playerField('A',5),String(BigInt(catalogPlayerId)+10n),String(BigInt(catalogPlayerId)+10n));await expect(result).toHaveCount(0);await submit.click();
  await expect(table.getByRole('row').filter({hasText:'Выбранная пятёрка · эта организация'})).toContainText('N = 0');
  await expect(table.getByRole('row').filter({hasText:'Организация · весь период'})).toContainText('N = 2');
  await page.getByRole('region',{name:playerField('A',1),exact:true}).getByRole('button',{name:'Сбросить',exact:true}).click();await submit.click();
  await expect(table.getByRole('row').filter({hasText:'Выбранная пятёрка · эта организация'})).toContainText('N = неизвестно');
  await pick(page,'Команда B: поиск по названию','Literal','9007199254740995');await submit.click();
  await expect(result).toContainText('Нет наблюдаемых профессиональных личных встреч');
  await page.goto(`/compare?teamA=${catalogTeamId}&teamB=999999999`);await submit.click();
  await expect(page.getByRole('alert')).toContainText('Запись не найдена');
  await page.goto(`/compare?teamA=${catalogTeamId}&teamB=${catalogTeamId}`);await submit.click();
  await expect(page.getByRole('alert')).toContainText('две разные команды');
});
