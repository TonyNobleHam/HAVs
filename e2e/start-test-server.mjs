import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.mjs';

const fixtureFile = process.env.HAVS_E2E_FIXTURE_FILE;
if (!fixtureFile) throw new Error('Run this fixture server through playwright.server.config.ts.');

// Ephemeral test-only database and credentials, removed on graceful shutdown.
const dataDir = await mkdtemp(join(tmpdir(), 'havs-browser-db-'));
const app = createApp({
  dataDir,
  origin: 'http://127.0.0.1:5174',
  production: false,
  authIpLimit: 200,
});
const fixtures = { accounts: {}, invitation: null };

async function cleanup() {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(fixtureFile, { force: true });
}

try {
  for (const key of ['login', 'persistence', 'other', 'import', 'conflict', 'expired', 'switched-from', 'switched-to']) {
    const account = {
      email: `${key}@havs-browser.test`,
      name: `브라우저 검증 ${key}`,
      password: randomBytes(24).toString('base64url'),
    };
    await app.store.createUser(account);
    fixtures.accounts[key] = account;
  }
  const email = 'invited@havs-browser.test';
  fixtures.invitation = {
    ...app.store.createInvite({ email }),
    email,
    name: '초대 검증 사용자',
    password: randomBytes(24).toString('base64url'),
  };
  await writeFile(fixtureFile, JSON.stringify(fixtures), { mode: 0o600 });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(3002, '127.0.0.1', resolve);
  });
} catch (error) {
  await cleanup();
  throw error;
}

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await cleanup();
    process.exit(0);
  });
}
