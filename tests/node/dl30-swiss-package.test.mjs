import assert from 'node:assert/strict';
import test from 'node:test';
import {extendBlastExclusions} from '../../tools/research/prepare-dl30-swiss-package.mjs';

const base = {mapIds: ['1'], canonicalSeriesKeys: ['["opendota","11"]']};
function fixture() {
  return {
    targets: [{id: '2', seriesId: '12'}],
    history: [{matchId: '1', seriesKey: '["opendota","11"]'}, {matchId: '4', seriesKey: '["opendota","13"]'}],
    valve: [{seriesId: '12', maps: ['2', '3']}],
    discovery: [{match_id: '4'}, {match_id: '4'}],
  };
}

test('keeps the earlier floor and the unscored sibling and deduplicates shared history', () => {
  const rows = fixture();
  const output = extendBlastExclusions(base, rows);
  assert.deepEqual(output, {mapIds: ['1', '2', '3', '4'],
    canonicalSeriesKeys: ['["opendota","11"]', '["opendota","12"]', '["opendota","13"]']});
  rows.valve[0].maps.reverse();
  rows.history.reverse();
  assert.deepEqual(extendBlastExclusions(output, rows), output);
  assert.deepEqual(base.mapIds, ['1']);
});

test('rejects unbound brackets and missing or conflicting memberships', () => {
  const rows = fixture();
  assert.throws(() => extendBlastExclusions(base, {...rows, valve: [{seriesId: '12', maps: ['3']}]}), /unbound/);
  assert.throws(() => extendBlastExclusions(base, {...rows, targets: [...rows.targets, {id: '5', seriesId: '14'}]}), /missing Valve/);
  assert.throws(() => extendBlastExclusions(base, {...rows, history: [{matchId: '2', seriesKey: '["opendota","13"]'}]}), /conflicting/);
  assert.throws(() => extendBlastExclusions(base, {...rows, discovery: [{match_id: '99'}]}), /unresolved/);
});

test('rejects duplicate bracket rows, invalid IDs and foreign series namespaces', () => {
  const rows = fixture();
  assert.throws(() => extendBlastExclusions(base, {...rows, valve: [...rows.valve, ...rows.valve]}), /duplicate Valve/);
  assert.throws(() => extendBlastExclusions(base, {...rows, targets: [...rows.targets, ...rows.targets]}), /duplicate diagnostic/);
  assert.throws(() => extendBlastExclusions(base, {...rows, history: [{matchId: '1', seriesKey: '["pandascore","11"]'}]}));
  assert.throws(() => extendBlastExclusions(base, {...rows, valve: [{seriesId: '12', maps: ['2', '0']}]}));
});
