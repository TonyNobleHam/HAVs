import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { digest, normalizeEmail, validEmail, validName, validPassword, hashPassword } from '../server/credentials.mjs';
import { flags, authenticated, remoteConfig, executeSQL, readPassword, sqlString } from './cloudflare-common.mjs';

const usage = `사용법:
  node scripts/cloudflare-admin.mjs create-user --remote --email EMAIL --name NAME [--password-stdin]
  node scripts/cloudflare-admin.mjs create-invite --remote [--email EMAIL]
  node scripts/cloudflare-admin.mjs reset-password --remote --email EMAIL [--password-stdin]

로컬 D1은 --remote 대신 --local을 사용합니다. 선택적으로 --persist-to PATH를 지정할 수 있습니다.
비밀번호는 숨김 터미널 입력 또는 명시적인 표준 입력만 사용합니다. 명령행 인수로 비밀번호를 넣지 마세요.
Cloudflare 관리 권한이 필요한 도구입니다. 웹 앱에는 관리자 API를 공개하지 않습니다.`;

export async function admin(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (!command || command === '--help') { console.log(usage); return; }
  const options = flags(rest, ['email', 'name', 'persist-to'], ['remote', 'local', 'password-stdin']);
  if (!['create-user', 'create-invite', 'reset-password'].includes(command) || options.remote === options.local || (!options.remote && !options.local)) throw new Error(usage);
  if (options.remote && options['persist-to']) throw new Error('--persist-to는 로컬 D1에서만 사용할 수 있습니다.');
  if (command !== 'create-user' && options.name) throw new Error('--name은 create-user에서만 사용할 수 있습니다.');
  if (command === 'create-invite' && options['password-stdin']) throw new Error('초대 생성에는 비밀번호를 입력하지 않습니다.');
  const email = options.email === undefined ? null : normalizeEmail(options.email);
  if ((command !== 'create-invite' && !email) || (email !== null && !validEmail(email))) throw new Error('유효한 이메일을 입력하세요.');
  if (command === 'create-user' && !validName(options.name)) throw new Error('1–100자의 이름을 입력하세요.');
  let accountId;
  if (options.remote) accountId = await authenticated((await remoteConfig()).account_id);
  const target = { remote: Boolean(options.remote), accountId, persistTo: options['persist-to'] };
  const now = Date.now();
  let sql;
  let code;
  if (command === 'create-invite') {
    code = randomBytes(24).toString('base64url');
    sql = `INSERT INTO invites (code_hash,email,expires_at,used_at) VALUES (${sqlString(digest(code))},${email ? sqlString(email) : 'NULL'},${now + 7 * 86400000},NULL) RETURNING 1 AS changed;`;
  } else {
    const password = await readPassword(Boolean(options['password-stdin']));
    if (!validPassword(password)) throw new Error('비밀번호는 12–128자여야 합니다.');
    const hash = await hashPassword(password);
    if (command === 'create-user') sql = `INSERT INTO users (id,email,name,password_hash,created_at) VALUES (${sqlString(randomUUID())},${sqlString(email)},${sqlString(options.name.trim())},${sqlString(hash)},${now}) RETURNING 1 AS changed;`;
    else {
      // Migration trigger revokes all sessions in the same atomic UPDATE.
      const triggers = await executeSQL("SELECT name FROM sqlite_master WHERE type='trigger' AND name='revoke_sessions_on_password_change';", target);
      if (!triggers.some((result) => result.results?.some((row) => row.name === 'revoke_sessions_on_password_change'))) throw new Error('세션 폐기 트리거가 없습니다. D1 마이그레이션을 먼저 적용하세요.');
      sql = `UPDATE users SET password_hash=${sqlString(hash)} WHERE email=${sqlString(email)} RETURNING 1 AS changed;`;
    }
  }
  const result = await executeSQL(sql, target);
  const changed = result.flatMap((item) => item.results ?? []).find((item) => Object.hasOwn(item, 'changed'))?.changed;
  if (changed !== 1) throw new Error('계정 또는 초대를 변경하지 못했습니다. 이메일과 대상 D1을 확인하세요.');
  if (code) console.log(`초대 코드: ${code}\n7일 동안 한 번 사용할 수 있습니다. 대상 사용자에게만 전달하세요.`);
  else console.log(command === 'create-user' ? '계정을 만들었습니다.' : '비밀번호를 변경하고 기존 세션을 폐기했습니다.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) admin().catch((error) => { console.error(error.message); process.exitCode = 1; });
