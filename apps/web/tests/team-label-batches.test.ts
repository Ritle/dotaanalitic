import {expect,test} from 'vitest';
import {teamLabelBatches} from '../src/team-label-batches';
test('empty or unknown opponents do not request names',()=>{expect(teamLabelBatches([])).toEqual([]);expect(teamLabelBatches([null,null])).toEqual([]);});
test('stable bigint-safe batches deduplicate organizations without mutating report order',()=>{
 const ids=['9007199254740994',null,'9007199254740993','9007199254740994'],before=[...ids];
 expect(teamLabelBatches(ids)).toEqual([['9007199254740993','9007199254740994']]);expect(ids).toEqual(before);
});
test('at most100 opponents use five bounded20-ID requests, including a partial final batch',()=>{
 const ids=Array.from({length:121},(_,i)=>String(9007199254740993n+BigInt(i)));
 expect(teamLabelBatches(ids)).toHaveLength(5);expect(teamLabelBatches(ids).flat()).toEqual(ids.slice(0,100));
 expect(teamLabelBatches(ids.slice(0,21)).map(b=>b.length)).toEqual([20,1]);
});
