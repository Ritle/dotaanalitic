// Local operator command. The decision and the subsequent tournament registration are separate records.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createDatabase, sql} from '../../packages/db/dist/index.js';

function describe(row) {
  if (!row) return {status: 'no_choice'};
  return {status: 'protocol_chosen', protocol: row.protocol, proposalSha256: row.proposal_sha256,
    ownerId: row.owner_user_id, selectedAt: row.selected_at.toISOString()};
}

export async function readDl30Choice(db) {
  const result = await sql`SELECT * FROM dl30_protocol_choice WHERE singleton`.execute(db);
  return describe(result.rows[0]);
}

export async function chooseDl30Protocol(db, ownerId, protocol, proposalSha256) {
  assert(['full_event','swiss_stage'].includes(protocol), 'unexpected_protocol');
  assert(/^[0-9a-f]{64}$/.test(proposalSha256), 'expected_proposal_sha256');
  return db.transaction().setIsolationLevel('read committed').execute(async tx => {
    await sql`SET LOCAL synchronous_commit='on'`.execute(tx);
    await sql`SET LOCAL lock_timeout='30s'`.execute(tx);
    const result = await sql`SELECT * FROM dl30_choose_protocol(${ownerId}::uuid,${protocol},${proposalSha256})`.execute(tx);
    return describe(result.rows[0]);
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, ...args] = process.argv.slice(2);
  assert((mode === 'status' && !args.length) || (mode === 'choose' && args.length === 3),
    'usage: status | choose OWNER_ID full_event|swiss_stage PROPOSAL_SHA256');
  const db = createDatabase(process.env.DATABASE_URL);
  try {
    const choice = mode === 'status' ? await readDl30Choice(db) : await chooseDl30Protocol(db, ...args);
    console.log(JSON.stringify(choice));
  } finally { await db.destroy(); }
}
