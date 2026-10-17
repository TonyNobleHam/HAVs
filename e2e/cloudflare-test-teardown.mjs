import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

// The test runner owns this final cleanup too: process-group shutdown can stop
// the fixture process before its asynchronous signal handler completes.
export default async function cleanupCloudflareBrowserFixtures() {
  const path = process.env.HAVS_E2E_FIXTURE_FILE;
  if (!path) return;
  let fixtures;
  try { fixtures = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const directory = fixtures.runtimeDirectory;
  if (typeof directory !== 'string' || dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('havs-cloudflare-browser-')) {
    throw new Error('Cloudflare test cleanup refused an unexpected fixture directory.');
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(path, { force: true });
}
