import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEPLOY_DIR = join(ROOT, '.cloudflare-deploy');
export const REMOTE_CONFIG = join(DEPLOY_DIR, 'wrangler.json');
export const STATE_FILE = join(DEPLOY_DIR, 'state.json');
export const HOSTNAME = 'havs.oehnps.co.uk';
export const ZONE_NAME = 'oehnps.co.uk';
const AUTH_HELP = 'Cloudflare 인증을 확인할 수 없습니다. 개인 PC에서 npx wrangler login 후 다시 실행하거나, 환경 설정에 CLOUDFLARE_API_TOKEN을 안전하게 연결하세요. 토큰을 대화창에 붙여 넣지 마세요.';

export function flags(args, values = [], switches = []) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || Object.hasOwn(result, key)) throw new Error('잘못되거나 중복된 옵션입니다. --help를 확인하세요.');
    if (switches.includes(key)) result[key] = true;
    else if (values.includes(key) && args[index + 1] && !args[index + 1].startsWith('--')) result[key] = args[++index];
    else throw new Error('지원하지 않는 옵션 또는 누락된 값입니다. --help를 확인하세요.');
  }
  return result;
}

export function jsonOutput(output) {
  const text = output.replace(/\u001b\[[0-9;]*m/g, '').trim();
  try { return JSON.parse(text); } catch { /* Some Wrangler versions prepend a notice. */ }
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '{' && text[index] !== '[') continue;
    try { return JSON.parse(text.slice(index)); } catch { /* Try the next JSON start. */ }
  }
  throw new Error('Wrangler 응답을 해석할 수 없습니다. 설치된 CLI 버전과 연결 상태를 확인하세요.');
}

// Local runtimes never use Cloudflare authentication. Isolate their telemetry
// and development metadata without redirecting real OAuth or remote commands.
export async function localWranglerEnvironment() {
  const directory = join(ROOT, '.wrangler', 'local-config');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return { XDG_CONFIG_HOME: directory };
}

// Capture output and remove protected logs: SQL files may contain password hashes.
// Never forward Wrangler's raw error output or authentication-token command output.
export async function wrangler(args, { accountId, label = 'Cloudflare 명령', timeout = 180000 } = {}) {
  const executable = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
  if (!existsSync(executable)) throw new Error('먼저 npm ci를 실행하세요.');
  const logs = await mkdtemp(join(tmpdir(), 'havs-cloudflare-log-'));
  try {
    const localEnvironment = args.includes('--local') || args.includes('--dry-run') ? await localWranglerEnvironment() : {};
    return await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [executable, ...args], {
        cwd: ROOT,
        env: { ...process.env, ...localEnvironment, ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}), CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_NO_SKILLS_UPDATE_PROMPTS: 'true', WRANGLER_REGISTRY_PATH: process.env.WRANGLER_REGISTRY_PATH ?? join(ROOT, '.wrangler', 'registry'), WRANGLER_LOG_PATH: join(logs, 'wrangler.log') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, timeout);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', () => { clearTimeout(timer); reject(new Error(`${label} 실행에 실패했습니다. Node.js와 Wrangler 설치를 확인하세요.`)); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolveResult(stdout);
        if (expired) return reject(new Error(`${label} 시간이 초과되었습니다. 네트워크 연결을 확인하세요.`));
        if (/not logged in|not authenticated|loggedIn[^a-z]+false|CLOUDFLARE_API_TOKEN|authentication error/i.test(`${stdout}\n${stderr}`)) return reject(new Error(AUTH_HELP));
        reject(new Error(`${label}에 실패했습니다. 인증 권한, 네트워크, 계정 한도를 확인하세요. 비밀 정보가 포함될 수 있어 원문 로그는 출력하지 않습니다.`));
      });
    });
  } finally { await rm(logs, { recursive: true, force: true }); }
}

export async function authenticated(accountId) {
  const identity = jsonOutput(await wrangler(['whoami', '--json'], { label: '인증 확인' }));
  if (!identity.loggedIn || !Array.isArray(identity.accounts)) throw new Error(AUTH_HELP);
  const requested = accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const account = requested ? identity.accounts.find((item) => item.id === requested) : identity.accounts.length === 1 ? identity.accounts[0] : null;
  if (!account || !/^[a-f0-9]{32}$/i.test(account.id)) throw new Error('사용할 Cloudflare 계정을 결정할 수 없습니다. 접근 가능한 계정 ID를 --account-id로 지정하세요.');
  return account.id;
}

export async function apiClient() {
  const auth = jsonOutput(await wrangler(['auth', 'token', '--json'], { label: '인증 연결' }));
  const headers = auth.token ? { Authorization: `Bearer ${auth.token}` } : auth.type === 'api_key' && auth.key && auth.email ? { 'X-Auth-Key': auth.key, 'X-Auth-Email': auth.email } : null;
  if (!headers) throw new Error(AUTH_HELP);
  configureProxy();
  return async (path, { method = 'GET', body, allowNotFound = false } = {}) => {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('잘못된 Cloudflare API 경로입니다.');
    let response;
    try {
      response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method, headers: { ...headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000), redirect: 'error',
      });
    } catch { throw new Error('Cloudflare API에 연결할 수 없습니다. 네트워크 허용 도메인과 프록시 설정을 확인하세요.'); }
    if (allowNotFound && response.status === 404) return { success: false, notFound: true, result: null };
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      const codes = payload?.errors?.map((item) => Number(item.code)).filter(Number.isFinite).join(', ');
      throw new Error(`Cloudflare API 요청 실패 (HTTP ${response.status}${codes ? `, 코드 ${codes}` : ''}). 계정 권한과 기존 리소스를 확인하세요.`);
    }
    return payload;
  };
}

export function configureProxy() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    if (typeof http.setGlobalProxyFromEnv !== 'function') throw new Error('프록시 환경에서는 최신 Node.js 24를 사용하세요.');
    http.setGlobalProxyFromEnv();
  }
}

export async function readJSON(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function writeJSON(path, value) {
  await mkdir(DEPLOY_DIR, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
export async function remoteConfig() {
  if (!existsSync(REMOTE_CONFIG)) throw new Error('먼저 node scripts/cloudflare-setup.mjs --remote를 실행하세요.');
  const config = await readJSON(REMOTE_CONFIG);
  const binding = config.d1_databases?.find((item) => item.binding === 'DB');
  if (!/^[a-f0-9]{32}$/i.test(config.account_id ?? '') || !binding || binding.database_id === '00000000-0000-0000-0000-000000000000') throw new Error('실제 계정과 D1 연결 설정이 필요합니다. cloudflare-setup을 다시 확인하세요.');
  return config;
}

export const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
export async function executeSQL(sql, { remote = false, config = remote ? REMOTE_CONFIG : join(ROOT, 'wrangler.jsonc'), accountId, persistTo } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'havs-d1-admin-'));
  const file = join(temporary, 'operation.sql');
  try {
    await writeFile(file, sql, { mode: 0o600 });
    if (remote) {
      const settings = await readJSON(config);
      const binding = settings.d1_databases?.find((item) => item.binding === 'DB');
      if (settings.account_id !== accountId || !/^[a-f0-9-]{36}$/i.test(binding?.database_id ?? '')) throw new Error('D1 계정과 연결 설정이 일치하지 않습니다.');
      const api = await apiClient();
      // Wrangler --file uses D1's bulk-import endpoint remotely. The query API
      // keeps ordinary account operations online and returns actual query rows.
      const response = await api(`/accounts/${accountId}/d1/database/${binding.database_id}/query`, {
        method: 'POST', body: { sql: await readFile(file, 'utf8') },
      });
      if (!Array.isArray(response.result) || response.result.some((item) => !item.success)) throw new Error('D1 쿼리를 완료하지 못했습니다. 대상 DB와 마이그레이션을 확인하세요.');
      return response.result;
    }
    const args = ['d1', 'execute', 'DB', remote ? '--remote' : '--local', '--config', config, '--file', file, '--json'];
    if (persistTo) args.push('--persist-to', resolve(persistTo));
    return jsonOutput(await wrangler(args, { accountId, label: 'D1 작업' }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function readPassword(fromStdin) {
  if (fromStdin) {
    let text = '';
    for await (const chunk of process.stdin) {
      text += chunk;
      if (Buffer.byteLength(text) > 1024) throw new Error('비밀번호 입력이 너무 깁니다.');
    }
    return text.replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('숨김 입력이 가능한 터미널에서 실행하거나 --password-stdin을 명시하세요.');
  process.stderr.write('비밀번호 (12–128자, 숨김 입력): ');
  return new Promise((resolvePassword, reject) => {
    let value = '';
    process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
    const finish = (error) => {
      process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', handle); process.stderr.write('\n');
      if (error) reject(error); else resolvePassword(value);
    };
    const handle = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003' || character === '\u0004') return finish(new Error('취소했습니다.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = [...value].slice(0, -1).join('');
        else if (character >= ' ' && value.length < 129) value += character;
      }
    };
    process.stdin.on('data', handle);
  });
}

export async function buildFrontend() {
  await new Promise((resolveBuild, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
      cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
    });
    child.once('error', () => reject(new Error('npm run build를 시작할 수 없습니다. Node.js/npm 설치를 확인하세요.')));
    child.once('close', (code) => code === 0 ? resolveBuild() : reject(new Error('화면 빌드에 실패했습니다. 배포하지 않았습니다.')));
  });
}
