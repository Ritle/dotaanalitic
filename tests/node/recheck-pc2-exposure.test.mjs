import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {leagueMatchIds, matchIds, recheck} from '../../tools/research/recheck-pc2-exposure.mjs';

const sha = content => createHash('sha256').update(content).digest('hex');
function receipt(endpoint,data) {
  const rawBody=JSON.stringify(data);
  return {data,rawBody,source:{provider:'opendota',endpoint,payloadSha256:sha(rawBody)}};
}
const nothing = {maps:[],openDota:[],pandaScore:[]};
const match = receipt('/matches/9300',{match_id:'9300',leagueid:'8200',series_id:'411'});

test('matches and series come from pinned provider bytes with the correct endpoint',()=>{
  assert.deepEqual(matchIds('9300.json.gz',match),{...nothing,maps:['9300'],openDota:['411']});
  assert.throws(()=>matchIds('9301.json.gz',match),/unsupported_opendota_envelope/);
  assert.throws(()=>matchIds('9300.json.gz',{...match,rawBody:match.rawBody+' '}),/provider_payload_sha_mismatch/);
  assert.throws(()=>matchIds('9300.json.gz',{...match,data:{...match.data,series_id:'412'}}),/match_series_projection_mismatch/);
});

test('league archive separates Dota maps and OpenDota series and rejects conflicts',()=>{
  const rows=[{match_id:'9007199254740993',leagueid:8200,series_id:0},match.data,{...match.data}];
  const endpoint='/leagues/8200/matches';
  assert.deepEqual(leagueMatchIds('8200.json.gz',receipt(endpoint,rows)),
    {...nothing,maps:['9007199254740993','9300'],openDota:['411']});
  assert.throws(()=>leagueMatchIds('8200.json.gz',receipt(endpoint,[match.data,{...match.data,series_id:'412'}])),/conflicting_league_match/);
  assert.throws(()=>leagueMatchIds('8200.json.gz',receipt(endpoint,[{...match.data,leagueid:'8201'}])),/league_id_mismatch/);
});

test('keeps missing, changed and unfamiliar sources visible without exporting raw contents',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pc2-exposure-recheck-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'.tools','bo3-eight-native-sources'),{recursive:true});
  const matchBytes=gzipSync(JSON.stringify(match));
  const pilotBytes=Buffer.from('{"private":"fixture_value"}');
  await writeFile(join(root,'.tools','9300.json.gz'),matchBytes);
  await writeFile(join(root,'.tools','primary-421.json'),pilotBytes);
  await writeFile(join(root,'.tools','bo3-eight-native-sources','8200.json.gz'),
    gzipSync(JSON.stringify(receipt('/leagues/8200/matches',[match.data]))));
  await writeFile(join(root,'.tools','bo3-eight-native-sources','8201.json.gz'),gzipSync(JSON.stringify([match.data])));
  const counts={maps:1,openDota:1,pandaScore:0};
  const outsideOffline={...nothing,maps:['9300'],openDota:['411']};
  const report={format:'pc2-offline-id-comparison-v1',sources:[
    {group:'privateFiles',source:'.tools\\9300.json.gz',sha256:sha(matchBytes),
      adapters:['opendota_match_receipt'],counts,outsideOffline},
    {group:'privateFiles',source:'.tools\\primary-421.json',sha256:sha(pilotBytes),adapters:['private_pilot_issuance']},
    {group:'privateFiles',source:'.tools\\9302.json.gz',sha256:sha('missing'),adapters:['opendota_match_receipt']},
    {group:'privateFiles',source:'..\\9300.json.gz',sha256:sha(matchBytes),adapters:['opendota_match_receipt']},
    {group:'privateFiles',source:'.tools\\9300.json.gz',sha256:sha('changed'),adapters:['opendota_match_receipt']},
  ],notMappedOrNoIds:[
    '.tools\\bo3-eight-native-sources\\8200.json.gz',
    '.tools\\bo3-eight-native-sources\\8201.json.gz',
    '.tools\\other.json'
  ]};
  const result=await recheck(report,sha(JSON.stringify(report)),root);
  assert.deepEqual(result.summary,{ids_verified:2,hash_verified_only:1,unresolved:4});
  assert.equal(result.unmappedOutsideScope,1);
  assert(!JSON.stringify(result).includes('fixture_value'));
  assert.deepEqual(result.sources.filter(source=>source.status==='unresolved').map(source=>source.reason),
    ['ENOENT','source_outside_project','source_sha_mismatch','unsupported_opendota_envelope']);
});
