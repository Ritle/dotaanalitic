import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localV2Origin,transportV2Command,TransportV2Receipt} from '../../tools/research/conditional-collection-v2-transport.mjs';
const requestId=randomUUID();
test('only literal loopback HTTP origins with a port are accepted; no normalization bypass',()=>{
 assert.equal(localV2Origin('http://127.0.0.1:4567'),'http://127.0.0.1:4567');
 for(const url of ['https://127.0.0.1:4567','http://localhost:4567','http://127.1:4567','http://2130706433:4567',
  'http://127.0.0.1:4567/path','http://u:p@127.0.0.1:4567','http://127.0.0.1:4567/?key=secret','http://127.0.0.1:0','http://127.0.0.1:4567/#x','http://example.com:4567'])assert.throws(()=>localV2Origin(url));
});
test('complete raw bytes use archive completion regardless of client JSON validation',()=>{
 assert.deepEqual(transportV2Command({requestId,hasBody:true,httpStatus:200,code:'source_invalid_json',retryAfterAt:null}),{kind:'complete',requestId});
 assert.deepEqual(transportV2Command({requestId,hasBody:true,httpStatus:204,code:'source_invalid_json',retryAfterAt:null}),{kind:'complete',requestId});
});
test('failure normalization retains budget retry delay without inventing an HTTP status',()=>{
 const at='2026-11-20T01:00:00.000Z';
 assert.deepEqual(transportV2Command({requestId,hasBody:false,httpStatus:null,code:'request_budget_exhausted',retryAfterAt:at}),
  {kind:'fail',requestId,httpStatus:null,code:'cancelled',retryAfterAt:at});
 assert.deepEqual(transportV2Command({requestId,hasBody:false,httpStatus:429,code:'source_rate_limited',retryAfterAt:at}),
  {kind:'fail',requestId,httpStatus:429,code:'http_error',retryAfterAt:at});
});
test('timeout, interrupted bodies and size limits remain distinguishable',()=>{
 for(const [code,want] of [['source_timeout','timeout'],['source_response_too_large','body_limit'],['source_incomplete_body','incomplete_body'],['transport_cancelled','cancelled']])
  assert.equal(transportV2Command({requestId,hasBody:false,httpStatus:200,code,retryAfterAt:null}).code,want);
});
test('valid receipt rejects unknown credential/permission fields and unsupported body claims',()=>{
 const at='2026-11-20T00:00:00.000Z',r={format:'conditional-local-transport-v2',syntheticOnly:true,registrationId:randomUUID(),requestId,
  reservationOperationId:randomUUID(),reservationHeadSha256:'a'.repeat(64),endpoint:'/proMatches',sendInvokedAt:null,responseHeadersAt:null,bodyCompletedAt:null,
  finishedAt:at,observedAt:at,clockBasis:'process_wall_and_postgres_observation',httpStatus:null,responseBytes:0,bodySha256:null,bodyBytes:null,
  clientValidationCode:'request_budget_exhausted',quotaClaimed:false,quotaObservationFailed:false,quotaPeriod:'day',completionOperationId:randomUUID(),
  command:{kind:'fail',requestId,httpStatus:null,code:'cancelled',retryAfterAt:at}};
 assert.deepEqual(TransportV2Receipt.parse(r),r);
 for(const extra of [{apiKey:'synthetic-do-not-store'},{dispatchAllowed:true},{syntheticOnly:false},{bodySha256:'b'.repeat(64),bodyBytes:0}])assert.throws(()=>TransportV2Receipt.parse({...r,...extra}));
 assert.throws(()=>TransportV2Receipt.parse({...r,sendInvokedAt:at,responseHeadersAt:at,httpStatus:503,quotaClaimed:true,quotaPeriod:null,
  clientValidationCode:'source_http_error',command:{...r.command,httpStatus:null,code:'connection_error'}}));
});
