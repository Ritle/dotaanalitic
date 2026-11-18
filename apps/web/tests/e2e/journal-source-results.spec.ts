import {test,expect} from '@playwright/test';
import {journalViewFixture} from '../../../../tests/helpers/journal-view';
import {V1JournalFeedSchema} from '../../../../packages/contracts/dist/journal/feed.js';
test('table automatically separates correct, incorrect, not started and source failure for first maps',async({page})=>{
 const base=journalViewFixture().rows[0]!,ids=[1,2,3,4,5].map(n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`),requests:string[]=[];
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const rows=ids.map((id,i)=>({predictionId:id,requestId:id,createdAt:base.createdAt,scenario:{...base.scenario,title:`Синтетическая встреча ${i+1}`},
  target:{provider:'pandascore',providerMatchId:String(100+i),mapNumber:1,targetRequestId:id,targetSha256:'a'.repeat(64)},expectedLineups:base.expectedLineups,
  probability:.6,calculationStatus:'done',status:i===4?'cancelled':'pending_verification',actualWinner:null,sourceChangedSinceRefresh:false,checkedAt:null,reasons:[]}));
 const feed=V1JournalFeedSchema.parse({readAt:'2026-11-16T12:00:00.000Z',items:rows,nextCursor:null});
 await page.route('**/health',r=>r.fulfill({json:{status:'ok'}}));
 await page.route('**/api/v1/**',r=>{
  const url=new URL(r.request().url());expect(r.request().method()).toBe(url.pathname.endsWith('/refresh')?'POST':'GET');
  if(url.pathname==='/api/v1/auth/me')return r.fulfill({json:{owner:{id:ids[0],login:'synthetic-results'},expiresAt:'2099-01-01T00:00:00.000Z',csrfToken:'synthetic'}});
  if(url.pathname==='/api/v1/auth/access')return r.fulfill({json:{role:'owner',canManageLineups:true}});
  if(url.pathname==='/api/v1/forecast-journal')return r.fulfill({json:{items:[],nextBeforeRevision:null}});
  if(url.pathname==='/api/v1/forecast-journal/current')return r.fulfill({json:feed});
  if(url.pathname==='/api/v1/catalog-labels')return r.fulfill({json:{source:'local_catalogue',readAt:feed.readAt,teams:[{id:base.scenario.teamAId,name:'Synthetic A'},{id:base.scenario.teamBId,name:'Synthetic B'}],players:[]}});
  if(url.pathname.startsWith('/api/v1/forecast-journal/results/')){
   const id=url.pathname.endsWith('/refresh')?url.pathname.split('/').at(-2)!:url.pathname.split('/').at(-1)!,i=ids.indexOf(id);requests.push(id);
   if(url.pathname.endsWith('/refresh'))expect(r.request().headers()['x-csrf-token']).toBe('synthetic');
   if(i===3)return r.fulfill({status:503,json:{error:{code:'RESULT_UNAVAILABLE'}}});
   return r.fulfill({json:{provider:'pandascore',providerMatchId:String(100+i),state:i===2?'not_started':'finished',actualWinner:i===2?null:i===0?'B':'A',correct:i===2?null:i===1,
    providerGameId:String(200+i),beganAt:i===2?null:'2026-11-15T10:00:00.000Z',endedAt:i===2?null:'2026-11-15T11:00:00.000Z',sourceFetchedAt:feed.readAt,sourceSha256:'a'.repeat(64),sourceUrl:'https://api.pandascore.co/matches/'+(100+i),reason:i===2?'FIRST_MAP_NOT_FINISHED':'PROVIDER_FIRST_MAP_RESULT',canonicalOutcome:false}});
  }
  return r.fulfill({status:404,json:{error:{code:'UNEXPECTED'}}});
 });
 await page.goto('/forecast-journal');const table=page.getByRole('region',{name:'Таблица текущих прогнозов',exact:true});
 const row=(i:number)=>table.getByRole('row',{name:`Прогноз: Синтетическая встреча ${i}`,exact:true});
 await expect(row(1)).toContainText('Прогноз неверен');await expect(row(2)).toContainText('Прогноз верен');
 await expect(row(3)).toContainText('Карта ещё не началась');await expect(row(4)).toContainText('Источник недоступен');
 await expect(row(5)).toContainText('Встреча отменена');await expect(row(5).getByRole('button',{name:'Сверить с источником'})).toHaveCount(0);
 await row(1).getByRole('button',{name:'Сверить с источником'}).click();await expect(row(1)).toContainText('Прогноз неверен');
 await expect(row(1)).toContainText('Synthetic B');await expect(row(1)).toContainText('PandaScore');
 await expect(table.getByRole('columnheader',{name:'Победитель карты',exact:true})).toBeVisible();
 await page.screenshot({path:'.tools/s307-results-table-desktop.png',fullPage:true});
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await expect(table).toBeVisible();await table.evaluate(el=>{el.scrollLeft=el.scrollWidth;});await expect(row(1).getByRole('heading',{name:'Прогноз неверен',exact:true})).toBeVisible();
 await page.screenshot({path:'.tools/s307-results-table-mobile.png'});expect(requests).toHaveLength(5);expect(errors).toEqual([]);
});
