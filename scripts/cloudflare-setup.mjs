import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, REMOTE_CONFIG, STATE_FILE, HOSTNAME, flags, authenticated, wrangler, jsonOutput, readJSON, writeJSON, executeSQL } from './cloudflare-common.mjs';

const usage = `사용법: node scripts/cloudflare-setup.mjs --remote [--account-id ID] [--database-name NAME]
기존 D1을 이름으로 확인해 재사용하거나 새 D1을 만들고 마이그레이션을 적용합니다.
--remote 없이는 원격 리소스를 변경하지 않습니다. Cloudflare 로그인 또는 안전하게 연결된 API 토큰이 필요합니다.`;
const requiredColumns = {
  users: ['id', 'email', 'name', 'password_hash', 'created_at'],
  sessions: ['token_hash', 'user_id', 'expires_at'],
  invites: ['code_hash', 'email', 'expires_at', 'used_at'],
  workspaces: ['user_id', 'document', 'revision', 'updated_at'],
  rate_limits: ['key_hash', 'attempts', 'started_at'],
};
const rows = (result) => result.flatMap((item) => item.results ?? []);

export async function setup(args = process.argv.slice(2)) {
  const options = flags(args, ['account-id', 'database-name'], ['remote', 'help']);
  if (options.help) { console.log(usage); return; }
  if (!options.remote) throw new Error(usage);
  const accountId = await authenticated(options['account-id']);
  const base = await readJSON(join(ROOT, 'wrangler.jsonc'));
  const name = options['database-name'] ?? base.d1_databases[0].database_name;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('D1 이름에는 영문, 숫자, 하이픈, 밑줄만 사용할 수 있습니다.');
  const oldState = existsSync(STATE_FILE) ? await readJSON(STATE_FILE) : null;
  if (oldState && (oldState.accountId !== accountId || oldState.databaseName !== name || oldState.workerName !== base.name)) throw new Error('저장된 배포 대상과 계정/DB/Worker가 다릅니다. .cloudflare-deploy 설정을 먼저 검토하세요.');

  const list = async () => jsonOutput(await wrangler(['d1', 'list', '--json'], { accountId, label: 'D1 목록 확인' }));
  let databases = await list();
  if (!Array.isArray(databases)) throw new Error('D1 목록 형식을 확인할 수 없습니다. 원격 DB는 변경하지 않았습니다.');
  let matches = databases.filter((database) => database.name === name);
  if (matches.length > 1) throw new Error('같은 이름의 D1이 여러 개입니다. 원격 설정을 확인하세요.');
  if (!matches.length) {
    console.log('대상 이름의 D1이 없어 생성합니다. 요금제를 변경하지 않습니다.');
    await wrangler(['d1', 'create', name, '--update-config=false'], { accountId, label: 'D1 생성' });
    databases = await list(); matches = databases.filter((database) => database.name === name);
  } else console.log('기존 D1을 확인했습니다. 데이터는 초기화하지 않습니다.');
  if (matches.length !== 1 || !/^[a-f0-9-]{36}$/i.test(matches[0].uuid ?? '')) throw new Error('D1 연결 정보를 확인할 수 없습니다. 생성된 DB를 대시보드에서 확인하세요.');
  const databaseId = matches[0].uuid;
  if (oldState && oldState.databaseId !== databaseId) throw new Error('같은 이름의 D1 ID가 변경되었습니다. 기존 데이터와 연결을 먼저 확인하세요.');

  const config = {
    ...base, $schema: '../node_modules/wrangler/config-schema.json', main: '../cloudflare/worker.mjs', account_id: accountId,
    assets: { ...base.assets, directory: '../dist' },
    vars: { ...base.vars, APP_ORIGIN: `https://${HOSTNAME}`, HAVS_ENV: 'production' },
    d1_databases: [{ binding: 'DB', database_name: name, database_id: databaseId, migrations_dir: '../cloudflare/migrations' }],
  };
  // Custom domains are attached separately with conflict protection; never hand
  // them to noninteractive Wrangler, which may replace an existing DNS record.
  delete config.routes; delete config.dev;
  await writeJSON(REMOTE_CONFIG, config);

  const tables = rows(await executeSQL("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';", { remote: true, accountId }));
  const unknown = tables.filter((table) => !(table.name in requiredColumns) && table.name !== 'd1_migrations');
  if (unknown.length) throw new Error('대상 D1에 HAVS와 다른 테이블이 있습니다. 마이그레이션을 중단했습니다. 다른 D1 이름을 사용하거나 소유권을 확인하세요.');
  for (const table of tables) {
    if (!(table.name in requiredColumns)) continue;
    const columns = rows(await executeSQL(`PRAGMA table_info(${table.name});`, { remote: true, accountId })).map((column) => column.name);
    if (requiredColumns[table.name].some((column) => !columns.includes(column))) throw new Error('기존 D1 테이블 구조가 HAVS와 다릅니다. 원격 데이터를 변경하지 않습니다.');
  }
  await wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', REMOTE_CONFIG], { accountId, label: 'D1 마이그레이션' });
  await writeJSON(STATE_FILE, { ...oldState, accountId, databaseId, databaseName: name, workerName: base.name });
  console.log('D1 연결과 마이그레이션을 완료했습니다. 실제 연결 설정은 .cloudflare-deploy/에만 저장했습니다.');
  console.log('첫 계정을 만들고 node scripts/cloudflare-deploy.mjs --remote를 실행하세요. 아직 사이트를 게시하지 않았습니다.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) setup().catch((error) => { console.error(error.message); process.exitCode = 1; });
