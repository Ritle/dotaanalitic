import {test,expect} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedCompare} from '../../../../tests/helpers/compare';
import {catalogTeamId,catalogPlayerId} from '../../../../tests/helpers/catalog';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
test.beforeAll(async()=>{
  database=await testDatabase();await seedCompare(database.db);password=randomBytes(24).toString('base64url');
  await new AuthService(database.db).provision('synthetic-compare-browser',password);
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
test('compare keeps organization, actual H2H and selected fives separate with replacement, missing IDs and mobile layout',async({page})=>{
  await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-compare-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
  await page.goto(`/compare?teamA=${catalogTeamId}&teamB=9007199254740994`);
  await page.getByLabel('Сравнение: начало UTC',{exact:true}).fill('2024-01-01T00:00');await page.getByLabel('Сравнение: срез UTC',{exact:true}).fill('2024-01-03T00:00');
  for(let i=0;i<5;i++){
    await page.getByLabel(`A: игрок роли ${i+1}`,{exact:true}).fill(String(BigInt(catalogPlayerId)+BigInt(i)));
    await page.getByLabel(`B: игрок роли ${i+1}`,{exact:true}).fill(String(BigInt(catalogPlayerId)+5n+BigInt(i)));
  }
  const submit=page.getByRole('button',{name:'Сравнить команды',exact:true});await submit.click();
  const result=page.getByRole('region',{name:'Результат сравнения',exact:true}),table=page.getByRole('table',{name:'Показатели двух команд',exact:true});
  await expect(result).toBeVisible();await expect(table.getByRole('row').filter({hasText:'Выбранная пятёрка · эта организация'})).toContainText('N = 2');
  await expect(page.getByRole('group',{name:'H2H двух организаций'})).toContainText('N = 2');await expect(page.getByRole('table',{name:'Карты H2H'})).toContainText('Dire / Radiant');
  await result.screenshot({path:'test-results/compare-desktop.png'});
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await result.screenshot({path:'test-results/compare-mobile.png'});
  await page.getByLabel('A: игрок роли 5',{exact:true}).fill(String(BigInt(catalogPlayerId)+10n));await expect(result).toHaveCount(0);await submit.click();
  await expect(table.getByRole('row').filter({hasText:'Выбранная пятёрка · эта организация'})).toContainText('N = 0');
  await expect(table.getByRole('row').filter({hasText:'Организация · весь период'})).toContainText('N = 2');
  await page.getByLabel('A: игрок роли 1',{exact:true}).fill('');await submit.click();
  await expect(table.getByRole('row').filter({hasText:'Выбранная пятёрка · эта организация'})).toContainText('N = неизвестно');
  await page.getByLabel('Команда B: ID организации',{exact:true}).fill('9007199254740995');await submit.click();
  await expect(result).toContainText('Нет наблюдаемых профессиональных личных встреч');
  await page.getByLabel('Команда B: ID организации',{exact:true}).fill('999999999');await submit.click();
  await expect(page.getByRole('alert')).toContainText('Запись не найдена');
  await page.getByLabel('Команда B: ID организации',{exact:true}).fill(catalogTeamId);await submit.click();
  await expect(page.getByRole('alert')).toContainText('две разные организации');
});
