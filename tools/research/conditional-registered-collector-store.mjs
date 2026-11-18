/** Read-only bridge to the actual PostgreSQL registration; no caller-provided owner/receipt attestation. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ConditionalRealRegistrationStore} from './conditional-real-registration-store.mjs';
import {realSha} from './conditional-real-registration.mjs';
import {registeredCollectorPaths,replayRegisteredCollection} from './conditional-registered-collector.mjs';
export class ConditionalRegisteredCollector{
 constructor(db){this.registrations=new ConditionalRealRegistrationStore(db);}
 async inspect(ownerUserId,registrationId,expectedPackageSha,log,expectedLogSha){
  const registration=await this.registrations.read(ownerUserId,registrationId);
  assert.equal(registration.packageSha256,expectedPackageSha,'expected_registration_hash');
  const p=JSON.parse(registration.packageText);
  for(const path of registeredCollectorPaths)assert.equal(realSha(await readFile(path)),p.executable.code[path],'registered_collector_code_changed');
  const report=replayRegisteredCollection(registration,log,expectedLogSha);
  return {report,registrationRead:{basis:'active_owner_postgres_registration_read',id:registration.id,packageSha256:registration.packageSha256,
   recordedAt:registration.recordedAt,registeredAt:registration.registeredAt},persisted:false,collectionAllowed:false};
 }
}
