import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { HOSTNAME, configureProxy, flags } from './cloudflare-common.mjs';

export async function checkDeployment(fetcher = fetch) {
  const origin = `https://${HOSTNAME}`;
  let health;
  try {
    health = await fetcher(`${origin}/api/health`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  } catch { throw new Error('공개 HTTPS 접속을 확인할 수 없습니다. DNS/인증서 적용과 네트워크 연결을 확인하세요.'); }
  const status = await health.json().catch(() => null);
  if (!health.ok || status?.ok !== true || !/no-store/i.test(health.headers.get('cache-control') ?? '') || health.headers.get('cf-cache-status')?.toUpperCase() === 'HIT') throw new Error('공개 API 상태 또는 캐시 제외 설정을 확인하지 못했습니다. 운영 준비 완료로 표시하지 않습니다.');
  let login;
  try {
    login = await fetcher(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ email: `havs-probe-${randomUUID()}@example.invalid`, password: randomBytes(24).toString('base64url') }),
      signal: AbortSignal.timeout(15000), redirect: 'error',
    });
  } catch { throw new Error('공개 로그인 경로를 검증하지 못했습니다. 계정은 만들지 않았습니다.'); }
  const result = await login.json().catch(() => null);
  if (login.status !== 401 || result?.code !== 'LOGIN_FAILED') throw new Error(`공개 로그인 연산 검증 실패 (HTTP ${login.status}). Worker 로그/CPU 제한을 확인하세요. 요금제를 자동 변경하지 않습니다.`);
  return { origin, health: true, negativeLogin: true };
}

async function main() {
  const options = flags(process.argv.slice(2), [], ['remote', 'help']);
  if (options.help) { console.log('사용법: node scripts/cloudflare-check.mjs --remote\n공개 HTTPS/API 캐시 제외와 존재하지 않는 테스트 이메일의 로그인 거절을 확인합니다. 계정은 생성하지 않습니다.'); return; }
  if (!options.remote) throw new Error('공개 사이트 검증에는 --remote를 명시하세요.');
  configureProxy();
  await checkDeployment();
  console.log('공개 HTTPS, API 캐시 제외, 실제 로그인 연산/거절을 확인했습니다. 실제 계정 로그인·저장과 Cloudflare 사용량 지표도 확인하세요.');
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
