import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ROOT, flags, wrangler, buildFrontend, localWranglerEnvironment } from './cloudflare-common.mjs';

async function main() {
  const options = flags(process.argv.slice(2), ['persist-to'], ['help']);
  if (options.help) { console.log('사용법: node scripts/cloudflare-dev.mjs [--persist-to PATH]\n화면 빌드 → 로컬 D1 마이그레이션 → http://localhost:8787 개발 서버. Cloudflare 계정 없이 사용할 수 있습니다.'); return; }
  await buildFrontend();
  const persistence = options['persist-to'] ? ['--persist-to', resolve(options['persist-to'])] : [];
  await wrangler(['d1', 'migrations', 'apply', 'DB', '--local', ...persistence], { label: '로컬 D1 마이그레이션' });
  const logDirectory = join(ROOT, '.wrangler', 'logs');
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const localEnvironment = await localWranglerEnvironment();
  const child = spawn(process.execPath, [join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--ip', '127.0.0.1', '--port', '8787', ...persistence], {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, ...localEnvironment, WRANGLER_SEND_METRICS: 'false', WRANGLER_NO_SKILLS_UPDATE_PROMPTS: 'true', WRANGLER_REGISTRY_PATH: process.env.WRANGLER_REGISTRY_PATH ?? join(ROOT, '.wrangler', 'registry'), CLOUDFLARE_CF_FETCH_ENABLED: 'false', WRANGLER_LOG_PATH: join(logDirectory, 'dev.log') },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.once('error', () => { console.error('Wrangler 개발 서버를 시작할 수 없습니다.'); process.exitCode = 1; });
  child.once('close', (code) => { process.exitCode = code ?? 0; });
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
