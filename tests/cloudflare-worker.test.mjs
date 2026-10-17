import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { createD1Store } from '../cloudflare/store.mjs';
import { digest } from '../server/credentials.mjs';

const origin = 'https://havs.example.test';
const workerConfig = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const password = 'test-worker-password-2468';
const emptyWorkspace = () => ({ version: 1, tools: [], projects: [], assessments: [] });
const bundlePromise = build({ entryPoints: ['cloudflare/worker.mjs'], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:*'], logLevel: 'silent' });

async function fixture(t, bindings = {}) {
  const { outputFiles } = await bundlePromise;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: outputFiles[0].text,
    compatibilityDate: workerConfig.compatibility_date,
    compatibilityFlags: workerConfig.compatibility_flags,
    d1Databases: { DB: 'havs-worker-http-test' },
    bindings: { APP_ORIGIN: origin, HAVS_ENV: 'production', ...bindings },
    serviceBindings: {
      ASSETS(request) {
        const path = new URL(request.url).pathname;
        if (path === '/bundle.js') return new Response('console.log("asset")', { headers: { 'Content-Type': 'text/javascript' } });
        if (path.endsWith('.js')) return new Response('Not found', { status: 404 });
        return new Response(request.method === 'HEAD' ? null : '<html>HAVS worker application</html>', { headers: { 'Content-Type': 'text/html' } });
      },
    },
    log: new Log(LogLevel.NONE),
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const sql = await readFile(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8');
  // Keep a trigger body together; its internal semicolon is not a statement boundary.
  const statements = sql.replace(/--[^\n]*/g, '').match(/\s*CREATE TRIGGER[\s\S]+?END;|[^;]+;/gi) ?? [];
  await db.batch(statements.map((sql) => db.prepare(sql.trim())));
  const store = createD1Store(db);
  async function request(path, { method = 'GET', body, rawBody, cookie, csrf, requestOrigin = bindings.APP_ORIGIN ?? origin, headers = {} } = {}) {
    const response = await mf.dispatchFetch(origin + path, {
      method,
      headers: {
        ...(method !== 'GET' && requestOrigin !== null ? { Origin: requestOrigin } : {}),
        ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : rawBody !== undefined ? { body: rawBody } : {}),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text };
  }
  async function createAndLogin(email = 'one@example.test') {
    await store.createUser({ email, name: 'Worker test account', password });
    const result = await request('/api/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { cookie: result.headers.get('set-cookie').split(';')[0], csrf: result.body.csrfToken, user: result.body.user };
  }
  return { mf, db, store, request, createAndLogin };
}

test('Worker serves assets with security headers; API never falls through to HTML', async (t) => {
  const { request } = await fixture(t);
  assert.deepEqual((await request('/api/health')).body, { ok: true });
  for (const path of ['/', '/assessments']) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.match(response.body, /HAVS worker application/);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
  }
  assert.equal((await request('/bundle.js')).status, 200);
  assert.equal((await request('/missing.js')).status, 404);
  for (const path of ['/api', '/api/unknown', '/api/workspace']) {
    const response = await request(path);
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'AUTH_REQUIRED');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const path of ['/.env', '/%00', '/%2e%2e%2fsecret.txt', '/%5csecret.txt']) assert.equal((await request(path)).status, 404);
  assert.equal((await request('/%', {})).status, 400);
  assert.equal((await request('/', { method: 'POST' })).status, 405);
});

test('Worker production rejects insecure/malformed configured origins, allows explicit loopback dev', async (t) => {
  for (const APP_ORIGIN of ['http://havs.example.test', origin + '/', 'https://user:pass@havs.example.test']) {
    const f = await fixture(t, { APP_ORIGIN });
    const result = await f.request('/api/health');
    assert.equal(result.status, 500);
    assert.equal(result.body.code, 'INTERNAL_ERROR');
  }
  const f = await fixture(t, { APP_ORIGIN: 'http://127.0.0.1:8787', HAVS_ENV: 'development' });
  assert.equal((await f.request('/api/health')).status, 200);
  const auth = await f.createAndLogin();
  assert.match(auth.cookie, /^havs_session=/);
});

test('Worker invitation signup is email-bound, single-use and never reveals password hashes', async (t) => {
  const { store, request } = await fixture(t);
  const body = { email: 'new@example.test', name: 'New worker', password, inviteCode: 'fake-invite' };
  assert.equal((await request('/api/auth/register', { method: 'POST', body })).status, 400);
  const invite = await store.createInvite({ email: body.email });
  body.inviteCode = invite.code;
  assert.equal((await request('/api/auth/register', { method: 'POST', body: { ...body, email: 'wrong@example.test' } })).status, 400);
  const registered = await request('/api/auth/register', { method: 'POST', body });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  assert.equal(registered.body.user.email, body.email);
  assert.ok(registered.body.csrfToken);
  assert.deepEqual(Object.keys(registered.body).sort(), ['csrfToken', 'user']);
  assert.deepEqual(Object.keys(registered.body.user).sort(), ['email', 'id', 'name']);
  assert.ok(!JSON.stringify(registered.body).includes('password'));
  assert.ok(!JSON.stringify(registered.body).includes('scrypt:'));
  assert.ok(!JSON.stringify(registered.body).includes('verifiedPasswordHash'));
  assert.match(registered.headers.get('set-cookie'), /^__Host-havs_session=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  assert.equal((await request('/api/auth/register', { method: 'POST', body })).status, 400);
});

test('Worker rejects invalid passwords, cross-site login and non-JSON requests', async (t) => {
  const { request, createAndLogin } = await fixture(t);
  const auth = await createAndLogin();
  const login = { method: 'POST', body: { email: auth.user.email, password } };
  for (const requestOrigin of [null, 'https://attacker.example', origin + '/']) assert.equal((await request('/api/auth/login', { ...login, requestOrigin })).status, 403);
  assert.equal((await request('/api/auth/login', { ...login, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request('/api/auth/login', { ...login, body: { ...login.body, password: 'wrong' } })).status, 401);
  assert.equal((await request('/api/auth/login', { ...login, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/auth/login', { ...login, headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await request('/api/auth/login', { method: 'POST', rawBody: '{invalid' })).status, 400);
  const session = await request('/api/session', auth);
  assert.deepEqual(session.body, { user: auth.user, csrfToken: auth.csrf });
  assert.equal(session.headers.get('cache-control'), 'no-store');
  assert.equal(session.headers.get('access-control-allow-origin'), null);
  assert.equal((await request('/api/session', { cookie: `${auth.cookie}; ${auth.cookie}` })).status, 401);
});

test('Worker binds workspace reads and writes to account session and rejects stale revisions', async (t) => {
  const { request, createAndLogin } = await fixture(t);
  const one = await createAndLogin('one@example.test');
  const two = await createAndLogin('two@example.test');
  const workspace = { ...emptyWorkspace(), projects: [{ id: 'p1', name: 'Private account one', site: 'Site', manager: 'Manager' }] };
  const write = { ...one, method: 'PUT', body: { workspace, revision: 0 } };
  assert.equal((await request('/api/workspace', { ...write, csrf: undefined })).status, 403);
  assert.equal((await request('/api/workspace', { ...write, requestOrigin: null })).status, 403);
  assert.equal((await request('/api/workspace', write)).status, 200);
  assert.deepEqual((await request('/api/workspace', two)).body, { workspace: null, revision: 0 });
  assert.deepEqual((await request('/api/workspace', one)).body, { workspace, revision: 1 });
  assert.equal((await request('/api/workspace', write)).status, 409);
  const staleTab = { cookie: two.cookie, csrf: one.csrf };
  assert.equal((await request('/api/workspace', staleTab)).status, 403);
  assert.equal((await request('/api/workspace', { cookie: two.cookie })).status, 403);
  assert.equal((await request('/api/auth/logout', { ...staleTab, method: 'POST' })).status, 403);
  assert.equal((await request('/api/session', two)).status, 200);
  const logout = await request('/api/auth/logout', { ...one, method: 'POST' });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/api/session', one)).status, 401);
});

test('Worker parallel D1 writes accept one revision and preserve winning document', async (t) => {
  const { request, createAndLogin } = await fixture(t);
  const auth = await createAndLogin();
  const documents = ['First update', 'Second update'].map((name) => ({ ...emptyWorkspace(), projects: [{ id: 'p1', name, site: 'Site', manager: 'Manager' }] }));
  const results = await Promise.all(documents.map((workspace) => request('/api/workspace', { ...auth, method: 'PUT', body: { workspace, revision: 0 } })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const winner = documents[results.findIndex((result) => result.status === 200)];
  assert.deepEqual((await request('/api/workspace', auth)).body, { workspace: winner, revision: 1 });
});

test('Worker validates workspace schema and enforces D1-safe request size before storage', async (t) => {
  const { request, createAndLogin } = await fixture(t);
  const auth = await createAndLogin();
  const put = (workspace, revision = 0) => request('/api/workspace', { ...auth, method: 'PUT', body: { workspace, revision } });
  assert.equal((await put({ ...emptyWorkspace(), version: 2 })).status, 400);
  assert.equal((await put({ ...emptyWorkspace(), ownerId: 'someone-else' })).status, 400);
  assert.equal((await put(emptyWorkspace(), -1)).status, 400);
  assert.equal((await put(emptyWorkspace(), Number.MAX_SAFE_INTEGER)).status, 400);
  const tool = { id: 'tool-1', name: 'Drill', model: 'Test', category: 'Drill', vibration: -1, noise: 90, source: 'Measured', inspectionDue: '2026-12-01', sample: false };
  assert.equal((await put({ ...emptyWorkspace(), tools: [tool] })).status, 400);
  tool.vibration = 5;
  assert.equal((await put({ ...emptyWorkspace(), tools: [tool] })).status, 200);
  const oversized = await put({ ...emptyWorkspace(), extra: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, 'BODY_TOO_LARGE');
  const largeValid = { ...emptyWorkspace(), projects: Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, name: 'x'.repeat(9600), site: 'Site', manager: 'Manager' })) };
  const rowLimit = await put(largeValid, 1);
  assert.equal(rowLimit.status, 413);
  assert.equal(rowLimit.body.code, 'WORKSPACE_TOO_LARGE');
  assert.equal((await request('/api/workspace', auth)).body.revision, 1);
});

test('Worker honors D1 session expiry and password-reset revocation', async (t) => {
  const { request, store, db, createAndLogin } = await fixture(t);
  const auth = await createAndLogin();
  await store.resetPassword(auth.user.email, 'changed-worker-password-2468');
  assert.equal((await request('/api/session', auth)).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: auth.user.email, password } })).status, 401);
  const fresh = await request('/api/auth/login', { method: 'POST', body: { email: auth.user.email, password: 'changed-worker-password-2468' } });
  assert.equal(fresh.status, 200);
  const cookie = fresh.headers.get('set-cookie').split(';')[0];
  await db.prepare('UPDATE sessions SET expires_at = ?').bind(Date.now() - 1).run();
  assert.equal((await request('/api/session', { cookie })).status, 401);
});

test('Worker persistent limits reject spoofed forwarding IPs in local development', async (t) => {
  const { request, db } = await fixture(t, { APP_ORIGIN: 'http://127.0.0.1:8787', HAVS_ENV: 'development' });
  await db.prepare('INSERT INTO rate_limits (key_hash, attempts, started_at) VALUES (?, ?, ?)').bind(digest('auth-ip:local'), 30, Date.now()).run();
  const result = await request('/api/auth/login', { method: 'POST', headers: { 'X-Forwarded-For': '1.2.3.4', 'CF-Connecting-IP': '5.6.7.8' }, body: { email: 'one@example.test', password } });
  assert.equal(result.status, 429);
  assert.ok(Number(result.headers.get('retry-after')) > 0);
  await db.prepare('DELETE FROM rate_limits').run();
  await db.prepare('INSERT INTO rate_limits (key_hash, attempts, started_at) VALUES (?, ?, ?)').bind(digest('auth-account:one@example.test'), 10, Date.now()).run();
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'ONE@example.test', password } })).status, 429);
});
