import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {id,sha} from './exposure-ledger-core.mjs';

const fields = ['mapIds','openDotaSeriesIds','pandaScoreMeetingIds'];
const producers = {
  'series-review':'review-series-exposure.mjs',
  'draft-lab-review':'reconcile-dl30-pc-inventories.mjs'
};

function canonicalIds(values,max) {
  assert(Array.isArray(values) && values.length <= max,'invalid_inventory');
  return [...new Set(values.map(id))].sort();
}

export function fromKeys(mapIds,keys) {
  assert(Array.isArray(keys) && keys.length<=200000,'inventory size');
  const openDota=[], panda=[];
  for (const key of keys) {
    const [provider,number]=JSON.parse(key);
    assert.equal(JSON.stringify([provider,id(number)]),key,'noncanonical series key');
    assert(['pandascore','opendota'].includes(provider),'unknown series provider');
    (provider==='opendota' ? openDota : panda).push(number);
  }
  return {mapIds:canonicalIds(mapIds,100000),openDotaSeriesIds:canonicalIds(openDota,200000),
    pandaScoreMeetingIds:canonicalIds(panda,200000)};
}

// The exact adapter bytes, input digests and canonical IDs identify a snapshot.
// A refreshed capture timestamp alone does not create another copy.
export async function exposureSnapshot(producer,inputs,inventory) {
  assert(Object.hasOwn(producers,producer),'unknown_exposure_producer');
  const sourceDigests = Object.fromEntries(Object.keys(inputs).sort().map(name => {
    assert(/^[A-Za-z0-9_-]{1,64}$/.test(name) && /^[a-f0-9]{64}$/.test(inputs[name]),'invalid_input_digest');
    return [name,inputs[name]];
  }));
  assert(Object.keys(sourceDigests).length,'missing_input_digests');
  const normalized = Object.fromEntries(fields.map(field => [field,canonicalIds(inventory[field],field==='mapIds'?100000:200000)]));
  const code = await Promise.all([producers[producer],'shared-exposure.mjs','exposure-ledger-core.mjs']
    .map(async file => [file,sha(await readFile(new URL(file,import.meta.url)))]));
  return JSON.stringify({format:'research-exposure-snapshot-v1',producer,codeSha256:sha(JSON.stringify(code)),
    inputs:sourceDigests,inventory:normalized});
}

// Both the inventory and its revision list must describe the same committed snapshot.
const selectInventory = `
  WITH batches AS MATERIALIZED (
    SELECT sha256,snapshot_text::jsonb->'inventory' AS ids FROM research_exposure_snapshots
  ), unique_ids AS (
    SELECT DISTINCT field,id COLLATE "C" AS id FROM batches
    CROSS JOIN LATERAL jsonb_each(ids) AS entries(field,values_json)
    CROSS JOIN LATERAL jsonb_array_elements_text(values_json) AS items(id)
  ), lists AS (
    SELECT field,jsonb_agg(id ORDER BY id COLLATE "C") AS ids FROM unique_ids GROUP BY field
  )
  SELECT statement_timestamp() AS observed_at,
         coalesce((SELECT jsonb_object_agg(field,ids) FROM lists),'{}'::jsonb) AS inventory,
         ARRAY(SELECT sha256 FROM batches ORDER BY sha256 COLLATE "C") AS revisions`;

export async function sharedExposure(connectionString,snapshotText) {
  assert(connectionString,'RESEARCH_DATABASE_URL required');
  const url=URL.canParse(connectionString) ? new URL(connectionString) : null;
  assert(url && ['postgresql:','postgres:'].includes(url.protocol) && (url.hostname || url.searchParams.get('host'))
    && url.pathname.length>1,'invalid_RESEARCH_DATABASE_URL');
  let client;
  try {
    client = new pg.Client({connectionString,connectionTimeoutMillis:10000,statement_timeout:30000});
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED' + (snapshotText === undefined ? ' READ ONLY' : ''));
    if (snapshotText !== undefined) {
      await client.query('INSERT INTO research_exposure_snapshots(sha256,snapshot_text) VALUES($1,$2) ON CONFLICT (sha256) DO NOTHING',
        [sha(snapshotText),snapshotText]);
    }
    const {rows:[row]} = await client.query(selectInventory);
    await client.query('COMMIT');
    return {inventory:Object.fromEntries(fields.map(field => [field,row.inventory[field] ?? []])),
      revisions:row.revisions,observedAt:row.observed_at.toISOString()};
  } catch(error) {
    // Disconnect rolls back any open transaction. Keep credentials and input records out of CLI errors.
    const code = /^[A-Z0-9_]{2,24}$/.test(error.code ?? '') ? error.code : 'connection_or_query_error';
    throw new Error('shared_research_registry_failed: '+code);
  } finally { if (client) await client.end(); }
}
