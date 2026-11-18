import {test,expect} from 'vitest';
import {QuickForecastProgressStore} from '../src/modules/upcoming/quick-forecast-progress';
test('isolates owner, match and request; records failure at actual stage',()=>{
 const store=new QuickForecastProgressStore();const run=store.start('owner','match','request');run.stage('lineups');
 expect(store.get('other','match','request')).toBeNull();expect(store.get('owner','other','request')).toBeNull();expect(store.get('owner','match','other')).toBeNull();
 run.finish(false);expect(store.get('owner','match','request')).toMatchObject({stage:'lineups',state:'failed'});
});
test('concurrent retry cannot overwrite progress; completed retries can start again',()=>{
 const store=new QuickForecastProgressStore(),a=store.start('o','m','r'),b=store.start('o','m','r');a.stage('analysis');b.finish(false);
 expect(store.get('o','m','r')).toMatchObject({stage:'analysis',state:'running'});a.finish(true);
 expect(store.get('o','m','r')).toMatchObject({stage:'complete',state:'complete'});
 const retry=store.start('o','m','r');retry.stage('map',true);retry.stage('analysis');expect(store.get('o','m','r')?.reused).toBe(true);
});
test('status expires and memory is bounded; evicted callbacks cannot mutate newer attempts',()=>{
 let now=1000;const store=new QuickForecastProgressStore(()=>now,2,100),a=store.start('o','m','a');store.start('o','m','b');store.start('o','m','c');
 expect(store.get('o','m','a')).toBeNull();a.finish(true);expect(store.get('o','m','a')).toBeNull();
 now+=100;expect(store.get('o','m','b')).toBeNull();expect(store.get('o','m','c')).toBeNull();
});
