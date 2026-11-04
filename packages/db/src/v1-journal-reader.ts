import { V1JournalViewSchema,V1JournalHistorySchema } from '@dota/contracts';
import { V1JournalRepository } from './v1-journal-repository.js';
import { sql,type Db } from './index.js';
import {readV1RuntimeCode} from './v1-runtime-code.js';
import {registryHash} from './v1-registry.js';
import {lifecycleTargetKey} from './v1-journal-v2.js';
type Saved=Awaited<ReturnType<V1JournalRepository['get']>>;
/** Bounded owner projection; source payloads, code manifests and raw inputs stay local. */
export function journalView(saved:Saved,offset=0) {
  if(!Number.isInteger(offset)||offset<0||offset>5000)throw Error('journal_invalid_offset');
  const {report,input}=saved,{rows,...summary}=report.summary,byId=new Map(input.observations.map(r=>[r.id,r]));
  const scheduledBindings=new Set(input.format==='v1-journal-input-v3'?input.scheduledBindings.map(b=>b.providerMatchId):[]);
  const lifecycle=new Map((input.format==='v1-journal-input-v3'?[...input.lifecycle,...input.scheduledLifecycle]:input.format==='v1-journal-input-v2'?input.lifecycle:[]).map(s=>[lifecycleTargetKey(s.event.target),s]));
  // Stable report-local pagination, newest creation first. Never rerun primary selection here.
  const sorted=[...rows].sort((a,b)=>{
    const x=byId.get(a.predictionId)!,y=byId.get(b.predictionId)!;
    return x.createdAt===y.createdAt?(x.id<y.id?1:x.id>y.id?-1:0):(x.createdAt<y.createdAt?1:-1);
  });
  return V1JournalViewSchema.parse({requestId:report.request.requestId,revision:saved.revision,sha256:saved.sha256,
    inputSha256:report.inputSha256,previousSha256:report.previousSha256,capturedAt:report.capturedAt,summary,offset,hasMore:sorted.length>offset+50,
    rows:sorted.slice(offset,offset+50).map(row=>{const r=byId.get(row.predictionId)!,o=r.verification?.outcome;
      const state=r.target?lifecycle.get(lifecycleTargetKey(r.target)):null;
      const event=state?(({ownerId,...rest})=>rest)(state.event):null;
      return {...row,lifecycle:event?{event,sha256:state!.sha256}:null,requestId:r.requestId,snapshotSha256:r.snapshotSha256,purpose:r.purpose,createdAt:r.createdAt,issuedAt:r.issuedAt,
        calculationStatus:r.status,attemptReasons:r.attemptReasons,
        ...(r.verification?.scheduleBinding?{scheduleResultBinding:r.verification.scheduleBinding}:{}),
        ...(input.format==='v1-journal-input-v3'?{verifiedScheduleBindingKnown:r.target?.provider==='pandascore'&&scheduledBindings.has(r.target.providerMatchId)}:{}),
        cutoffAt:r.cutoffAt,probability:r.probability,modelId:r.modelId,scenario:{id:r.scenarioId,revision:r.scenarioRevision,title:r.title,
          teamAId:r.teamAId,teamBId:r.teamBId},rosterStatus:r.verification?.rosterStatus??null,
        expectedLineups:{teamA:r.lineupA,teamB:r.lineupB},target:r.target?(r.target.provider==='opendota'
          ?{provider:r.target.provider,providerSeriesId:r.target.providerSeriesId,mapNumber:r.target.mapNumber}
          :{provider:r.target.provider,providerMatchId:r.target.providerMatchId,mapNumber:r.target.mapNumber,targetRequestId:r.target.targetRequestId,targetSha256:r.target.targetSha256}):null,
        outcomeSource:o?{provider:'opendota',receiptId:o.sourceEvidence.receiptId,payloadSha256:o.sourceEvidence.payloadSha256,
          fetchedAt:o.sourceEvidence.receiptFetchedAt,verifiedAt:o.labelVerifiedAt,dataRevision:o.dataRevision}:null,
        actualWinner:o?(o.teamAWon?'A':'B'):null,sourceChangedSinceRefresh:r.sourceChangedSinceRefresh};})});
}
export class V1JournalService {
  private creating=false;
  private readonly repository:V1JournalRepository;
  private constructor(private readonly db:Db,codeHash:string){this.repository=new V1JournalRepository(db,codeHash);}
  static async open(db:Db){return new V1JournalService(db,registryHash(await readV1RuntimeCode()));}
  async create(owner:string,request:unknown){
    if(this.creating)throw Error('journal_request_busy');this.creating=true;
    try{return journalView(await this.repository.create(owner,request));}finally{this.creating=false;}
  }
  async get(owner:string,requestId:string,offset=0){return journalView(await this.repository.get(owner,requestId),offset);}
  async history(owner:string,beforeRevision:number|null=null){
    const result=(await sql`WITH page AS MATERIALIZED (
      SELECT request_id,revision,report_sha256,captured_at,report_text FROM v1_journal_reports
      WHERE owner_user_id=${owner}::uuid AND (${beforeRevision}::integer IS NULL OR revision<${beforeRevision}::integer)
      ORDER BY revision DESC LIMIT 21)
      SELECT request_id AS "requestId",revision,report_sha256 AS sha256,
        to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "capturedAt",
        report_text::jsonb#>'{request,filters}' AS filters,report_text::jsonb#>'{summary,metrics,n}' AS n,
        report_text::jsonb#>'{summary,metrics,accuracy}' AS accuracy FROM page ORDER BY revision DESC`.execute(this.db)).rows;
    const items=V1JournalHistorySchema.shape.items.parse(result.slice(0,20));
    return V1JournalHistorySchema.parse({items,nextBeforeRevision:result.length>20?items.at(-1)!.revision:null});
  }
}
