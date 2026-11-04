import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,existsSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,sep,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../../',import.meta.url));
// Explicit fake Docker/pg boundaries: these tests never start containers or connect to PostgreSQL.
const valid={SITE_HOST:'analytics.personal-domain.net',POSTGRES_DB:'dota',POSTGRES_USER:'owner',POSTGRES_PASSWORD:'synthetic-production-password',
  DATABASE_URL:'postgresql://owner:synthetic-production-password@postgres:5432/dota',NODE_ENV:'production',WEB_ORIGIN:'https://analytics.personal-domain.net',
  AUTH_COOKIE_SECRET:'synthetic-cookie-key-at-least-thirty-two-characters',PANDASCORE_API_TOKEN:'synthetic-provider-token'};
function fixture(values={},options={}){
  const directory=mkdtempSync(join(tmpdir(),'dota-deploy-'));
  for(const name of ['scripts/lib','node_modules/pg'])mkdirSync(join(directory,name),{recursive:true});
  copyFileSync(join(root,'scripts/preflight.mjs'),join(directory,'scripts/preflight.mjs'));
  if(existsSync(join(root,'scripts/lib/deployment-preflight.mjs')))copyFileSync(join(root,'scripts/lib/deployment-preflight.mjs'),join(directory,'scripts/lib/deployment-preflight.mjs'));
  copyFileSync(join(root,'pnpm-lock.yaml'),join(directory,'pnpm-lock.yaml'));
  writeFileSync(join(directory,'package.json'),JSON.stringify({type:'module',packageManager:'pnpm@10.19.0'}));
  const env={...valid,...values},name=options.file??'.env.production';
  writeFileSync(join(directory,name),Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n'));
  writeFileSync(join(directory,'node_modules/pg/package.json'),JSON.stringify({type:'module',exports:'./index.js'}));
  writeFileSync(join(directory,'node_modules/pg/index.js'),`import fs from 'node:fs';
    export class Client{constructor(o){this.o=o;fs.writeFileSync(process.env.FAKE_PROBE,JSON.stringify({url:o.connectionString,ended:false}));}
      async connect(){if(process.env.FAKE_PG_FAIL==='1')throw Error('synthetic-preflight-private-error');}
      async query(){return {rows:[{db:'synthetic_db'}]};}
      async end(){fs.writeFileSync(process.env.FAKE_PROBE,JSON.stringify({url:this.o.connectionString,ended:true}));}}
  `);
  const rendered={services:{postgres:{environment:{POSTGRES_DB:env.POSTGRES_DB,POSTGRES_USER:env.POSTGRES_USER,POSTGRES_PASSWORD:env.POSTGRES_PASSWORD}},
    migrate:{environment:{DATABASE_URL:env.DATABASE_URL}},api:{environment:{DATABASE_URL:env.DATABASE_URL,NODE_ENV:'production',WEB_ORIGIN:env.WEB_ORIGIN,
      AUTH_COOKIE_SECRET:env.AUTH_COOKIE_SECRET,PANDASCORE_API_TOKEN:env.PANDASCORE_API_TOKEN}},
    worker:{environment:{DATABASE_URL:env.DATABASE_URL,OPENDOTA_BASE_URL:'https://api.opendota.com/api'}},
    web:{environment:{SITE_HOST:env.SITE_HOST},ports:[{target:80,published:'80',protocol:'tcp'},{target:443,published:'443',protocol:'tcp'},{target:443,published:'443',protocol:'udp'}]}}};
  if(options.missingToken)delete rendered.services.api.environment.PANDASCORE_API_TOKEN;
  if(options.publicDb)rendered.services.postgres.ports=[{target:5432,published:'5432'}];
  writeFileSync(join(directory,'preload.mjs'),`import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    cp.spawnSync=(_file,args,options)=>{fs.appendFileSync(process.env.FAKE_COMMANDS,JSON.stringify({args,fileSecretInChild:options.env.POSTGRES_PASSWORD!==undefined})+'\\n');
      if(args[0]==='info')return {status:${options.engineDown?1:0},stdout:'synthetic engine',stderr:''};
      if(args.includes('config'))return {status:0,stdout:${JSON.stringify(JSON.stringify(rendered))},stderr:''};
      return {status:0,stdout:'Docker Compose version synthetic',stderr:''};};syncBuiltinESMExports();`);
  const probe=join(directory,'probe.json'),commands=join(directory,'commands.jsonl');
  const invoke=(args=[],ambient={})=>{
    const inherited={...process.env};for(const key of Object.keys(valid))delete inherited[key];
    const result=spawnSync(process.execPath,['--import',pathToFileURL(join(directory,'preload.mjs')).href,join(directory,'scripts/preflight.mjs'),'--production','--strict',...args],
      {cwd:directory,encoding:'utf8',timeout:10000,windowsHide:true,env:{...inherited,FAKE_PROBE:probe,FAKE_COMMANDS:commands,...ambient}});
    assert.equal(result.error,undefined);assert.equal(result.stderr,'',result.stderr);return result;
  };
  const close=()=>{const target=realpathSync(directory),base=realpathSync(tmpdir());
    assert.ok(target.startsWith(base+sep)&&/^dota-deploy-/.test(basename(target)));rmSync(target,{recursive:true,force:true});};
  return {directory,env,probe,commands,invoke,close};
}
test('valid production file is checked without a database connection unless requested',()=>{
  const f=fixture();try{const r=f.invoke();assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(existsSync(f.probe),false);
    const calls=readFileSync(f.commands,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(calls.some(c=>c.args.includes('config')));for(const call of calls)assert.equal(call.fileSecretInChild,false);
  }finally{f.close();}
});
test('production preflight refuses ambient development database overrides before probing',()=>{
  const f=fixture();try{const r=f.invoke(['--require-db'],{DATABASE_URL:'postgresql://dev:synthetic-dev-password@localhost/dev'});
    assert.equal(r.status,1);assert.equal(existsSync(f.probe),false);}finally{f.close();}
});
test('production origin and database URL must match the selected Compose deployment',()=>{
  for(const change of [{WEB_ORIGIN:valid.WEB_ORIGIN+'/private-path'},{WEB_ORIGIN:'https://other.personal-domain.net'},
    {DATABASE_URL:'postgresql://owner:wrong-password@postgres:5432/dota'},{DATABASE_URL:valid.DATABASE_URL+'?host=elsewhere'}]){
    const f=fixture(change);try{assert.equal(f.invoke().status,1);}finally{f.close();}
  }
});
test('installed Compose CLI with a stopped engine does not pass production preflight',()=>{
  const f=fixture({}, {engineDown:true});try{assert.equal(f.invoke().status,1);}finally{f.close();}
});
test('rendered production services must retain provider configuration and private database ports',()=>{
  for(const options of [{missingToken:true},{publicDb:true}]){const f=fixture({},options);try{assert.equal(f.invoke().status,1);}finally{f.close();}}
});
test('database errors never echo private messages and the probe client always closes',()=>{
  const f=fixture();try{const r=f.invoke(['--require-db'],{DATABASE_URL:valid.DATABASE_URL,FAKE_PG_FAIL:'1'});
    assert.equal(r.status,1);assert.doesNotMatch(r.stdout+r.stderr,/synthetic-preflight-private-error|synthetic-production-password/);
    assert.equal(JSON.parse(readFileSync(f.probe,'utf8')).ended,true);}finally{f.close();}
});
test('explicit env file selects the configuration checked and probed',()=>{
  const f=fixture({}, {file:'selected.env'});try{const r=f.invoke(['--env-file','selected.env','--require-db'],{DATABASE_URL:valid.DATABASE_URL});
    assert.equal(r.status,0,r.stdout+r.stderr);assert.deepEqual(JSON.parse(readFileSync(f.probe,'utf8')),{url:valid.DATABASE_URL,ended:true});}finally{f.close();}
});
test('example domains do not become production-ready after filling only secrets',()=>{
  const f=fixture({SITE_HOST:'analytics.example.com',WEB_ORIGIN:'https://analytics.example.com'});try{assert.equal(f.invoke().status,1);}finally{f.close();}
});
test('machine-readable preflight reports disclose no secrets and never claim a build or deployment',()=>{
  const f=fixture();try{const r=f.invoke(['--json']);assert.equal(r.status,0,r.stdout+r.stderr);const report=JSON.parse(r.stdout);
    assert.equal(report.scope,'production_preflight_only');assert.equal(report.status,'passed');
    for(const key of ['containerBuildExecuted','deploymentExecuted','modelActivationExecuted'])assert.equal(report[key],false);
    assert.doesNotMatch(r.stdout,/synthetic-production-password|synthetic-provider-token|synthetic-cookie-key/);
  }finally{f.close();}
});
import {productionEnvironmentChecks,productionComposeChecks} from '../../scripts/lib/deployment-preflight.mjs';

test('role provider configuration is validated and must be forwarded to the API without ambient overrides',()=>{
  const selected={...valid,ROLE_PROFILES_ENABLED:'true',STRATZ_API_TOKEN:'synthetic-stratz-role-secret'};
  assert.equal(productionEnvironmentChecks(selected,{}).find(c=>c.name==='Role profiles mode')?.ok,true);
  assert.equal(productionEnvironmentChecks({...selected,ROLE_PROFILES_ENABLED:'TRUE'},{}).find(c=>c.name==='Role profiles mode')?.ok,false);
  assert.equal(productionEnvironmentChecks(selected,{ROLE_PROFILES_ENABLED:'false'}).find(c=>c.name==='Environment overrides')?.ok,false);
  assert.equal(productionEnvironmentChecks({...selected,STRATZ_API_TOKEN:'bad\nheader'},{}).find(c=>c.name==='STRATZ token syntax')?.ok,false);
  const rendered={services:{api:{environment:{}}}};
  assert.equal(productionComposeChecks(rendered,selected).find(c=>c.name==='Compose role providers')?.ok,false);
  rendered.services.api.environment={ROLE_PROFILES_ENABLED:'true',STRATZ_API_TOKEN:selected.STRATZ_API_TOKEN};
  assert.equal(productionComposeChecks(rendered,selected).find(c=>c.name==='Compose role providers')?.ok,true);
});
