import {createHash} from 'node:crypto';
import {z} from 'zod';
import {sql,type Db,PandaScoreQuotaRepository} from '@dota/db';
import {V1RuntimeSnapshotSchema,V1ScheduleTargetRecordSchema} from '@dota/contracts';
import {V1JournalFeedSnapshotSchema} from '../../../../../packages/contracts/dist/journal/feed.js';
import {PandaScoreError} from '@dota/ingestion';
import {DurablePandaScoreBudget} from '../upcoming/service.js';
import {PandaScoreResultClient} from './journal-result-provider.js';
import {assessPandaResult,JournalResultSchema,type JournalResult,type ResultTarget} from './journal-result-contract.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
type Observation=Awaited<ReturnType<PandaScoreResultClient['getMatch']>>;
/** Durable provider receipts with a bounded process cache; canonical outcomes remain separate. */
export class JournalResultService{
 private readonly cache=new Map<string,{until:number;value:Promise<Observation|null>}>();
 private tail:Promise<unknown>=Promise.resolve();
 constructor(private readonly db:Db,private readonly token?:string,private readonly fetcher?:(url:URL,init:RequestInit)=>Promise<Response>){}
 private observation(id:string,target:ResultTarget,refresh:boolean){
  const old=this.cache.get(id);if(old&&old.until>Date.now())return old.value;
  for(const [key,value] of this.cache)if(value.until<=Date.now())this.cache.delete(key);
  if(this.cache.size>=100)throw Error('result_lookup_busy');
  const value=this.tail.then(()=>this.db.transaction().execute(async tx=>{
   await sql`SET LOCAL lock_timeout='20s'`.execute(tx);
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'journal-provider-result:'+id},0))`.execute(tx);
   const saved=(await sql<{observation_text:string;observation_sha256:string;terminal:boolean;age:number}>`SELECT observation_text,observation_sha256,terminal,extract(epoch from(clock_timestamp()-recorded_at))::float8 age
    FROM journal_provider_result_receipts WHERE provider_match_id=${id}::bigint ORDER BY id DESC LIMIT 1`.execute(tx)).rows[0];
   let previous:Observation|null=null;
   if(saved){if(sha(saved.observation_text)!==saved.observation_sha256)throw Error('result_lookup_integrity');
    previous=JSON.parse(saved.observation_text) as Observation;
    if(saved.age<(refresh?60:300)||saved.terminal&&!refresh)return previous;}
   if(!this.token)return null;
   const client=new PandaScoreResultClient({apiToken:this.token,maxRequests:1},{fetch:this.fetcher,budget:new DurablePandaScoreBudget(new PandaScoreQuotaRepository(this.db))});
   try{const result=await client.getMatch(id);const body=JSON.stringify(result);if(body.includes(this.token.trim()))throw Error('credential_echo');
    const assessment=assessPandaResult(result.data,target,result.source);
    const terminal=assessment.state==='finished'&&assessment.actualWinner!==null||assessment.state==='cancelled';
    await sql`INSERT INTO journal_provider_result_receipts(provider_match_id,observation_text,observation_sha256,terminal) VALUES(${id}::bigint,${body},${sha(body)},${terminal})`.execute(tx);
    return result;}
   catch(e){if(e instanceof PandaScoreError||e instanceof Error&&e.message==='credential_echo')return previous;throw e;}
  }));
  this.tail=value.catch(()=>undefined);const entry={until:Date.now()+300000,value};this.cache.set(id,entry);
  void value.then(v=>{entry.until=Date.now()+(v?300000:60000);},()=>{this.cache.delete(id);});
  return value;
 }
 async read(owner:string,requestId:string,refresh=false){
  z.uuid().parse(owner);z.uuid().parse(requestId);
  const row=(await sql<{snapshot_text:string;snapshot_sha256:string}>`SELECT snapshot_text,snapshot_sha256 FROM v1_runtime_snapshots WHERE owner_user_id=${owner}::uuid AND request_id=${requestId}::uuid`.execute(this.db)).rows[0];
  if(!row)throw Error('result_lookup_not_found');if(sha(row.snapshot_text)!==row.snapshot_sha256)throw Error('result_lookup_integrity');
  const raw=JSON.parse(row.snapshot_text),s=V1JournalFeedSnapshotSchema.parse(raw),cutoffAt=V1RuntimeSnapshotSchema.shape.cutoffAt.parse(raw.cutoffAt);
  if(s.request.purpose!=='real_map'||s.request.realTarget.provider!=='pandascore')throw Error('result_lookup_not_found');
  const t=s.request.realTarget,r=(await sql<{record_text:string;record_sha256:string}>`SELECT record_text,record_sha256 FROM v1_schedule_targets WHERE owner_user_id=${owner}::uuid AND request_id=${t.targetRequestId}::uuid`.execute(this.db)).rows[0];
  if(!r||sha(r.record_text)!==r.record_sha256||r.record_sha256!==t.targetSha256)throw Error('result_lookup_integrity');
  const record=V1ScheduleTargetRecordSchema.parse(JSON.parse(r.record_text)),q=record.request;
  if(q.providerMatchId!==t.providerMatchId||q.teamAId!==s.scenario.input.teamAId||q.teamBId!==s.scenario.input.teamBId)throw Error('result_lookup_integrity');
  const target:ResultTarget={providerMatchId:t.providerMatchId,teamA:q.providerTeamAId,teamB:q.providerTeamBId,
   probability:s.teamAWinProbability,issuedAt:s.issuedAt,createdAt:s.createdAt,cutoffAt};
  // Explicit refresh bypasses process cache; the shared DB lock still coalesces calls for 60s.
  if(refresh)this.cache.delete(t.providerMatchId);
  const observation=await this.observation(t.providerMatchId,target,refresh);
  const empty:JournalResult={provider:'pandascore',providerMatchId:t.providerMatchId,state:'unavailable',actualWinner:null,correct:null,providerGameId:null,
   beganAt:null,endedAt:null,sourceFetchedAt:null,sourceSha256:null,sourceUrl:`https://api.pandascore.co/matches/${t.providerMatchId}`,reason:this.token?'SOURCE_UNAVAILABLE':'SOURCE_NOT_CONFIGURED',canonicalOutcome:false};
  if(!observation)return empty;
  try{return JournalResultSchema.parse(assessPandaResult(observation.data,{providerMatchId:t.providerMatchId,teamA:q.providerTeamAId,teamB:q.providerTeamBId,
   probability:s.teamAWinProbability,issuedAt:s.issuedAt,createdAt:s.createdAt,cutoffAt},observation.source));}
  catch{return {...empty,reason:'SOURCE_RESPONSE_INVALID',sourceFetchedAt:observation.source.fetchedAt,sourceSha256:observation.source.payloadSha256};}
 }
}
