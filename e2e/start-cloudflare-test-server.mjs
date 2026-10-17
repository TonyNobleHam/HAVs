import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createD1Store } from '../cloudflare/store.mjs';

const fixtureFile = process.env.HAVS_E2E_FIXTURE_FILE;
const workerConfig = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
if (!fixtureFile) throw new Error('Run this fixture server through playwright.cloudflare.config.ts.');

// Everything here is local and disposable; no Cloudflare account or remote D1.
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'havs-cloudflare-browser-'));
let runtime;
let cleanupPromise;
function cleanup() {
  cleanupPromise ??= (async () => {
    let timer;
    try {
      // Playwright signals the whole process group, including workerd. Keep Node
      // alive briefly if Miniflare's disposal awaits an already-stopped child.
      await Promise.race([
        runtime?.dispose(),
        new Promise((resolve) => { timer = setTimeout(resolve, 2_000); }),
      ]);
    } catch {
      // Local test files still need removal after a failed runtime shutdown.
    } finally {
      clearTimeout(timer);
      await rm(temporaryDirectory, { recursive: true, force: true });
      await rm(fixtureFile, { force: true });
    }
  })();
  return cleanupPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await cleanup();
    process.exit(0);
  });
}

try {
  const workerPath = join(temporaryDirectory, 'worker.mjs');
  await build({
    entryPoints: [resolve('cloudflare/worker.mjs')],
    outfile: workerPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    external: ['node:*'],
    logLevel: 'silent',
  });
  runtime = new Miniflare(convertV4MiniflareOptions({
    name: `havs-cloudflare-browser-${randomUUID()}`,
    modules: true,
    scriptPath: workerPath,
    rootPath: temporaryDirectory,
    host: '127.0.0.1',
    port: 8788,
    compatibilityDate: workerConfig.compatibility_date,
    compatibilityFlags: workerConfig.compatibility_flags,
    bindings: {
      APP_ORIGIN: 'http://127.0.0.1:8788',
      HAVS_ENV: 'development',
    },
    d1Databases: { DB: randomUUID() },
    assets: {
      directory: resolve('dist'),
      binding: 'ASSETS',
      run_worker_first: workerConfig.assets.run_worker_first,
      routerConfig: { has_user_worker: true },
      assetConfig: { not_found_handling: 'single-page-application' },
    },
    resourcePersistencePath: join(temporaryDirectory, 'state'),
    resourceTmpPath: join(temporaryDirectory, 'runtime'),
    unsafeDevRegistryPath: join(temporaryDirectory, 'registry'),
    unsafeRegisterWorker: false,
    cf: false,
    logRequests: false,
  }));
  await runtime.ready;
  const db = await runtime.getD1Database('DB');
  const migration = await readFile(resolve('cloudflare/migrations/0001_initial.sql'), 'utf8');
  // D1 exec splits on newlines. Preserve the trigger's internal statement by
  // splitting this initial migration only before another CREATE or file end.
  const statements = migration.replace(/^\s*--.*$/gm, '').trim()
    .split(/;\s*(?=CREATE\b|$)/).map((sql) => sql.trim()).filter(Boolean);
  await db.batch(statements.map((sql) => db.prepare(sql)));
  const store = createD1Store(db);
  const fixtures = { accounts: {}, invitation: null, runtimeDirectory: temporaryDirectory };
  for (const key of ['login', 'persistence', 'other', 'import', 'conflict', 'expired', 'switched-from', 'switched-to']) {
    const account = {
      email: `${key}@havs-browser.test`,
      name: `브라우저 검증 ${key}`,
      password: randomBytes(24).toString('base64url'),
    };
    await store.createUser(account);
    fixtures.accounts[key] = account;
  }
  const email = 'invited@havs-browser.test';
  fixtures.invitation = {
    ...await store.createInvite({ email }),
    email,
    name: '초대 검증 사용자',
    password: randomBytes(24).toString('base64url'),
  };
  await writeFile(fixtureFile, JSON.stringify(fixtures), { mode: 0o600 });
  const health = await fetch('http://127.0.0.1:8788/api/health');
  const document = await fetch('http://127.0.0.1:8788/');
  if (health.status !== 200 || document.status !== 200 || !document.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`Cloudflare fixture startup failed: health=${health.status}, page=${document.status}.`);
  }
  console.log('HAVS Cloudflare browser fixtures ready');
} catch (error) {
  await cleanup();
  throw error;
}
