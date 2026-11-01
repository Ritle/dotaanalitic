import {readFile,stat,mkdir,open} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createDatabase,sql} from '../packages/db/dist/index.js';
import {validateCurrentHistoryCapture,IngestionService} from '../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),mode=args.shift(),flags={};
const hash=b=>createHash('sha256').update(b).digest('hex');
function local(file){if(typeof file!=='string')throw new Error('path');const path=resolve(root,file),rel=relative(root,path);
  if(!rel||rel.startsWith('..')||isAbsolute(rel)||!rel.endsWith('.json'))throw new Error('path');return path;}
async function read(file){const path=local(file);if((await stat(path)).size>128*1024*1024)throw new Error('size');return readFile(path);}
let db,handle,writesStarted=false;
try{
  if(args.length%2)throw new Error('usage');for(let i=0;i<args.length;i+=2){if(flags[args[i]])throw new Error('usage');flags[args[i]]=args[i+1];}
  const required=['--capture','--audit','--audit-sha256','--out',...(mode==='apply'?['--plan','--plan-sha256']:[])];
  if(!['preview','apply'].includes(mode)||Object.keys(flags).length!==required.length||required.some(k=>!flags[k]))throw new Error('usage');
  const out=local(flags['--out']);await mkdir(dirname(out),{recursive:true});handle=await open(out,'wx');
  const [captureBytes,auditBytes]=await Promise.all([read(flags['--capture']),read(flags['--audit'])]);
  if(hash(auditBytes)!==flags['--audit-sha256'])throw new Error('audit_hash');
  const audit=JSON.parse(auditBytes),validated=validateCurrentHistoryCapture(JSON.parse(captureBytes));
  const eligible=validated.matches.filter(m=>m.eligible),matchIds=eligible.map(m=>m.matchId);
  if(audit.mode!=='live_opendota'||audit.current_history_capture?.sha256!==hash(captureBytes)||
    JSON.stringify(audit.current_history_capture.eligibleMatchIds)!==JSON.stringify(matchIds)||
    JSON.stringify(audit.selection?.team_ids)!==JSON.stringify(validated.capture.teamIds)||
    JSON.stringify(audit.selection?.selected_match_ids)!==JSON.stringify(validated.selection.selected.map(m=>m.match_id)))throw new Error('audit_binding');
  const input={capture:{file:flags['--capture'],sha256:hash(captureBytes)},audit:{file:flags['--audit'],sha256:hash(auditBytes)}};
  let planInput=null;
  if(mode==='apply'){
    const planBytes=await read(flags['--plan']);if(hash(planBytes)!==flags['--plan-sha256'])throw new Error('plan_hash');
    const plan=JSON.parse(planBytes);
    if(plan.mode!=='current_history_preview'||plan.capture.sha256!==input.capture.sha256||plan.audit.sha256!==input.audit.sha256||
      JSON.stringify(plan.eligibleMatchIds)!==JSON.stringify(matchIds)||!matchIds.length)throw new Error('plan_binding');
    planInput={file:flags['--plan'],sha256:hash(planBytes)};
  }
  if(!process.env.DATABASE_URL)throw new Error('database_configuration');db=createDatabase(process.env.DATABASE_URL);
  const inventory=async()=>(await sql`SELECT id::text,data_revision::text,ingest_state,is_pro FROM matches
    WHERE id=ANY(${matchIds}::bigint[]) ORDER BY id`.execute(db)).rows;
  const before=await inventory(),results=[],errors=[];
  if(mode==='apply'){
    // These are byte-verified captured observations, never a fallback synthetic provider.
    const provider={getHeroes:async()=>validated.heroes,getLeagues:async()=>validated.leagues,getMatchSource:async id=>{
      const m=eligible.find(row=>row.matchId===id);if(!m)throw new Error('match_outside_review');return m.observation;}};
    const importer=new IngestionService(db,provider);
    for(const id of matchIds)try{writesStarted=true;results.push(await importer.ingest(id));}
    catch{errors.push({matchId:id,code:'canonical_import_failed'});break;}
  }
  const report={schemaVersion:1,mode:'current_history_'+mode,generatedAt:new Date().toISOString(),...input,planInput,
    status:!matchIds.length?'unavailable':errors.length?'partial':mode==='apply'&&results.some(r=>r.status==='conflict')?'conflict':'ready',
    cutoffAt:validated.capture.cutoffAt,teamIds:validated.capture.teamIds,eligibleMatchIds:matchIds,
    excluded:validated.matches.filter(m=>!m.eligible).map(m=>({matchId:m.matchId,reasons:m.reasons})),
    sourceErrors:validated.capture.errors,existingMaps:before,...(mode==='apply'?{results,errors,mapsAfter:await inventory()}:{}),
    canonicalWritesAttempted:writesStarted,networkRequests:0,
    warnings:['BOUNDED_ORGANIZATION_HISTORY_NOT_COMPLETE_PLAYER_CAREER','CURRENT_RETROSPECTIVE_DISPLAY_ONLY',
      'UNKNOWN_PATCH_SERIES_ROLES_AND_IDENTITIES_REMAIN_UNKNOWN','PER_MAP_TRANSACTIONS_REPLAY_SAFE'],
    trainingExamples:0,trainingReady:false,deployable:false};
  const body=JSON.stringify(report,null,2)+'\n';await handle.writeFile(body);
  console.log(JSON.stringify({file:relative(root,out).replaceAll('\\','/'),sha256:hash(body),status:report.status,
    eligibleMaps:matchIds.length,results:results.length,duplicates:results.filter(r=>r.duplicate).length,errors:errors.length,networkRequests:0}));
  if(report.status!=='ready')process.exitCode=1;
}catch(e){console.error(JSON.stringify({code:writesStarted?'history_write_or_report_failed':'history_import_rejected',canonicalWritesAttempted:writesStarted,
  message:'Проверьте capture, SHA аудита/плана и состояние импорта. Частично завершённую партию можно повторить с теми же файлами.'}));process.exitCode=1;
}finally{await handle?.close();await db?.destroy();}
