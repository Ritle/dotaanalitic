import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMetadata, summarize} from '../../tools/research/series-independent-scope.mjs';

const header = 'leagueid,match_id,series_id,series_type,start_time';
const start = Date.parse('2025-03-09') / 1000;
const row = (map, series, type=1) => ['17891',map,series,type,start].join(',');
const rows = [row(1,11),row(2,11),row(3,12),row(4,13,2),row(5,14)];
const local = {maps:new Set(['2']), series:new Set()};

test('one exposed sibling excludes its whole BO3 and source namespaces stay distinct', () => {
  const groups = parseMetadata([header,...rows].join('\n'));
  const ledger = {maps:new Set(),series:new Set(['["opendota","12"]','["pandascore","14"]'])};
  const [result] = summarize(groups,local,new Set(['2']),ledger);
  assert.deepEqual(result,{league:'17891',bo3:3,bo5:1,localHits:1,baselineTextHits:1,archivedHits:1,remainingCandidates:1});
  const [missing] = summarize(groups,local,new Set(),null);
  assert.equal(missing.archivedHits,null);
  assert.equal(missing.remainingCandidates,2);
});

test('rejects extra columns, conflicting formats, duplicate maps and timestamps outside the event', () => {
  for (const lines of [[header+',winner',...rows],[header,rows[0]+',1'],[header,rows[0],row(2,11,2)],
    [header,rows[0],rows[0]],[header,rows[0].replace(String(start),'1')]]) {
    assert.throws(()=>parseMetadata(lines.join('\n')));
  }
});
