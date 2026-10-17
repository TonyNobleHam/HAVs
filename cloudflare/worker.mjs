import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { normalizeEmail, validEmail, validPassword, validName, verifyPassword } from '../server/credentials.mjs';
import { validateWorkspace } from '../server/validation.mjs';
import { createD1Store } from './store.mjs';

// Bound raw requests separately from the 1.9 MB serialized document limit
// enforced by the store. The envelope and JSON whitespace also count here.
const MAX_BODY = 2 * 1024 * 1024;
const SESSION_TTL = 12 * 60 * 60 * 1000;
const RATE_WINDOW = 15 * 60 * 1000;
const DUMMY_HASH = 'scrypt:00000000000000000000000000000000:' + '00'.repeat(64);
const plainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const fail = (status, code, error, headers) => json(status, { code, error }, headers);
const requestError = (status, code, message) => Object.assign(new Error(message), { status, code });

function configuration(env) {
  let parsed;
  try { parsed = new URL(env.APP_ORIGIN); } catch { throw new Error('APP_ORIGIN must be an exact HTTPS origin.'); }
  const development = env.HAVS_ENV === 'development';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.origin !== env.APP_ORIGIN || parsed.username || parsed.password || !(parsed.protocol === 'https:' || (development && local && parsed.protocol === 'http:'))) {
    throw new Error('APP_ORIGIN must be an exact HTTPS origin, or HTTP loopback in explicit development mode.');
  }
  return { origin: parsed.origin, secure: parsed.protocol === 'https:', development };
}

function secureResponse(response, secure) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (secure) headers.set('Strict-Transport-Security', 'max-age=31536000');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw requestError(415, 'CONTENT_TYPE', 'JSON 형식으로 요청해 주세요.');
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') throw requestError(415, 'CONTENT_ENCODING', '압축 요청은 지원하지 않습니다.');
  const oversized = () => requestError(413, 'BODY_TOO_LARGE', '요청이 너무 큽니다. 최대 2 MB입니다.');
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw oversized();
  const reader = request.body?.getReader();
  const chunks = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY) { await reader.cancel(); throw oversized(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
    if (!plainObject(value)) throw new Error();
    return value;
  } catch { throw requestError(400, 'INVALID_JSON', '올바른 JSON 요청이 아닙니다.'); }
}

async function serveAssets(request, env, pathname) {
  if (!['GET', 'HEAD'].includes(request.method)) return fail(405, 'METHOD_NOT_ALLOWED', '허용되지 않는 요청입니다.');
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return fail(400, 'INVALID_PATH', '올바르지 않은 경로입니다.'); }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some((part) => part === '..' || part.startsWith('.'))) return fail(404, 'NOT_FOUND', '찾을 수 없습니다.');
  if (!env.ASSETS) return fail(503, 'BUILD_MISSING', '웹 빌드가 없습니다. npm run build를 실행해 주세요.');
  const response = await env.ASSETS.fetch(request);
  // HTML must revalidate after deployment. Static resources contain no account data.
  if (response.headers.get('content-type')?.includes('text/html')) {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-cache');
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

async function handle(request, env, config) {
  const pathname = new URL(request.url).pathname;
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return serveAssets(request, env, pathname);
  const writes = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
  if (writes && (request.headers.get('origin') !== config.origin || request.headers.get('sec-fetch-site') === 'cross-site')) return fail(403, 'ORIGIN_REJECTED', '허용되지 않은 요청 출처입니다.');
  if (pathname === '/api/health' && request.method === 'GET') return json(200, { ok: true });
  const store = createD1Store(env.DB);
  const cookieName = config.secure ? '__Host-havs_session' : 'havs_session';
  const cookie = (token, ttl) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}${config.secure ? '; Secure' : ''}`;
  if ((pathname === '/api/auth/login' || pathname === '/api/auth/register') && request.method === 'POST') {
    // Cloudflare overwrites this header at its edge. Local development must not
    // accept a caller's invented IP; neither mode trusts X-Forwarded-For.
    const ip = !config.development && request.cf ? (request.headers.get('cf-connecting-ip') ?? 'edge-unknown') : 'local';
    const retryIp = await store.consumeRateLimit(`auth-ip:${ip}`, 30, RATE_WINDOW);
    if (retryIp) return fail(429, 'RATE_LIMIT', '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.', { 'Retry-After': String(retryIp) });
    const body = await readBody(request);
    const email = normalizeEmail(body.email);
    if (!validEmail(email) || typeof body.password !== 'string' || body.password.length > 128 || Buffer.byteLength(body.password) > 512) return fail(400, 'INVALID_CREDENTIALS', '이메일과 비밀번호를 확인해 주세요.');
    const retryAccount = await store.consumeRateLimit(`auth-account:${email}`, 10, RATE_WINDOW);
    if (retryAccount) return fail(429, 'RATE_LIMIT', '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.', { 'Retry-After': String(retryAccount) });
    let user;
    let verifiedPasswordHash = null;
    if (pathname.endsWith('/login')) {
      const found = await store.findUser(email);
      const valid = await verifyPassword(body.password, found?.password_hash ?? DUMMY_HASH);
      if (!found || !valid) return fail(401, 'LOGIN_FAILED', '이메일 또는 비밀번호가 올바르지 않습니다.');
      user = await store.publicUser(found);
      verifiedPasswordHash = found.password_hash;
    } else {
      if (!validName(body.name) || !validPassword(body.password) || typeof body.inviteCode !== 'string') return fail(400, 'INVALID_REGISTRATION', '이름, 12~128자 비밀번호, 초대 코드를 확인해 주세요.');
      const registration = await store.register({ ...body, email });
      if (!registration) return fail(400, 'REGISTRATION_FAILED', '가입 정보를 확인해 주세요. 사용 가능한 초대 코드와 미등록 이메일이 필요합니다.');
      user = registration.user;
      verifiedPasswordHash = registration.verifiedPasswordHash;
    }
    const session = await store.createSession(user.id, SESSION_TTL, verifiedPasswordHash);
    if (!session) return fail(401, 'LOGIN_FAILED', '이메일 또는 비밀번호가 올바르지 않습니다.');
    return json(200, { user, csrfToken: session.csrfToken }, { 'Set-Cookie': cookie(session.token, SESSION_TTL) });
  }
  const cookieParts = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
  const token = cookieParts.length === 1 ? cookieParts[0].slice(cookieName.length + 1) : '';
  const session = await store.session(token);
  if (!session) return fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
  if (pathname === '/api/session' && request.method === 'GET') return json(200, session);
  // Binding reads to the UI's session prevents a stale tab from reading another
  // account when a second tab replaces the browser's shared session cookie.
  if ((writes || (pathname === '/api/workspace' && request.method === 'GET')) && !safeEqual(request.headers.get('x-csrf-token'), session.csrfToken)) return fail(403, 'CSRF_REJECTED', '세션을 새로고침하고 다시 시도해 주세요.');
  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    await store.revokeSession(token);
    return new Response(null, { status: 204, headers: { 'Set-Cookie': cookie('', 0), 'Cache-Control': 'no-store' } });
  }
  if (pathname === '/api/workspace' && request.method === 'GET') return json(200, await store.workspace(session.user.id));
  if (pathname === '/api/workspace' && request.method === 'PUT') {
    const body = await readBody(request);
    if (!Number.isSafeInteger(body.revision) || body.revision < 0 || body.revision >= Number.MAX_SAFE_INTEGER || !validateWorkspace(body.workspace)) return fail(400, 'INVALID_WORKSPACE', '작업 공간 데이터 또는 버전이 올바르지 않습니다.');
    const revision = await store.saveWorkspace(session.user.id, body.workspace, body.revision);
    if (revision === null) return fail(409, 'REVISION_CONFLICT', '다른 창에서 저장한 변경 사항이 있습니다. 최신 데이터를 불러온 후 다시 시도해 주세요.');
    return json(200, { revision });
  }
  return fail(404, 'NOT_FOUND', 'API를 찾을 수 없습니다.');
}

export default {
  async fetch(request, env) {
    let config;
    try {
      config = configuration(env);
      return secureResponse(await handle(request, env, config), config.secure);
    } catch (error) {
      const response = error.status
        ? fail(error.status, error.code, error.message)
        : fail(500, 'INTERNAL_ERROR', '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      // Never include database exceptions, request bodies or credentials in logs
      // or responses. Runtime diagnostics can identify the failing endpoint.
      return secureResponse(response, config?.secure ?? false);
    }
  },
};
