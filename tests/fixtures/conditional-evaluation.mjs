import {enrollmentFixture} from './conditional-enrollment.mjs';
import {sourceFixture} from './conditional-source-binding.mjs';
export function evaluationFixture(){
 const e=enrollmentFixture(),s=sourceFixture(),register=JSON.parse(e.input.registers[0].rawBody);
 s.input.window={fromAtUs:String(BigInt(Date.parse(e.input.window.fromAt))*1000n),untilAtUs:String(BigInt(Date.parse(e.input.window.until))*1000n)};
 s.input.series[0].completedAtUs=String(BigInt(Date.parse(register.series[0].completedAt))*1000n);
 return {enrollmentInput:e.input,featureInput:s.input,archive:s.archive,
  requiredExposure:{sourceSha256:s.input.exposure.sourceSha256,mapIds:[],seriesKeys:[]}};
}
