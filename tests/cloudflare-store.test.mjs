import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createD1Store, MAX_DOCUMENT_BYTES } from '../cloudflare/store.mjs';
import { digest, hashPassword, verifyPassword } from '../server/credentials.mjs';

const password = 'd1-test-password-12345';
const workerConfig = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const empty = () => ({ version: 1, tools: [], projects: [], assessments: [] });
const migration = await readFile(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8');
// D1 exec() splits lines. Batch complete SQL statements so the trigger's internal
// semicolon remains part of CREATE TRIGGER instead of becoming a separate query.
const statements = migration.replace(/^\s*--.*$/gm, '').trim()
  .split(/;\s*(?=CREATE\b|$)/).map((statement) => statement.trim()).filter(Boolean);

async function fixture(t, { now = Date.now } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'havs-d1-store-'));
  const options = convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: workerConfig.compatibility_date,
    d1Databases: { DB: 'havs-store-test' },
    cf: false,
  });
  options.resourcePersistencePath = join(directory, 'storage');
  let instance;
  let db;
  let store;
  async function open() {
    instance = new Miniflare(options);
    db = await instance.getD1Database('DB');
    await db.batch(statements.map((sql) => db.prepare(sql)));
    store = createD1Store(db, { now });
  }
  t.after(async () => { await instance?.dispose(); await rm(directory, { recursive: true, force: true }); });
  await open();
  return {
    get db() { return db; },
    get store() { return store; },
    async reopen() { await instance.dispose(); await open(); },
    createUser(email = 'one@example.test') { return store.createUser({ email, name: 'Test worker', password }); },
  };
}

test('D1 accounts normalize email, retain password hashes and reject duplicates', async (t) => {
  const f = await fixture(t);
  const user = await f.createUser(' One@Example.Test ');
  assert.equal(user.email, 'one@example.test');
  assert.deepEqual(Object.keys(user).sort(), ['email', 'id', 'name']);
  const stored = await f.store.findUser('ONE@example.test');
  assert.match(stored.password_hash, /^scrypt:/);
  assert.ok(!stored.password_hash.includes(password));
  assert.equal(await verifyPassword(password, stored.password_hash), true);
  await assert.rejects(f.createUser('one@example.test'), /already exists/);
  await assert.rejects(f.store.createUser({ email: 'bad', name: 'Name', password }), /valid email/);
});

test('D1 invitation is consumed exactly once by concurrent registrations', async (t) => {
  const f = await fixture(t);
  const invitation = await f.store.createInvite();
  const attempts = await Promise.all(['one', 'two', 'three'].map((name) => f.store.register({
    email: `${name}@example.test`, name, password, inviteCode: invitation.code,
  })));
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.equal((await f.db.prepare('SELECT count(*) AS count FROM users').first()).count, 1);
  const stored = await f.db.prepare('SELECT code_hash, used_at FROM invites').first();
  assert.equal(stored.code_hash, digest(invitation.code));
  assert.ok(stored.used_at > 0);
  assert.equal(await f.store.validInvite(invitation.code, 'four@example.test'), false);
});

test('D1 competing registrations for one email leave the losing invitation unused', async (t) => {
  const f = await fixture(t);
  const codes = await Promise.all([f.store.createInvite(), f.store.createInvite()]);
  const attempts = await Promise.all(codes.map(({ code }) => f.store.register({
    email: 'same@example.test', name: 'Worker', password, inviteCode: code,
  })));
  assert.equal(attempts.filter(Boolean).length, 1);
  const losing = codes[attempts.findIndex((user) => !user)];
  assert.equal(await f.store.validInvite(losing.code, 'different@example.test'), true);
});

test('D1 invitations respect email binding and expiration without creating accounts', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now });
  const invite = await f.store.createInvite({ email: ' Intended@Example.Test ', ttlMs: 1000 });
  assert.equal(await f.store.validInvite(invite.code, 'other@example.test'), false);
  assert.equal(await f.store.validInvite(invite.code, 'intended@example.test'), true);
  assert.equal(await f.store.register({ email: 'other@example.test', name: 'Other', password, inviteCode: invite.code }), null);
  now += 1000;
  assert.equal(await f.store.register({ email: 'intended@example.test', name: 'Intended', password, inviteCode: invite.code }), null);
  assert.equal((await f.db.prepare('SELECT count(*) AS count FROM users').first()).count, 0);
});

test('D1 password reset between registration and session creation rejects the stale receipt', async (t) => {
  const f = await fixture(t);
  const invite = await f.store.createInvite({ email: 'new@example.test' });
  const receipt = await f.store.register({ email: 'new@example.test', name: 'New worker', password, inviteCode: invite.code });
  assert.ok(receipt);
  assert.deepEqual(Object.keys(receipt.user).sort(), ['email', 'id', 'name']);
  assert.equal(receipt.verifiedPasswordHash, (await f.store.findUser(receipt.user.email)).password_hash);
  await f.store.resetPassword(receipt.user.email, 'reset-during-signup-12345');
  assert.equal(await f.store.createSession(receipt.user.id, 60000, receipt.verifiedPasswordHash), null);
  assert.equal((await f.db.prepare('SELECT count(*) AS count FROM sessions').first()).count, 0);
});

test('D1 sessions expire, store only token hashes, and support explicit revocation', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now });
  const user = await f.createUser();
  const session = await f.store.createSession(user.id, 1000);
  assert.deepEqual(await f.store.session(session.token), { user, csrfToken: session.csrfToken });
  assert.equal((await f.db.prepare('SELECT token_hash FROM sessions').first()).token_hash, digest(session.token));
  now += 1000;
  assert.equal(await f.store.session(session.token), null);
  const next = await f.store.createSession(user.id, 1000);
  await f.store.revokeSession(next.token);
  assert.equal(await f.store.session(next.token), null);
});

test('D1 password reset and direct admin update revoke sessions atomically', async (t) => {
  const f = await fixture(t);
  const user = await f.createUser();
  const oldHash = (await f.store.findUser(user.email)).password_hash;
  const firstSession = await f.store.createSession(user.id, 60000, oldHash);
  const [, racingSession] = await Promise.all([
    f.store.resetPassword(user.email, 'replacement-password-12345'),
    f.store.createSession(user.id, 60000, oldHash),
  ]);
  assert.equal(await f.store.session(firstSession.token), null);
  if (racingSession) assert.equal(await f.store.session(racingSession.token), null);
  assert.equal(await f.store.createSession(user.id, 60000, oldHash), null);
  const currentHash = (await f.store.findUser(user.email)).password_hash;
  const currentSession = await f.store.createSession(user.id, 60000, currentHash);
  assert.ok(await f.store.session(currentSession.token));
  const adminHash = await hashPassword('admin-replacement-password-12345');
  await f.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(adminHash, user.id).run();
  assert.equal(await f.store.session(currentSession.token), null);
  assert.equal(await f.store.createSession(user.id, 60000, currentHash), null);
});

test('D1 workspaces stay isolated and simultaneous writes accept one matching revision', async (t) => {
  const f = await fixture(t);
  const one = await f.createUser();
  const two = await f.createUser('two@example.test');
  assert.deepEqual(await f.store.workspace(one.id), { workspace: null, revision: 0 });
  assert.equal(await f.store.saveWorkspace(one.id, empty(), 2), null);
  const updates = ['First tab', 'Second tab'].map((name) => ({
    ...empty(), projects: [{ id: 'p1', name, site: 'Site', manager: 'Manager' }],
  }));
  const results = await Promise.all(updates.map((workspace) => f.store.saveWorkspace(one.id, workspace, 0)));
  assert.deepEqual(results.filter((revision) => revision === 1), [1]);
  assert.equal(results.filter((revision) => revision === null).length, 1);
  assert.deepEqual(await f.store.workspace(one.id), { workspace: updates[results.findIndex((revision) => revision === 1)], revision: 1 });
  assert.deepEqual(await f.store.workspace(two.id), { workspace: null, revision: 0 });
  assert.equal(await f.store.saveWorkspace(one.id, empty(), 0), null);
  assert.equal(await f.store.saveWorkspace(one.id, empty(), 1), 2);
});

test('D1 enforces workspace UTF-8 byte limits in adapter and database', async (t) => {
  const f = await fixture(t);
  const user = await f.createUser();
  const oversized = { notes: '한'.repeat(Math.ceil(MAX_DOCUMENT_BYTES / 3)) };
  await assert.rejects(f.store.saveWorkspace(user.id, oversized, 0), (error) => error.status === 413 && error.code === 'WORKSPACE_TOO_LARGE');
  assert.deepEqual(await f.store.workspace(user.id), { workspace: null, revision: 0 });
  await assert.rejects(f.db.prepare('INSERT INTO workspaces VALUES (?, ?, 1, ?)')
    .bind(user.id, 'x'.repeat(MAX_DOCUMENT_BYTES + 1), Date.now()).run(), /CHECK constraint/);
});

test('D1 rate-limit admission is atomic, persists, and resets at the window boundary', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now });
  const results = await Promise.all(Array.from({ length: 12 }, () => f.store.consumeRateLimit('auth-ip:test', 3, 10000)));
  assert.equal(results.filter((retry) => retry === 0).length, 3);
  assert.equal(results.filter((retry) => retry === 10).length, 9);
  const row = await f.db.prepare('SELECT * FROM rate_limits').first();
  assert.equal(row.attempts, 3);
  assert.equal(row.key_hash, digest('auth-ip:test'));
  await f.reopen();
  assert.equal(await f.store.consumeRateLimit('auth-ip:test', 3, 10000), 10);
  now += 10000;
  assert.equal(await f.store.consumeRateLimit('auth-ip:test', 3, 10000), 0);
});

test('D1 cleanup uses indexed expiration fields and bounded deletion batches', async (t) => {
  const now = Date.now();
  const f = await fixture(t, { now: () => now });
  for (let offset = 0; offset < 150; offset += 25) {
    await f.db.batch(Array.from({ length: 25 }, (_, index) => f.db.prepare('INSERT INTO rate_limits VALUES (?, 1, ?)')
      .bind(`old-${offset + index}`, now - 20000)));
  }
  await f.store.consumeRateLimit('new', 3, 10000);
  assert.equal((await f.db.prepare('SELECT count(*) AS count FROM rate_limits').first()).count, 51);
  const plan = await f.db.prepare('EXPLAIN QUERY PLAN SELECT key_hash FROM rate_limits WHERE started_at <= ? ORDER BY started_at LIMIT 100').bind(now - 10000).all();
  assert.ok(plan.results.some((row) => row.detail.includes('rate_limits_expiry')));
});

test('D1 records and sessions survive a complete Miniflare restart', async (t) => {
  const f = await fixture(t);
  const user = await f.createUser();
  const session = await f.store.createSession(user.id, 60000);
  await f.store.saveWorkspace(user.id, empty(), 0);
  await f.reopen();
  assert.deepEqual(f.store.publicUser(await f.store.findUser(user.email)), user);
  assert.deepEqual(await f.store.session(session.token), { user, csrfToken: session.csrfToken });
  assert.deepEqual(await f.store.workspace(user.id), { workspace: empty(), revision: 1 });
});
