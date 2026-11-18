import {test,expect} from 'vitest';
import {analyticLabelBatches} from '../src/analytic-label-batches';
test('analytic labels deduplicate local bigint keys and never batch null or unknown patch',()=>{
 const a='9007199254741999',b='9007199254741998';
 expect(analyticLabelBatches([a,null,a,b],[])).toEqual({batches:[{kind:'patches',ids:[b,a]}],omitted:0});
 expect(analyticLabelBatches([],[])).toEqual({batches:[],omitted:0});
});
test('analytic label budget limits requests without truncating report data',()=>{
 const patches=Array.from({length:201},(_,i)=>String(i+1));
 const r=analyticLabelBatches(patches,['1','1','2']);
 expect(r.batches).toHaveLength(11);expect(r.omitted).toBe(1);
 expect(r.batches.slice(0,10).every(b=>b.ids.length===20)).toBe(true);
 expect(r.batches[10]).toEqual({kind:'heroes',ids:['1','2']});
 expect(patches).toHaveLength(201);
});
