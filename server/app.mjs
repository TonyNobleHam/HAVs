import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { isWorkspace } from '../src/domain.ts';
import { openStore, normalizeEmail, validEmail, validPassword, validName, verifyPassword } from './store.mjs';

const MAX_BODY = 2 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp' };
const DUMMY_HASH = 'scrypt:00000000000000000000000000000000:' + '00'.repeat(64);
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const plainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateWorkspace(workspace) {
  if (!isWorkspace(workspace)) return false;
  if (workspace.tools.length > 10000 || workspace.projects.length > 10000 || workspace.assessments.length > 10000) return false;
  // Bound nested user strings and reject unknown fields to keep stored documents predictable.
  const fields = {
    tool: ['id','name','model','category','vibration','noise','source','inspectionDue','sample'],
    project: ['id','name','site','manager'],
    assessment: ['id','worker','projectId','date','activities','notes','createdAt'],
    activity: ['id','toolId','toolName','vibration','noise','minutes','source','sample'],
  };
  const validFields = (item, allowed) => Object.keys(item).every((key) => allowed.includes(key)) && Object.values(item).every((value) => typeof value !== 'string' || value.length <= 10000);
  return Object.keys(workspace).every((key) => ['version','tools','projects','assessments'].includes(key)) &&
    workspace.tools.every((item) => validFields(item, fields.tool)) &&
    workspace.projects.every((item) => validFields(item, fields.project)) &&
    workspace.assessments.every((item) => validFields(item, fields.assessment) && item.activities.length <= 1000 && item.activities.every((row) => validFields(row, fields.activity)));
}

export function createApp(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const origin = options.origin ?? process.env.APP_ORIGIN ?? (production ? null : 'http://localhost:5173');
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); } catch { throw new Error('APP_ORIGIN must be the exact public origin, such as https://havs.example.com.'); }
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password || (production && parsedOrigin.protocol !== 'https:')) {
    throw new Error('APP_ORIGIN must be an exact HTTP origin (HTTPS required in production), with no path or trailing slash.');
  }
  const secure = parsedOrigin.protocol === 'https:';
  const cookieName = secure ? '__Host-havs_session' : 'havs_session';
  const store = options.store ?? openStore(options.dataDir ?? process.env.HAVS_DATA_DIR ?? resolve('data'), { now: options.now });
  const staticDir = resolve(options.staticDir ?? 'dist');
  const sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
  const rateWindowMs = options.rateWindowMs ?? 15 * 60 * 1000;
  const authAccountLimit = options.authAccountLimit ?? 10;
  const authIpLimit = options.authIpLimit ?? 30;
  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const fail = (res, status, code, error) => json(res, status, { code, error });
  const cookie = (token, ttl) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}${secure ? '; Secure' : ''}`;
  const getToken = (req) => {
    const parts = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
    return parts.length === 1 ? parts[0].slice(cookieName.length + 1) : '';
  };
  async function readBody(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('JSON 형식으로 요청해 주세요.'), { status: 415, code: 'CONTENT_TYPE' });
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw Object.assign(new Error('압축 요청은 지원하지 않습니다.'), { status: 415, code: 'CONTENT_ENCODING' });
    if (Number(req.headers['content-length']) > MAX_BODY) throw Object.assign(new Error('요청이 너무 큽니다. 최대 2 MB입니다.'), { status: 413, code: 'BODY_TOO_LARGE' });
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > MAX_BODY) throw Object.assign(new Error('요청이 너무 큽니다. 최대 2 MB입니다.'), { status: 413, code: 'BODY_TOO_LARGE' });
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!plainObject(value)) throw new Error();
      return value;
    } catch { throw Object.assign(new Error('올바른 JSON 요청이 아닙니다.'), { status: 400, code: 'INVALID_JSON' }); }
  }
  async function staticFile(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'METHOD_NOT_ALLOWED', '허용되지 않는 요청입니다.');
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return fail(res, 400, 'INVALID_PATH', '올바르지 않은 경로입니다.'); }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some((part) => part === '..' || part.startsWith('.'))) return fail(res, 404, 'NOT_FOUND', '찾을 수 없습니다.');
    const root = await realpath(staticDir).catch(() => null);
    if (!root) return fail(res, 503, 'BUILD_MISSING', '웹 빌드가 없습니다. npm run build를 실행해 주세요.');
    let file = resolve(root, `.${decoded}`);
    if (file !== root && !file.startsWith(root + sep)) return fail(res, 404, 'NOT_FOUND', '찾을 수 없습니다.');
    let info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      if (extname(decoded)) return fail(res, 404, 'NOT_FOUND', '찾을 수 없습니다.');
      file = resolve(root, 'index.html');
      info = await stat(file).catch(() => null);
    }
    const actual = await realpath(file).catch(() => null);
    if (!info?.isFile() || !actual?.startsWith(root + sep)) return fail(res, 404, 'NOT_FOUND', '찾을 수 없습니다.');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : /[.-][A-Za-z0-9_-]{8,}\./.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(actual);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (production && secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const pathname = new URL(req.url, origin).pathname;
      if (pathname !== '/api' && !pathname.startsWith('/api/')) return await staticFile(req, res, pathname);
      res.setHeader('Cache-Control', 'no-store');
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return fail(res, 403, 'ORIGIN_REJECTED', '허용되지 않은 요청 출처입니다.');
      }
      if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
      if ((pathname === '/api/auth/login' || pathname === '/api/auth/register') && req.method === 'POST') {
        // Never trust forwarded addresses: the reverse proxy must provide per-client rate limiting as well.
        const ip = req.socket.remoteAddress ?? 'unknown';
        const retryIp = store.consumeRateLimit(`auth-ip:${ip}`, authIpLimit, rateWindowMs);
        if (retryIp) { res.setHeader('Retry-After', retryIp); return fail(res, 429, 'RATE_LIMIT', '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.'); }
        const body = await readBody(req);
        const email = normalizeEmail(body.email);
        if (!validEmail(email) || typeof body.password !== 'string' || body.password.length > 128 || Buffer.byteLength(body.password) > 512) return fail(res, 400, 'INVALID_CREDENTIALS', '이메일과 비밀번호를 확인해 주세요.');
        const retryAccount = store.consumeRateLimit(`auth-account:${email}`, authAccountLimit, rateWindowMs);
        if (retryAccount) { res.setHeader('Retry-After', retryAccount); return fail(res, 429, 'RATE_LIMIT', '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.'); }
        let user;
        let verifiedPasswordHash = null;
        if (pathname.endsWith('/login')) {
          const found = store.findUser(email);
          const valid = await verifyPassword(body.password, found?.password_hash ?? DUMMY_HASH);
          if (!found || !valid) return fail(res, 401, 'LOGIN_FAILED', '이메일 또는 비밀번호가 올바르지 않습니다.');
          user = store.publicUser(found);
          verifiedPasswordHash = found.password_hash;
        } else {
          if (!validName(body.name) || !validPassword(body.password) || typeof body.inviteCode !== 'string') return fail(res, 400, 'INVALID_REGISTRATION', '이름, 12~128자 비밀번호, 초대 코드를 확인해 주세요.');
          user = await store.register({ ...body, email });
          if (!user) return fail(res, 400, 'REGISTRATION_FAILED', '가입 정보를 확인해 주세요. 사용 가능한 초대 코드와 미등록 이메일이 필요합니다.');
        }
        const session = store.createSession(user.id, sessionTtlMs, verifiedPasswordHash);
        if (!session) return fail(res, 401, 'LOGIN_FAILED', '이메일 또는 비밀번호가 올바르지 않습니다.');
        res.setHeader('Set-Cookie', cookie(session.token, sessionTtlMs));
        return json(res, 200, { user, csrfToken: session.csrfToken });
      }
      const token = getToken(req);
      const session = store.session(token);
      if (!session) return fail(res, 401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
      if (pathname === '/api/session' && req.method === 'GET') return json(res, 200, session);
      const requiresSessionBinding = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || (pathname === '/api/workspace' && req.method === 'GET');
      // Bind workspace reads as well as writes to the session shown in the client.
      // Another tab can replace the shared cookie after this tab loaded its account identity.
      if (requiresSessionBinding && !safeEqual(req.headers['x-csrf-token'], session.csrfToken)) return fail(res, 403, 'CSRF_REJECTED', '세션을 새로고침하고 다시 시도해 주세요.');
      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        store.revokeSession(token);
        res.setHeader('Set-Cookie', cookie('', 0));
        res.writeHead(204); return res.end();
      }
      if (pathname === '/api/workspace' && req.method === 'GET') return json(res, 200, store.workspace(session.user.id));
      if (pathname === '/api/workspace' && req.method === 'PUT') {
        const body = await readBody(req);
        if (!Number.isSafeInteger(body.revision) || body.revision < 0 || body.revision >= Number.MAX_SAFE_INTEGER || !validateWorkspace(body.workspace)) return fail(res, 400, 'INVALID_WORKSPACE', '작업 공간 데이터 또는 버전이 올바르지 않습니다.');
        const revision = store.saveWorkspace(session.user.id, body.workspace, body.revision);
        if (revision === null) return fail(res, 409, 'REVISION_CONFLICT', '다른 창에서 저장한 변경 사항이 있습니다. 최신 데이터를 불러온 후 다시 시도해 주세요.');
        return json(res, 200, { revision });
      }
      return fail(res, 404, 'NOT_FOUND', 'API를 찾을 수 없습니다.');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error.status) return fail(res, error.status, error.code, error.message);
      options.onError?.(error);
      return fail(res, 500, 'INTERNAL_ERROR', '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {
    server, store,
    async close() {
      if (server.listening) await new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeIdleConnections(); });
      store.close();
    },
  };
}
