import {evaluationFixture} from './conditional-evaluation.mjs';
import {bindFixture} from './conditional-source-binding.mjs';
export function evaluatorFixture(){
 const f=evaluationFixture(),start=Date.parse(f.enrollmentInput.window.fromAt),day=86400000;
 const until=new Date(start+28*day).toISOString(),assessmentAt=new Date(start+35*day).toISOString();
 f.enrollmentInput.window.until=until;f.enrollmentInput.snapshotAt=assessmentAt;
 f.featureInput.window.untilAtUs=String(BigInt(Date.parse(until))*1000n);
 f.archive.recordedAt=assessmentAt;bindFixture({input:f.featureInput,archive:f.archive});
 return {...f,schedule:{registeredAt:new Date(start-day).toISOString(),from:f.enrollmentInput.window.fromAt,
  until,assessmentAt,assessedAt:assessmentAt}};
}
