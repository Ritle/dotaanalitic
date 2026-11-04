import {test,expect,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sourceConnection,assertCreatedTarget,postgresEnvironment} from '../../../scripts/lib/local-restore-drill.mjs';
test('native tools receive explicit credentials and no inherited libpq connection overrides',()=>{
  vi.stubEnv('PGHOSTADDR','not-a-numeric-address');vi.stubEnv('PGSERVICE','synthetic-other-service');vi.stubEnv('PGOPTIONS','synthetic-options');
  try{
    const env=postgresEnvironment({password:'synthetic-private'});
    expect(env.PGHOSTADDR).toBeUndefined();expect(env.PGSERVICE).toBeUndefined();expect(env.PGOPTIONS).toBeUndefined();
    expect(env.PGPASSWORD).toBe('synthetic-private');expect(env.PGSSLMODE).toBe('disable');
  }finally{vi.unstubAllEnvs();}
});
test('restore target must be newly created with our generated prefix and never the source',()=>{
  const name='codex_restore_0123456789ab';
  expect(()=>assertCreatedTarget(name,'dota_analytics',true)).not.toThrow();
  for(const [target,source,created] of [[name,name,true],[name,'dota_analytics',false],['dota_analytics','source',true],['codex_restore_x;DROP DATABASE a','source',true]])
    expect(()=>assertCreatedTarget(target,source,created)).toThrow('UNSAFE_RESTORE_TARGET');
});
test('source accepts only explicit local PostgreSQL URLs and ordinary database names',()=>{
  expect(sourceConnection('postgresql://owner:p%40ss@127.0.0.1:5432/source').password).toBe('p@ss');
  for(const value of ['postgresql://owner:secret@remote.example/source','https://localhost/source','postgresql://localhost/source?host=remote.example','postgresql://localhost/source%3Bdrop','invalid-private-secret'])
    expect(()=>sourceConnection(value)).toThrow('LOCAL_DATABASE_REQUIRED');
});
// Each CLI process has its own default test budget; four cold Node starts must
// not share a single 5s budget. Keep the same process limit and assertions.
test.each([
  {name:'invalid source',args:[]},
  {name:'target override',args:['--target','dota_analytics']},
  {name:'archive override',args:['--archive','private-archive']},
  {name:'unknown flag',args:['--pg-bin','unused']},
])('CLI rejects $name without exposing credentials',({args})=>{
  const script=fileURLToPath(new URL('../../../scripts/local-restore-drill.mjs',import.meta.url));
    const r=spawnSync(process.execPath,[script,...args],{encoding:'utf8',windowsHide:true,timeout:20000,
      env:{...process.env,DATABASE_URL:'postgresql://owner:private-source-secret@remote.example/source'}});
    expect(r.status).toBe(1);expect(r.stderr).toContain('unavailable');expect(r.stdout+r.stderr).not.toContain('private-source-secret');
    expect(r.stderr).not.toContain('private-archive');
});
