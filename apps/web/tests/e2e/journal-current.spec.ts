import {test,expect} from '@playwright/test';
import {journalViewFixture} from '../../../../tests/helpers/journal-view';
import {V1JournalFeedSchema} from '../../../../packages/contracts/dist/journal/feed.js';
test('current feed shows a new probability without report creation and keeps archive explicit',async({page})=>{
 const archive=journalViewFixture(),row=archive.rows[0]!;let calculated=false,writes=0;
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const response=()=>V1JournalFeedSchema.parse({readAt:'2026-11-16T12:00:00.000Z',items:calculated?[{
  predictionId:row.predictionId,requestId:row.requestId,createdAt:row.createdAt,scenario:{...row.scenario,title:'Новый синтетический прогноз'},target:row.target,
  expectedLineups:row.expectedLineups,probability:.61,calculationStatus:'done',status:'pending_verification',actualWinner:null,
  sourceChangedSinceRefresh:false,checkedAt:null,reasons:[]}]:[],nextCursor:null});
 await page.route('**/health',route=>route.fulfill({json:{status:'ok'}}));
 await page.route('**/api/v1/**',route=>{
  const req=route.request(),url=new URL(req.url());if(req.method()!=='GET')writes++;
  if(url.pathname==='/api/v1/auth/me')return route.fulfill({json:{owner:{id:archive.requestId,login:'synthetic-current'},expiresAt:'2099-01-01T00:00:00.000Z',csrfToken:'synthetic'}});
  if(url.pathname==='/api/v1/auth/access')return route.fulfill({json:{role:'owner',canManageLineups:true}});
  if(url.pathname==='/api/v1/forecast-journal/current')return route.fulfill({json:response()});
  if(url.pathname==='/api/v1/forecast-journal')return route.fulfill({json:{items:[{requestId:archive.requestId,revision:archive.revision,sha256:archive.sha256,capturedAt:archive.capturedAt,filters:archive.summary.filters,n:1,accuracy:1}],nextBeforeRevision:null}});
  if(url.pathname==='/api/v1/forecast-journal/'+archive.requestId)return route.fulfill({json:archive});
  if(url.pathname==='/api/v1/catalog-labels')return route.fulfill({json:{source:'local_catalogue',readAt:'2026-11-16T12:00:00.000Z',teams:[{id:row.scenario.teamAId,name:'Synthetic A'},{id:row.scenario.teamBId,name:'Synthetic B'}],players:[]}});
  return route.fulfill({status:404,json:{error:{code:'SYNTHETIC_UNEXPECTED_REQUEST'}}});
 });
 await page.goto('/forecast-journal');const feed=page.getByRole('region',{name:'Текущие прогнозы',exact:true});
 await expect(feed).toContainText('Расчётов пока нет');await expect(page).not.toHaveURL(/report=/);
 calculated=true;await page.reload();
 const card=feed.getByRole('row',{name:'Прогноз: Новый синтетический прогноз',exact:true});
 await expect(card).toContainText('Результат не проверен');await expect(card).toContainText('61');await expect(card).toContainText('Synthetic A');
 await expect(page.getByRole('article',{name:'Сохранённый отчёт журнала',exact:true})).toHaveCount(0);
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'.tools/s307-table-current-mobile.png',fullPage:true});
 await page.getByRole('region',{name:'История отчётов',exact:true}).getByRole('link').click();
 await expect(page.getByRole('article',{name:'Сохранённый отчёт журнала',exact:true})).toContainText('Прогноз верен');
 await expect(feed).toHaveCount(0);await page.getByRole('link',{name:'← Все текущие прогнозы',exact:true}).click();
 await expect(card).toContainText('Результат не проверен');expect(writes).toBe(0);expect(errors).toEqual([]);
});
