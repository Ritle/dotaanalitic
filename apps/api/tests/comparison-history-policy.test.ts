import {test,expect} from 'vitest';
import {needsComparisonHistory,comparisonHistoryOptions} from '../src/modules/history/comparison-history-contract';
test('automatic history checks global normalized pro coverage, not zero caused by comparison filters',()=>{
 expect(needsComparisonHistory([5,6,8,10,5])).toBe(false);expect(needsComparisonHistory([5,5,0,5,5])).toBe(true);expect(needsComparisonHistory([5,5,4,5,5])).toBe(true);
 expect(comparisonHistoryOptions).toEqual({windowDays:365,maxMaps:25});
});
test('unknown or incomplete coverage never claims readiness',()=>{
 expect(needsComparisonHistory([null,5,5,5,5])).toBe(true);expect(needsComparisonHistory([])).toBe(true);
});
