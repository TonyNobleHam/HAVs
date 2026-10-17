import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, HOSTNAME, wrangler, executeSQL, sqlString, flags } from '../scripts/cloudflare-common.mjs';
import { checkDomainOwnership } from '../scripts/cloudflare-deploy.mjs';
import { checkDeployment } from '../scripts/cloudflare-check.mjs';
import { digest, verifyPassword } from '../server/credentials.mjs';

test('remote flags are explicit and existing domain ownership is preserved', () => {
  assert.deepEqual(flags(['--remote'], [], ['remote']), { remote: true });
  assert.throws(() => flags(['--remote', '--remote'], [], ['remote']));
  assert.throws(() => flags(['--remote=true'], [], ['remote']));
  const target = { domains: [], dnsRecords: [], workerName: 'havs-workspace' };
  assert.equal(checkDomainOwnership(target), false);
  assert.throws(() => checkDomainOwnership({ ...target, dnsRecords: [{ type: 'CNAME' }] }), /DNS/);
  const domain = { hostname: HOSTNAME, service: target.workerName, environment: 'production' };
  assert.equal(checkDomainOwnership({ ...target, domains: [domain], dnsRecords: [{ type: 'AAAA' }] }), true);
  assert.throws(() => checkDomainOwnership({ ...target, domains: [{ ...domain, service: 'unrelated' }] }), /Worker/);
  assert.throws(() => checkDomainOwnership({ ...target, domains: [{ ...domain, hostname: 'other.example.com' }] }), /다른 도메인/);
});

test('public readiness probes reject cached APIs and password CPU failures', async () => {
  const requests = [];
  const healthy = () => Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  const result = await checkDeployment(async (url, init) => {
    requests.push({ url, init });
    return url.endsWith('/health') ? healthy() : Response.json({ code: 'LOGIN_FAILED' }, { status: 401 });
  });
  assert.equal(result.negativeLogin, true);
  assert.equal(requests.length, 2);
  const login = requests[1];
  assert.equal(login.init.headers.Origin, `https://${HOSTNAME}`);
  const body = JSON.parse(login.init.body);
  assert.match(body.email, /^havs-probe-[a-f0-9-]+@example\.invalid$/);
  assert.ok(body.password.length >= 12);
  await assert.rejects(checkDeployment(async () => Response.json({ ok: true }, { headers: { 'cache-control': 'no-store', 'cf-cache-status': 'HIT' } })), /캐시/);
  await assert.rejects(checkDeployment(async (url) => url.endsWith('/health') ? healthy() : new Response('Error 1102', { status: 500 })), /CPU/);
  await assert.rejects(checkDeployment(async (url) => url.endsWith('/health') ? healthy() : Response.json({ code: 'LOGIN_FAILED' })), /HTTP 200/);
});

test('local admin creates users/invites and resets passwords with atomic session revocation', { timeout: 180000 }, async () => {
  const persistence = await mkdtemp(join(tmpdir(), 'havs-admin-test-'));
  const query = async (sql) => (await executeSQL(sql, { persistTo: persistence })).flatMap((result) => result.results ?? []);
  const run = (args, password = '') => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts/cloudflare-admin.mjs'), ...args, '--local', '--persist-to', persistence], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(password);
  });
  try {
    await wrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistence]);
    const password = 'Disposable test password 827!';
    const create = await run(['create-user', '--email', 'OWNER@example.invalid', '--name', "O'Connor", '--password-stdin'], password);
    assert.equal(create.code, 0, create.stderr);
    const [user] = await query('SELECT id,email,name,password_hash FROM users;');
    assert.equal(user.email, 'owner@example.invalid');
    assert.equal(user.name, "O'Connor");
    assert.equal(await verifyPassword(password, user.password_hash), true);
    const duplicate = await run(['create-user', '--email', user.email, '--name', 'Duplicate', '--password-stdin'], password);
    assert.notEqual(duplicate.code, 0);
    assert.equal(duplicate.stderr.includes(user.password_hash), false);
    assert.equal(duplicate.stderr.includes(password), false);
    await query(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ('fixture-session',${sqlString(user.id)},${Date.now() + 100000});`);
    const changedPassword = 'Replacement test password 953!';
    const reset = await run(['reset-password', '--email', user.email, '--password-stdin'], changedPassword);
    assert.equal(reset.code, 0, reset.stderr);
    assert.equal((await query('SELECT token_hash FROM sessions;')).length, 0);
    const [updated] = await query('SELECT password_hash FROM users;');
    assert.equal(await verifyPassword(changedPassword, updated.password_hash), true);
    assert.equal(await verifyPassword(password, updated.password_hash), false);
    const invitation = await run(['create-invite', '--email', 'Invitee@example.invalid']);
    assert.equal(invitation.code, 0, invitation.stderr);
    const code = invitation.stdout.match(/초대 코드: ([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code);
    const [storedInvite] = await query('SELECT code_hash,email,expires_at,used_at FROM invites;');
    assert.equal(storedInvite.code_hash, digest(code));
    assert.equal(storedInvite.email, 'invitee@example.invalid');
    assert.equal(storedInvite.used_at, null);
    assert.ok(storedInvite.expires_at > Date.now() + 6 * 86400000);
    const missing = await run(['reset-password', '--email', 'absent@example.invalid', '--password-stdin'], changedPassword);
    assert.notEqual(missing.code, 0);
  } finally { await rm(persistence, { recursive: true, force: true }); }
});
