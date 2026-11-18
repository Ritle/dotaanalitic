import type {QuickForecastProgress,QuickForecastStage} from './quick-forecast-contract.js';
/** Ephemeral status only; no inputs or probabilities. Durable results stay in PostgreSQL. */
export class QuickForecastProgressStore{
 private readonly entries=new Map<string,QuickForecastProgress>();
 constructor(private readonly now=()=>Date.now(),private readonly capacity=500,private readonly ttl=15*60*1000){}
 private key(owner:string,match:string,request:string){return JSON.stringify([owner,match,request]);}
 private prune(){for(const [key,value] of this.entries)if(this.now()-Date.parse(value.updatedAt)>=this.ttl)this.entries.delete(key);}
 get(owner:string,match:string,request:string){this.prune();const value=this.entries.get(this.key(owner,match,request));return value?{...value}:null;}
 start(owner:string,match:string,request:string){
  this.prune();const key=this.key(owner,match,request);
  // A concurrent retry must not reset or fail the first request's indicator.
  if(this.entries.get(key)?.state==='running')return {stage:(_stage:QuickForecastStage,_reused=false)=>{},finish:(_ok:boolean)=>{}};
  while(this.entries.size>=this.capacity)this.entries.delete(this.entries.keys().next().value!);
  const value:QuickForecastProgress={stage:'request',state:'running',reused:false,updatedAt:new Date(this.now()).toISOString()};this.entries.set(key,value);
  return {stage:(stage:QuickForecastStage,reused=false)=>{if(this.entries.get(key)!==value)return;value.stage=stage;value.reused ||= reused;value.updatedAt=new Date(this.now()).toISOString();},
   finish:(ok:boolean)=>{if(this.entries.get(key)!==value)return;value.state=ok?'complete':'failed';if(ok)value.stage='complete';value.updatedAt=new Date(this.now()).toISOString();}};
 }
}
