import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { sql, type Db } from '@dota/db';
import { OwnerLoginSchema, OwnerPasswordSchema } from '@dota/contracts';

const passwordOptions = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const SESSION_SECONDS = 12 * 60 * 60;
export class AuthError extends Error {
  constructor(readonly code: 'OWNER_EXISTS' | 'OWNER_NOT_FOUND' | 'UNAUTHORIZED' | 'RATE_LIMITED', readonly retryAfter = 0) { super(code); }
}
interface OwnerRecord { id: string; login: string; password_hash: string; is_active: boolean }
export interface Session {
  owner: { id: string; login: string };
  expiresAt: string;
  tokenHash: string;
}

// One dummy hash per process prevents the unknown-login path skipping Argon2.
let dummyHash: Promise<string> | undefined;
function dummy() { return dummyHash ??= argon2.hash(randomBytes(32), passwordOptions); }

export class AuthService {
  constructor(private readonly db: Db) {}

  async provision(loginInput: string, passwordInput: string, reset = false) {
    const login = OwnerLoginSchema.parse(loginInput);
    const password = OwnerPasswordSchema.parse(passwordInput);
    const hash = await argon2.hash(password, passwordOptions);
    return this.db.transaction().execute(async tx => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('dota-owner-provision'))`.execute(tx);
      const { rows } = await sql<OwnerRecord>`SELECT id,login,password_hash,is_active FROM app_users FOR UPDATE`.execute(tx);
      if (rows.length && !reset) throw new AuthError('OWNER_EXISTS');
      const owner = rows[0];
      if (reset) {
        if (!owner || owner.login !== login) throw new AuthError('OWNER_NOT_FOUND');
        await sql`UPDATE app_users SET password_hash=${hash},updated_at=now() WHERE id=${owner.id}`.execute(tx);
        await sql`UPDATE auth_sessions SET revoked_at=now() WHERE user_id=${owner.id} AND revoked_at IS NULL`.execute(tx);
        return { id: owner.id, login: owner.login };
      }
      const result = await sql<{id:string;login:string}>`INSERT INTO app_users(login,password_hash) VALUES (${login},${hash}) RETURNING id,login`.execute(tx);
      return result.rows[0]!;
    });
  }

  async reserveLoginAttempt() {
    const result = await this.db.transaction().execute(async tx => {
      await sql`INSERT INTO auth_login_budget(singleton,window_started_at,attempts) VALUES (TRUE,now(),0) ON CONFLICT DO NOTHING`.execute(tx);
      await sql`SELECT singleton FROM auth_login_budget FOR UPDATE`.execute(tx);
      const { rows } = await sql<{attempts:number;retry_after:number}>`UPDATE auth_login_budget SET
        attempts=CASE WHEN window_started_at+interval '15 minutes'<=now() THEN 1 ELSE attempts+1 END,
        window_started_at=CASE WHEN window_started_at+interval '15 minutes'<=now() THEN now() ELSE window_started_at END
        RETURNING attempts, greatest(1,ceil(extract(epoch FROM window_started_at+interval '15 minutes'-now())))::integer AS retry_after`.execute(tx);
      return rows[0]!;
    });
    if (result.attempts > 10) throw new AuthError('RATE_LIMITED', result.retry_after);
  }

  async login(login: string, password: string, previousToken?: string) {
    await this.reserveLoginAttempt();
    const fallback = await dummy();
    const { rows } = await sql<OwnerRecord>`SELECT id,login,password_hash,is_active FROM app_users WHERE login=${login}`.execute(this.db);
    const owner = rows[0];
    const valid = await argon2.verify(owner?.password_hash ?? fallback, password).catch(() => false);
    if (!owner || !owner.is_active || !valid) throw new AuthError('UNAUTHORIZED');
    const token = randomBytes(32).toString('base64url');
    const digest = tokenHash(token);
    const expiresAt = await this.db.transaction().execute(async tx => {
      // Serialize with reset/deactivation and recheck the hash after slow verify.
      const current = await sql<OwnerRecord>`SELECT id,login,password_hash,is_active FROM app_users WHERE id=${owner.id} FOR UPDATE`.execute(tx);
      if (!current.rows[0]?.is_active || current.rows[0].password_hash !== owner.password_hash) throw new AuthError('UNAUTHORIZED');
      if (previousToken) await sql`UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=${tokenHash(previousToken)} AND revoked_at IS NULL`.execute(tx);
      const session = await sql<{expires_at:Date}>`INSERT INTO auth_sessions(user_id,token_hash,expires_at)
        VALUES (${owner.id},${digest},now()+${SESSION_SECONDS}*interval '1 second') RETURNING expires_at`.execute(tx);
      return session.rows[0]!.expires_at.toISOString();
    });
    return { token, tokenHash: digest, owner: { id: owner.id, login: owner.login }, expiresAt };
  }

  async authenticate(token: string | undefined): Promise<Session | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const digest = tokenHash(token);
    const { rows } = await sql<{id:string;login:string;expires_at:Date}>`SELECT u.id,u.login,s.expires_at
      FROM auth_sessions s JOIN app_users u ON u.id=s.user_id
      WHERE s.token_hash=${digest} AND s.revoked_at IS NULL AND s.expires_at>now() AND u.is_active IS TRUE`.execute(this.db);
    const row = rows[0];
    return row ? { owner: { id: row.id, login: row.login }, expiresAt: row.expires_at.toISOString(), tokenHash: digest } : null;
  }

  async logout(session: Session) {
    await sql`UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=${session.tokenHash} AND revoked_at IS NULL`.execute(this.db);
  }
}
