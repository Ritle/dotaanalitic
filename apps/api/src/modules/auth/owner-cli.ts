import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { createDatabase } from '@dota/db';
import { AuthError, AuthService } from './service.js';

async function hiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('tty_required');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') { finish(); reject(new Error('cancelled')); return; }
        if (char === '\r' || char === '\n') { finish(); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && value.length < 129) value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}
async function readPasswordStdin() {
  process.stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (Buffer.byteLength(value) > 1024) throw new Error('password_input_too_large');
  }
  return value.replace(/\r?\n$/, '');
}
export async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { login: { type: 'string' }, 'password-stdin': { type: 'boolean' } } });
  const command = positionals[0];
  if (!['create', 'reset'].includes(command ?? '') || positionals.length !== 1) throw new Error('invalid_command');
  let login = values.login;
  if (!login && !values['password-stdin']) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { login = await prompt.question('Логин владельца: '); } finally { prompt.close(); }
  }
  if (!login || !process.env.DATABASE_URL) throw new Error('configuration_required');
  const password = values['password-stdin'] ? await readPasswordStdin() : await hiddenPassword('Пароль (не менее 12 символов, ввод скрыт): ');
  if (!values['password-stdin'] && password !== await hiddenPassword('Повторите пароль: ')) throw new Error('password_mismatch');
  const db = createDatabase(process.env.DATABASE_URL);
  try {
    await new AuthService(db).provision(login, password, command === 'reset');
    console.log(JSON.stringify({ status: command === 'reset' ? 'password_reset_sessions_revoked' : 'owner_created' }));
  } finally { await db.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = error instanceof AuthError ? error.code : 'OWNER_COMMAND_FAILED';
    console.error(JSON.stringify({ code, message: 'Не удалось изменить аккаунт. Проверьте команду, данные и подключение к БД.' }));
    process.exitCode = 1;
  });
}
