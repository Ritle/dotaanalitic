import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isHistoricalCrlfChecksum } from '../../scripts/lib/historical-migration-checksum.mjs';

const filenames = ['053_owner_lineup_templates.sql', '054_upcoming_forecast_preparations.sql'];
const sha = text => createHash('sha256').update(text).digest('hex');
const read = filename => fs.readFileSync(new URL('../../packages/db/migrations/' + filename, import.meta.url), 'utf8');

test('recognizes only the two archived Windows byte sequences', () => {
  for (const filename of filenames) {
    const sql = read(filename), oldChecksum = sha(sql.replaceAll('\n', '\r\n'));
    assert.equal(isHistoricalCrlfChecksum(filename, sql, oldChecksum), true);
    assert.equal(isHistoricalCrlfChecksum(filename, sql, sha(sql)), false);
  }
});

test('rejects SQL edits, unrelated checksums and filename substitution', () => {
  const filename = filenames[0], sql = read(filename), oldChecksum = sha(sql.replaceAll('\n', '\r\n'));
  assert.equal(isHistoricalCrlfChecksum(filename, sql + '\nSELECT 1;\n', oldChecksum), false);
  assert.equal(isHistoricalCrlfChecksum(filename, sql, '0'.repeat(64)), false);
  for (const other of [filenames[1], '001_initial.sql', '072_future.sql', '__proto__']) {
    assert.equal(isHistoricalCrlfChecksum(other, sql, oldChecksum), false);
  }
});
