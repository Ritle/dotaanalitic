import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveBody,archiveMetadata,decodeArchiveBody,verifyArchiveEntry,archiveSha} from '../../tools/research/conditional-blob-archive.mjs';
const id='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222';
const input={requestId,endpoint:'/matches/9007199254740993',httpStatus:200,receivedAt:'2026-11-15T01:01:00.000Z',clientValidationCode:null};
test('hashes original bytes including invalid UTF8 without inventing decoded data',()=>{
 const bytes=Buffer.from([0xff,0,0xfe]),b=archiveBody(bytes);assert.equal(b.byteLength,3);assert.equal(b.sha256,archiveSha(bytes));
 assert.deepEqual(decodeArchiveBody(bytes),{status:'invalid_utf8',text:null});assert.equal(decodeArchiveBody(Buffer.from('\ufeff{}')).text,'\ufeff{}');
});
test('empty response remains a retained empty response; oversized body rejected',()=>{
 assert.equal(archiveBody(Buffer.alloc(0)).byteLength,0);assert.throws(()=>archiveBody(Buffer.alloc(8388609)),/body_limit/);
});
test('metadata references raw bytes and retains provenance without embedding body',()=>{
 const b=archiveBody(Buffer.from('synthetic')),m=archiveMetadata(id,input,b,true);
 assert.equal(m.bodySha256,b.sha256);assert.equal(m.responseBytes,9);assert.equal(m.knownAt,null);assert.equal(m.syntheticOnly,true);
 assert(!JSON.stringify(m).includes('rawBody'));assert.equal(m.provider,'opendota');
});
test('rejects credentials, arbitrary URLs, zero IDs, unsupported responses and unknown fields',()=>{
 for(const change of [{endpoint:'/matches/1?api_key=secret'},{endpoint:'https://api.opendota.com/api/matches/1'},
  {endpoint:'/matches/0'},{endpoint:'/matches/9223372036854775808'},{httpStatus:429},{receivedAt:'tomorrow'},{collectionAllowed:true}]){
  assert.throws(()=>archiveMetadata(id,{...input,...change},archiveBody(Buffer.alloc(0)),true));
 }
});
test('compact entry chain detects changed content, sequence and parent',()=>{
 const body=Buffer.from('SYNTHETIC'),bodySha=archiveSha(body),parent='a'.repeat(64),receipt='b'.repeat(64),at='2026-11-15T01:02:00.000Z';
 const event={format:'conditional-blob-entry-v1',registrationId:id,sequence:0,requestId,receiptSha256:receipt,bodySha256:bodySha,responseBytes:9,at};
 const text=JSON.stringify(event),row={registration_id:id,sequence:0,request_id:requestId,receipt_sha256:receipt,body_sha256:bodySha,
  response_bytes:9,parent_sha256:parent,entry_text:text,head_sha256:archiveSha(parent+':'+text),saved_at:at};
 assert.deepEqual(verifyArchiveEntry(row,id,0,parent),event);
 for(const changed of [{...row,entry_text:text+' '},{...row,sequence:1},{...row,parent_sha256:'c'.repeat(64)}])assert.throws(()=>verifyArchiveEntry(changed,id,0,parent));
 assert(Buffer.byteLength(text)<1024);
});
