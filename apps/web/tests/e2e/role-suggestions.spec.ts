import {pickScenario,scenarioPicker,clearScenario} from './helpers/scenario-picker';
import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedProMaps} from '../../../../tests/helpers/pro-maps';
import {scenarioInput} from '../../../../tests/helpers/scenario';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
test.beforeAll(async()=>{
  database=await testDatabase();await seedProMaps(database.db);password=randomBytes(24).toString('base64url');
  await new AuthService(database.db).provision('synthetic-role-browser',password);
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});
  await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
async function prepare(page:Page){
  await page.goto('/scenarios/new');await page.getByLabel('Логин').fill('synthetic-role-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();await page.goto('/scenarios/new');
  const q=scenarioInput();await page.getByLabel('Название',{exact:true}).fill('Синтетические автопозиции');
  await pickScenario(page,'Команда A: поиск по названию',q.teamAId);await pickScenario(page,'Команда B: поиск по названию',q.teamBId);
  await page.getByLabel('Автоподстановка ролей A',{exact:true}).uncheck();
  await page.getByLabel('Срез данных UTC',{exact:true}).fill('2024-01-03T00:00');
  for(const p of q.lineupA)await pickScenario(page,`A: игрок ${6-p.rolePos}`,p.playerId!);
  for(const p of q.lineupB)await pickScenario(page,`B: игрок ${p.rolePos}`,p.playerId!);
  return q;
}
test('manual mode applies suggestions explicitly, preserves hero/player/stand-in, resets confirmation and saves selected positions',async({page})=>{
  const q=await prepare(page),region=page.getByRole('region',{name:'Автоопределение ролей A',exact:true});
  await expect(region.getByRole('button',{name:'Применить роли A',exact:true})).toBeEnabled();
  await expect(scenarioPicker(page,'A: игрок 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[4]!.playerId!);
  await page.getByLabel('A: замена игрока 5',{exact:true}).check();
  await page.getByRole('combobox',{name:'A: герой роли 5',exact:true}).selectOption('1');
  const confirm=page.getByLabel('Подтверждаю выбранные 5+5, роли и необязательные ожидаемые составы',{exact:true});await confirm.check();
  await region.getByRole('button',{name:'Применить роли A',exact:true}).click();
  await expect(confirm).not.toBeChecked();await expect(scenarioPicker(page,'A: игрок 5').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[0]!.playerId!);await expect(page.getByLabel('A: роль игрока 5',{exact:true})).toHaveValue('1');
  await expect(page.getByLabel('A: замена игрока 5',{exact:true})).toBeChecked();
  await expect(page.getByRole('combobox',{name:'A: герой роли 1',exact:true})).toHaveValue('1');
  await confirm.check();await page.getByRole('button',{name:'Сохранить сценарий',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Сценарий · редакция 1',exact:true})).toBeVisible();await page.reload();
  await expect(scenarioPicker(page,'A: игрок 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[0]!.playerId!);
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await region.screenshot({path:'test-results/role-suggestions-mobile.png'});
});
test('an incomplete or edited lineup cannot apply stale suggestions; manual edit stays authoritative',async({page})=>{
  const q=await prepare(page),region=page.getByRole('region',{name:'Автоопределение ролей A',exact:true});
  await expect(region.getByRole('button',{name:'Применить роли A',exact:true})).toBeEnabled();
  await clearScenario(page,'A: игрок 1');await expect(region.getByText('Для подсказки нужны пять разных игроков.',{exact:true})).toBeVisible();
  await expect(region.getByRole('button',{name:'Применить роли A',exact:true})).toHaveCount(0);
  await pickScenario(page,'A: игрок 1',q.lineupA[4]!.playerId!);
  await expect(region.getByRole('button',{name:'Применить роли A',exact:true})).toBeEnabled();
  await expect(scenarioPicker(page,'A: игрок 1').getByRole('status')).toHaveAttribute('data-selected-id',q.lineupA[4]!.playerId!);
});
