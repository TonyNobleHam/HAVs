import { pathToFileURL } from 'node:url';
import { flags, authenticated, apiClient, remoteConfig, readJSON, writeJSON, STATE_FILE, REMOTE_CONFIG, HOSTNAME, ZONE_NAME, wrangler, buildFrontend } from './cloudflare-common.mjs';
import { checkDeployment } from './cloudflare-check.mjs';

const usage = `사용법: node scripts/cloudflare-deploy.mjs --remote
먼저 cloudflare-setup으로 D1을 연결하세요. 인증과 DNS 소유권 확인 후 HAVS를 배포합니다.
기존 DNS/다른 Worker가 havs.oehnps.co.uk를 사용하면 덮어쓰지 않고 중단합니다.
요금제 변경이나 임시 workers.dev 주소를 생성하지 않습니다.`;

export function checkDomainOwnership({ domains, dnsRecords, workerName }) {
  const matches = domains.filter((domain) => domain.hostname === HOSTNAME);
  const owned = matches.length === 1 && matches[0].service === workerName && matches[0].environment === 'production';
  if (matches.length && !owned) throw new Error(`${HOSTNAME}가 다른 Worker에 연결되어 있습니다. 기존 연결을 변경하지 않았습니다. Cloudflare에서 용도를 먼저 확인하세요.`);
  if (dnsRecords.length && !owned) throw new Error(`${HOSTNAME}에 기존 DNS 레코드가 있습니다. 자동으로 교체하지 않습니다. Cloudflare DNS에서 해당 레코드의 용도를 확인한 뒤 연결 방식을 결정하세요.`);
  if (domains.some((domain) => domain.service === workerName && domain.environment === 'production' && domain.hostname !== HOSTNAME)) throw new Error('같은 Worker에 다른 도메인이 연결되어 있습니다. 기존 도메인을 보존하기 위해 자동 배포를 중단했습니다.');
  return owned;
}

export async function deploy(args = process.argv.slice(2)) {
  const options = flags(args, [], ['remote', 'help']);
  if (options.help) { console.log(usage); return; }
  if (!options.remote) throw new Error(usage);
  const config = await remoteConfig();
  const state = await readJSON(STATE_FILE);
  if (state.accountId !== config.account_id || state.workerName !== config.name || state.databaseId !== config.d1_databases[0].database_id) throw new Error('배포 상태와 연결 설정이 다릅니다. cloudflare-setup을 확인하세요.');
  if (config.vars?.APP_ORIGIN !== `https://${HOSTNAME}` || config.vars?.HAVS_ENV !== 'production' || config.workers_dev !== false || config.preview_urls !== false || config.routes) throw new Error('운영 출처 또는 공개 경로 설정이 예상과 다릅니다. 생성된 배포 설정을 검토하세요.');
  const accountId = await authenticated(config.account_id);
  const api = await apiClient();
  const zones = (await api(`/zones?name=${ZONE_NAME}&account.id=${accountId}&per_page=50`)).result;
  if (!Array.isArray(zones) || zones.length !== 1 || zones[0].status !== 'active') throw new Error('같은 Cloudflare 계정에서 활성 oehnps.co.uk 영역을 확인할 수 없습니다. 도메인 연결과 계정 권한을 확인하세요.');
  const zoneId = zones[0].id;
  const domainState = async () => {
    const [domainResult, dnsResult] = await Promise.all([
      api(`/accounts/${accountId}/workers/domains`),
      api(`/zones/${zoneId}/dns_records?name=${HOSTNAME}&per_page=100`),
    ]);
    if (!Array.isArray(domainResult.result) || !Array.isArray(dnsResult.result)) throw new Error('도메인/DNS 상태를 확인할 수 없습니다. 변경하지 않았습니다.');
    if (domainResult.result_info?.total_count > domainResult.result.length) throw new Error('모든 기존 도메인을 조회하지 못했습니다. 자동 변경을 중단했습니다.');
    return { domains: domainResult.result, dnsRecords: dnsResult.result, workerName: config.name };
  };
  const owned = checkDomainOwnership(await domainState());
  const existing = await api(`/accounts/${accountId}/workers/scripts/${config.name}/settings`, { allowNotFound: true });
  if (!existing.notFound && !state.workerDeployed && !owned) throw new Error('같은 이름의 기존 Worker를 발견했습니다. 새 프로젝트로 덮어쓰지 않습니다. 기존 배포 설정/소유권을 확인하세요.');

  await buildFrontend();
  await wrangler(['deploy', '--config', REMOTE_CONFIG, '--strict'], { accountId, label: 'Worker 배포', timeout: 300000 });
  await writeJSON(STATE_FILE, { ...state, workerDeployed: true });
  if (!checkDomainOwnership(await domainState())) {
    // These flags stay false even if DNS changes between inspection and attach.
    // Noninteractive Wrangler custom-domain deployment would turn them on.
    // This endpoint replaces this dedicated Worker's complete domain scope.
    // Do not attach other domains concurrently with the first HAVS deployment.
    await api(`/accounts/${accountId}/workers/scripts/${config.name}/domains/records`, {
      method: 'PUT', body: {
        override_scope: true, override_existing_origin: false, override_existing_dns_record: false,
        origins: [{ hostname: HOSTNAME, zone_id: zoneId, enabled: true, previews_enabled: false }],
      },
    });
  }
  await writeJSON(STATE_FILE, { ...state, workerDeployed: true, domainConnected: true });
  console.log(`Worker와 도메인 연결을 저장했습니다: https://${HOSTNAME}`);
  await checkDeployment();
  console.log('공개 HTTPS/API와 실제 로그인 연산의 거절 응답을 확인했습니다. 실제 계정 로그인·저장과 Cloudflare 사용량 지표도 확인하세요.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) deploy().catch((error) => { console.error(error.message); process.exitCode = 1; });
