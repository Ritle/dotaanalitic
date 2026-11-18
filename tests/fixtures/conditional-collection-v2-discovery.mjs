/** Synthetic journal/archive evidence for offline replay only. */
import {randomUUID} from 'node:crypto';
import {registrationV2Fixture} from './conditional-registration-v2.mjs';
import {archiveSha as sha,archiveMetadata} from '../../tools/research/conditional-blob-archive.mjs';
export const discoveryAt='2026-12-04T00:00:00.000Z';
export async function discoveryFixture(){
 const p=await registrationV2Fixture();p.executable.code['tools/research/conditional-collection-v2-discovery.mjs']='a'.repeat(64);
 const text=JSON.stringify(p),id=randomUUID(),registeredAt='2026-11-15T01:00:00.000Z';
 const registration={id,packageText:text,packageSha256:sha(text),recordedAt:registeredAt,registeredAt,status:'registered_plan_only',clockBasis:'postgres_observed_commit'};
 const headerText=JSON.stringify({format:'conditional-collection-v2-journal',registrationId:id,registrationSha256:registration.packageSha256,
  ownerUserId:p.review.reviewerUserId,archiveHeaderSha256:'b'.repeat(64),syntheticOnly:true,createdAt:registeredAt});
 const header={registration_id:id,registration_sha256:registration.packageSha256,owner_user_id:p.review.reviewerUserId,
  archive_header_sha256:'b'.repeat(64),synthetic_only:true,created_at:registeredAt,header_text:headerText,header_sha256:sha(headerText)};
 return {registration,header,events:[],snapshotAt:discoveryAt,responses:new Map()};
}
export function discoveryEvent(f,command,event,at=discoveryAt){
 const sequence=f.events.length,parent=f.events.at(-1)?.head_sha256??f.header.header_sha256,operation=randomUUID();
 const commandText=JSON.stringify(command),eventText=JSON.stringify({...event,sequence,at,requestId:command.requestId});
 f.events.push({registration_id:f.registration.id,sequence,operation_id:operation,command_text:commandText,command_sha256:sha(commandText),
  parent_sha256:parent,event_text:eventText,recorded_at:at,head_sha256:sha(parent+':'+operation+':'+sha(commandText)+':'+eventText)});
 f.snapshotAt=at;
}
export function discoveryReserve(f,endpoint,at=discoveryAt){const requestId=randomUUID();
 discoveryEvent(f,{kind:'reserve',requestId,endpoint},{kind:'reserved',endpoint},at);return requestId;}
export function discoveryResponse(f,endpoint,body,at=discoveryAt){
 const requestId=discoveryReserve(f,endpoint,at),bytes=Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
 const metadata=archiveMetadata(f.registration.id,{requestId,endpoint,httpStatus:200,receivedAt:at,clientValidationCode:null},
  {sha256:sha(bytes),byteLength:bytes.length},true),metadataText=JSON.stringify(metadata);
 f.responses.set(requestId,{metadataText,bytes});
 discoveryEvent(f,{kind:'complete',requestId},{kind:'archived',receiptSha256:sha(metadataText),bodySha256:sha(bytes),archiveEntryHeadSha256:'c'.repeat(64),receivedAt:at},at);
 return requestId;
}
