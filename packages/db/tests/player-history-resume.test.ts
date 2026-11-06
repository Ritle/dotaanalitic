import {it,expect} from 'vitest';
import {historyResumeScope} from '../src/player-history-resume-repository.js';
import type {PlayerHistoryRow} from '../src/player-history-repository.js';
it('keeps the validated map scope available after a resume worker dies before writing its report',()=>{
 const row:PlayerHistoryRow={id:'10000000-0000-4000-8000-000000000001',owner_user_id:'10000000-0000-4000-8000-000000000002',lineup_key:'a'.repeat(64),bindings:[],options:{windowDays:365,maxMaps:25},operation:'evidence_resume',parent_run_id:'10000000-0000-4000-8000-000000000003',scope_map_ids:['10','2'],status:'error',created_at:new Date(),finished_at:new Date(),next_allowed_at:new Date(),attempt:0,lease_token:null,report:null,source_audit:null,error_code:'worker_unavailable'};
 expect(historyResumeScope(row)).toEqual(['2','10']);
 expect(historyResumeScope({...row,status:'queued'})).toEqual([]);
 expect(historyResumeScope({...row,operation:'import',parent_run_id:null})).toEqual([]);
 expect(historyResumeScope({...row,scope_map_ids:['invalid']})).toEqual([]);
});
