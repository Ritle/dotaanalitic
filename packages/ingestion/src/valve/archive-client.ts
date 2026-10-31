import https from 'node:https';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {z} from 'zod';
import {ValvePatchError} from './patch-client.js';
import {parseArchiveIndex,archiveStampAt} from './archive-evidence.js';
import {retryAfterMilliseconds} from '../opendota/client.js';
import {teamAccountOriginal} from './team-account-evidence.js';
import {parseSteamProfileArchiveIndex,steamProfileLocation} from './steam-profile-evidence.js';
type RawResponse={status:number;headers:Record<string,string|undefined>;bytes:Buffer};
type RawTransport=(url:URL)=>Promise<RawResponse>;
function rawHttps(url:URL):Promise<RawResponse>{
  return new Promise((resolve,reject)=>{
    const request=https.get(url,{headers:{Accept:'application/json, text/html', 'User-Agent':'Dota2PersonalSourceAudit/1.0'}},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>2*1024*1024){response.destroy();request.destroy(new Error('archive_response_too_large'));}else chunks.push(chunk);});
      response.on('error',()=>{clearTimeout(timer);reject(new ValvePatchError('archive_network_error'));});
      response.on('end',()=>{clearTimeout(timer);resolve({status:response.statusCode??0,
        headers:Object.fromEntries(Object.entries(response.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):v])),bytes:Buffer.concat(chunks)});});
    });
    const timer=setTimeout(()=>request.destroy(new Error('archive_timeout')),20000);
    request.on('error',e=>{clearTimeout(timer);reject(new ValvePatchError(e.message==='archive_timeout'?'archive_timeout':e.message==='archive_response_too_large'?'archive_response_too_large':'archive_network_error'));});
  });
}
export class ArchiveEvidenceClient{
  private used=0;private nextAt=0;private tail=Promise.resolve();private statuses:Record<string,number>={};
  constructor(private readonly dependencies:{raw?:RawTransport;now?:()=>number;sleep?:(ms:number)=>Promise<void>;maxRequests?:number}={}){
    z.number().int().min(1).max(8).parse(dependencies.maxRequests??6);
  }
  get requestStats(){return {attempts:this.used,httpStatuses:{...this.statuses}};}
  private now(){return this.dependencies.now?.()??Date.now();}
  private original(eventId:string){if(!/^[1-9]\d{0,19}$/.test(eventId))throw new ValvePatchError('invalid_event_id');return `https://store.steampowered.com/news/app/570/view/${eventId}`;}
  async findBefore(eventId:string,beforeAt:string){
    return this.findOriginalBefore(this.original(eventId),beforeAt);
  }
  async findTi12Before(beforeAt:string){
    return this.findOriginalBefore('https://www.dota2.com/esports/ti12',beforeAt,'2023-10-01T00:00:00.000Z');
  }
  async findTeamAccountsBefore(teamId:string,beforeAt:string){
    return this.findOriginalBefore(teamAccountOriginal(teamId),beforeAt);
  }
  async getTeamAccountsSnapshot(teamId:string,timestamp:string){
    return this.getOriginalSnapshot(teamAccountOriginal(teamId),timestamp);
  }
  async findSteamProfileBefore(accountId:string,original:string,beforeAt:string){
    steamProfileLocation(original,accountId);
    return this.findOriginalBefore(original,beforeAt,undefined,(input,url,cutoff)=>parseSteamProfileArchiveIndex(input,url,accountId,cutoff));
  }
  async getSteamProfileSnapshot(accountId:string,original:string,timestamp:string){
    steamProfileLocation(original,accountId);return this.getOriginalSnapshot(original,timestamp);
  }
  private async findOriginalBefore(original:string,beforeAt:string,fromAt?:string,parseIndex= parseArchiveIndex){
    z.iso.datetime({precision:3}).parse(beforeAt);const url=new URL('https://web.archive.org/cdx/search/cdx');
    if(fromAt!==undefined&&beforeAt<=fromAt)throw new ValvePatchError('invalid_archive_window');
    url.search=new URLSearchParams({url:original,output:'json',filter:'statuscode:200',to:beforeAt.replace(/[-:TZ.]/g,'').slice(0,14),collapse:'timestamp:8',fl:'timestamp,original,digest',limit:'5'}).toString();
    if(fromAt!==undefined)url.searchParams.set('from',fromAt.replace(/[-:TZ.]/g,'').slice(0,14));
    const r=await this.request(url),bytes=r.headers['content-encoding']==='gzip'?gunzipSync(r.bytes,{maxOutputLength:4*1024*1024}):r.bytes;
    const records=parseIndex(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),original,beforeAt);
    if(fromAt!==undefined&&records.some(row=>row.capturedAt<fromAt))throw new ValvePatchError('archive_record_outside_window');
    return {records,source:r.source};
  }
  async getSnapshot(eventId:string,timestamp:string){
    return this.getOriginalSnapshot(this.original(eventId),timestamp);
  }
  async getTi12Snapshot(timestamp:string){
    return this.getOriginalSnapshot('https://www.dota2.com/esports/ti12',timestamp);
  }
  private async getOriginalSnapshot(original:string,timestamp:string){
    archiveStampAt(timestamp);const url=new URL(`https://web.archive.org/web/${timestamp}id_/${original}`),r=await this.request(url);
    const links=r.headers.link??'',originalLinks=[...links.matchAll(/<([^>]+)>;\s*rel="original"/g)];
    if(originalLinks.length!==1)throw new ValvePatchError('archive_original_link_missing_or_ambiguous');
    return {timestamp,original,originalLink:originalLinks[0]![1]!,mementoDatetime:r.headers['memento-datetime']??'',encoding:r.headers['content-encoding']??'identity',bytes:r.bytes,source:r.source};
  }
  private request(url:URL){const task=this.tail.then(()=>this.perform(url));this.tail=task.then(()=>undefined,()=>undefined);return task;}
  private async perform(url:URL){
    let last=new ValvePatchError('archive_network_error');
    for(let attempt=0;attempt<2;attempt++){
      const wait=Math.max(0,this.nextAt-this.now());if(wait>10000)throw new ValvePatchError('archive_wait_budget_exhausted',last.status,wait);
      if(wait)await (this.dependencies.sleep??(ms=>new Promise(r=>setTimeout(r,ms))))(wait);
      if(this.used>=(this.dependencies.maxRequests??6))throw new ValvePatchError('archive_request_budget_exhausted');this.used++;this.nextAt=this.now()+1000;
      try{
        const r=await (this.dependencies.raw??rawHttps)(url);this.statuses[r.status]=(this.statuses[r.status]??0)+1;
        if(r.bytes.byteLength>2*1024*1024)throw new ValvePatchError('archive_response_too_large');
        if(r.status===200)return {...r,source:{url:url.href,fetchedAt:new Date(this.now()).toISOString(),payloadSha256:createHash('sha256').update(r.bytes).digest('hex'),attempts:attempt+1}};
        const retry=retryAfterMilliseconds(r.headers['retry-after']??null,this.now());last=new ValvePatchError(r.status===429?'archive_rate_limited':'archive_http_error',r.status,retry);
        if(r.status!==429&&r.status<500)throw last;
      }catch(e){if(e instanceof ValvePatchError&&['archive_http_error','archive_response_too_large'].includes(e.code))throw e;
        if(e instanceof ValvePatchError)last=e;else last=new ValvePatchError('archive_network_error');}
      this.nextAt=Math.max(this.nextAt,this.now()+Math.max(1000*2**attempt,last.retryAfterMs??0));
      if(attempt===1)throw last;
    }
    throw last;
  }
}
