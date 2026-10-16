import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { openStore } from '../server/store.mjs';

const origin = 'http://localhost:5173';
const password = 'a-test-password-12345';
const emptyWorkspace = () => ({ version: 1, tools: [], projects: [], assessments: [] });

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'havs-api-'));
  const dataDir = join(root, 'data');
  const staticDir = join(root, 'dist');
  await mkdir(staticDir);
  await writeFile(join(staticDir, 'index.html'), '<html>HAVS test app</html>');
  await writeFile(join(staticDir, 'app.js'), 'console.log("HAVS");');
  const app = createApp({ dataDir, staticDir, origin, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let closed = false;
  t.after(async () => { if (!closed) await app.close(); await rm(root, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, cookie, csrf, requestOrigin = origin, headers = {} } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(method !== 'GET' && requestOrigin !== null ? { Origin: requestOrigin } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text };
  }
  async function createAndLogin(email = 'one@example.test') {
    await app.store.createUser({ email, name: 'Test worker', password });
    const login = await request('/api/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(login.status, 200);
    return { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, user: login.body.user };
  }
  return { app, root, dataDir, staticDir, request, createAndLogin, async close() { closed = true; await app.close(); } };
}

test('health and static routes work; API is never an SPA fallback', async (t) => {
  const { request } = await fixture(t);
  assert.deepEqual((await request('/api/health')).body, { ok: true });
  const page = await request('/assessments');
  assert.equal(page.status, 200);
  assert.match(page.body, /HAVS test app/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await request('/missing.js')).status, 404);
  assert.equal((await request('/api/missing')).status, 401);
  assert.equal((await request('/api/workspace')).status, 401);
});

test('accounts require invitations; invitations are email-bound and single-use', async (t) => {
  const { app, request } = await fixture(t);
  const registration = { email: 'one@example.test', name: 'First worker', password, inviteCode: 'made-up' };
  assert.equal((await request('/api/auth/register', { method: 'POST', body: registration })).status, 400);
  const invite = app.store.createInvite({ email: registration.email });
  registration.inviteCode = invite.code;
  assert.equal((await request('/api/auth/register', { method: 'POST', body: { ...registration, email: 'other@example.test' } })).status, 400);
  const created = await request('/api/auth/register', { method: 'POST', body: registration });
  assert.equal(created.status, 200);
  assert.equal(created.body.user.email, registration.email);
  assert.ok(created.body.csrfToken);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: { ...registration, email: 'another@example.test' } })).status, 400);
  assert.ok(!JSON.stringify(created.body).includes('password'));
});

test('session cookie, exact Origin and CSRF protect workspace and logout', async (t) => {
  const { request, createAndLogin } = await fixture(t);
  const auth = await createAndLogin();
  const session = await request('/api/session', auth);
  assert.deepEqual(session.body, { user: auth.user, csrfToken: auth.csrf });
  const write = { ...auth, method: 'PUT', body: { workspace: emptyWorkspace(), revision: 0 } };
  assert.equal((await request('/api/workspace', { ...write, csrf: undefined })).status, 403);
  assert.equal((await request('/api/workspace', { ...write, requestOrigin: 'https://evil.test' })).status, 403);
  assert.equal((await request('/api/workspace', { ...write, requestOrigin: null })).status, 403);
  assert.equal((await request('/api/workspace', { ...write, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request('/api/workspace', write)).status, 200);
  assert.equal((await request('/api/auth/logout', { ...auth, method: 'POST', csrf: undefined })).status, 403);
  const logout = await request('/api/auth/logout', { ...auth, method: 'POST' });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/api/session', auth)).status, 401);
});

test('login rejects cross-site requests and supplies private HttpOnly cookies', async (t) => {
  const { app, request } = await fixture(t);
  await app.store.createUser({ email: 'one@example.test', name: 'One', password });
  const login = { method: 'POST', body: { email: 'one@example.test', password } };
  assert.equal((await request('/api/auth/login', { ...login, requestOrigin: null })).status, 403);
  assert.equal((await request('/api/auth/login', { ...login, requestOrigin: 'http://evil.test' })).status, 403);
  assert.equal((await request('/api/auth/login', { ...login, body: { ...login.body, password: 'incorrect' } })).status, 401);
  const successful = await request('/api/auth/login', login);
  assert.equal(successful.status, 200);
  assert.match(successful.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(successful.headers.get('cache-control'), 'no-store');
  assert.equal(successful.headers.get('access-control-allow-origin'), null);
});

test('users cannot see each other’s workspaces; stale revisions cannot overwrite', async (t) => {
  const { request, createAndLogin } = await fixture(t);
  const one = await createAndLogin('one@example.test');
  const two = await createAndLogin('two@example.test');
  const workspace = emptyWorkspace();
  workspace.projects.push({ id: 'project-1', name: 'Private project', site: 'Site', manager: 'Manager' });
  assert.deepEqual((await request('/api/workspace', one)).body, { workspace: null, revision: 0 });
  const save = await request('/api/workspace', { ...one, method: 'PUT', body: { workspace, revision: 0 } });
  assert.deepEqual(save.body, { revision: 1 });
  assert.deepEqual((await request('/api/workspace', two)).body, { workspace: null, revision: 0 });
  const stale = await request('/api/workspace', { ...one, method: 'PUT', body: { workspace: emptyWorkspace(), revision: 0 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'REVISION_CONFLICT');
  assert.deepEqual((await request('/api/workspace', one)).body, { workspace, revision: 1 });
});

test('a cookie replaced in another tab cannot reveal the new account to a stale client', async (t) => {
  const { request, createAndLogin } = await fixture(t);
  const first = await createAndLogin('one@example.test');
  const second = await createAndLogin('two@example.test');
  const workspace = { ...emptyWorkspace(), projects: [{ id: 'private-2', name: 'Second account only', site: 'Site', manager: 'Manager' }] };
  await request('/api/workspace', { ...second, method: 'PUT', body: { workspace, revision: 0 } });
  const staleTab = { cookie: second.cookie, csrf: first.csrf };
  const read = await request('/api/workspace', staleTab);
  assert.equal(read.status, 403);
  assert.equal(read.body.code, 'CSRF_REJECTED');
  assert.ok(!JSON.stringify(read.body).includes('Second account only'));
  assert.equal((await request('/api/workspace', { cookie: second.cookie })).status, 403);
  assert.equal((await request('/api/auth/logout', { ...staleTab, method: 'POST' })).status, 403);
  // Rejecting stale logout must leave the replacement session available to its current client.
  assert.deepEqual((await request('/api/session', second)).body.user, second.user);
  assert.deepEqual((await request('/api/workspace', second)).body, { workspace, revision: 1 });
});

test('workspace validation rejects impossible data, unknown fields and oversized requests', async (t) => {
  const { request, createAndLogin } = await fixture(t);
  const auth = await createAndLogin();
  const put = (workspace, revision = 0) => request('/api/workspace', { ...auth, method: 'PUT', body: { workspace, revision } });
  assert.equal((await put({ ...emptyWorkspace(), version: 2 })).status, 400);
  assert.equal((await put({ ...emptyWorkspace(), ownerId: 'someone-else' })).status, 400);
  assert.equal((await put(emptyWorkspace(), -1)).status, 400);
  const workspace = emptyWorkspace();
  workspace.tools.push({ id: 'tool-1', name: 'Drill', model: 'Test', category: 'Drill', vibration: -1, noise: 90, source: 'Measured', inspectionDue: '2026-12-01', sample: false });
  assert.equal((await put(workspace)).status, 400);
  workspace.tools[0].vibration = 5;
  assert.equal((await put(workspace)).status, 200);
  assert.equal((await put({ ...emptyWorkspace(), extra: 'x'.repeat(2 * 1024 * 1024) })).status, 413);
});

test('passwords and session tokens are hashed; data and sessions survive reopening', async (t) => {
  const f = await fixture(t);
  const auth = await f.createAndLogin();
  await f.request('/api/workspace', { ...auth, method: 'PUT', body: { workspace: emptyWorkspace(), revision: 0 } });
  const storedUser = f.app.store.findUser('one@example.test');
  assert.match(storedUser.password_hash, /^scrypt:/);
  assert.ok(!storedUser.password_hash.includes(password));
  const token = auth.cookie.split('=')[1];
  const storedSession = f.app.store.db.prepare('SELECT token_hash FROM sessions').get();
  assert.notEqual(storedSession.token_hash, token);
  await f.close();
  const reopened = openStore(f.dataDir);
  try {
    assert.deepEqual(reopened.session(token), { user: auth.user, csrfToken: auth.csrf });
    assert.deepEqual(reopened.workspace(auth.user.id), { workspace: emptyWorkspace(), revision: 1 });
  } finally { reopened.close(); }
});

test('session expiry and password resets revoke access', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now, sessionTtlMs: 1000 });
  const auth = await f.createAndLogin();
  now += 1001;
  assert.equal((await f.request('/api/session', auth)).status, 401);
  const login = await f.request('/api/auth/login', { method: 'POST', body: { email: auth.user.email, password } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const oldPasswordHash = f.app.store.findUser(auth.user.email).password_hash;
  await f.app.store.resetPassword(auth.user.email, 'changed-password-12345');
  assert.equal(f.app.store.createSession(auth.user.id, 1000, oldPasswordHash), null);
  assert.equal((await f.request('/api/session', { cookie })).status, 401);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { email: auth.user.email, password } })).status, 401);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { email: auth.user.email, password: 'changed-password-12345' } })).status, 200);
});

test('simultaneous writes from the same revision accept exactly one update', async (t) => {
  const { request, createAndLogin } = await fixture(t);
  const auth = await createAndLogin();
  const updates = ['First tab', 'Second tab'].map((name) => ({
    ...emptyWorkspace(), projects: [{ id: 'p1', name, site: 'Site', manager: 'Manager' }],
  }));
  const responses = await Promise.all(updates.map((workspace) => request('/api/workspace', { ...auth, method: 'PUT', body: { workspace, revision: 0 } })));
  assert.deepEqual(responses.map((result) => result.status).sort(), [200, 409]);
  const current = await request('/api/workspace', auth);
  assert.equal(current.body.revision, 1);
  assert.deepEqual(current.body.workspace, updates[responses.findIndex((result) => result.status === 200)]);
});

test('account rate limits persist across restarts and expire after the configured window', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now, authAccountLimit: 2, rateWindowMs: 10000 });
  await f.app.store.createUser({ email: 'one@example.test', name: 'One', password });
  const login = { method: 'POST', body: { email: 'one@example.test', password: 'wrong' } };
  assert.equal((await f.request('/api/auth/login', login)).status, 401);
  assert.equal((await f.request('/api/auth/login', login)).status, 401);
  const limited = await f.request('/api/auth/login', login);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '10');
  await f.close();
  const reopened = openStore(f.dataDir, { now: () => now });
  try {
    assert.equal(reopened.consumeRateLimit('auth-account:one@example.test', 2, 10000), 10);
    now += 10001;
    assert.equal(reopened.consumeRateLimit('auth-account:one@example.test', 2, 10000), 0);
  } finally { reopened.close(); }
});

test('IP rate limiting cannot be bypassed by spoofing forwarding headers', async (t) => {
  const { request } = await fixture(t, { authIpLimit: 1 });
  const login = { method: 'POST', body: { email: 'unknown@example.test', password } };
  assert.equal((await request('/api/auth/login', login)).status, 401);
  assert.equal((await request('/api/auth/login', { ...login, headers: { 'X-Forwarded-For': '1.2.3.4' }, body: { email: 'other@example.test', password } })).status, 429);
});

test('static file serving blocks traversal and symlinks outside dist', async (t) => {
  const { root, staticDir, request } = await fixture(t);
  await writeFile(join(root, 'secret.txt'), 'PRIVATE');
  await symlink(join(root, 'secret.txt'), join(staticDir, 'linked.txt'));
  assert.equal((await request('/linked.txt')).status, 404);
  assert.equal((await request('/%2e%2e%2fsecret.txt')).status, 404);
  assert.equal((await request('/.env')).status, 404);
  assert.equal((await request('/%00')).status, 404);
  assert.equal((await request('/app.js')).status, 200);
});

test('SQLite online backup includes committed data with private permissions', async (t) => {
  const f = await fixture(t);
  const auth = await f.createAndLogin();
  const destination = join(f.root, 'backup.sqlite');
  await f.app.store.backup(destination);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  const db = new DatabaseSync(destination);
  try { assert.equal(db.prepare('SELECT email FROM users WHERE id = ?').get(auth.user.id).email, auth.user.email); }
  finally { db.close(); }
  await assert.rejects(f.app.store.backup(destination));
});

test('production requires an exact HTTPS origin and issues __Host cookies', async (t) => {
  assert.throws(() => createApp({ production: true, origin: 'http://example.test' }), /HTTPS/);
  assert.throws(() => createApp({ production: true, origin: 'https://example.test/' }), /origin/);
  const { app, request } = await fixture(t, { production: true, origin: 'https://havs.example.test' });
  await app.store.createUser({ email: 'one@example.test', name: 'One', password });
  const login = await request('/api/auth/login', { method: 'POST', requestOrigin: 'https://havs.example.test', body: { email: 'one@example.test', password } });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /^__Host-havs_session=.*; Secure$/);
  assert.equal(login.headers.get('strict-transport-security'), 'max-age=31536000');
});
