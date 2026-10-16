# HAVS 서버 운영과 배포

이 구성은 **도메인과 Linux 서버를 보유한 경우** 사용할 수 있는 단일 서버 배포입니다. Docker Compose가 HAVS와 Caddy를 실행하며 Caddy가 HTTPS 인증서를 발급·갱신합니다. 현재 작업 공간에 이 구성을 추가했다고 공개 사이트가 배포되는 것은 아닙니다. 실제 도메인, 서버 접속 권한, DNS 설정이 필요합니다. 유료 자원은 자동으로 생성하지 않습니다.

## 로컬에서 먼저 확인

Node.js 24와 npm이 필요합니다. Node 내장 SQLite를 사용하므로 별도 DB 서버나 API 키가 필요하지 않습니다.

```bash
npm ci
npm run dev:full
```

`http://localhost:5173`에 접속합니다. 개발 모드의 기본 허용 출처가 이 주소이므로 `127.0.0.1:5173`으로 접속하려면 실행할 때 `APP_ORIGIN=http://127.0.0.1:5173 npm run dev:full`을 지정합니다. 원격 개발 환경의 포트 미리보기 URL을 사용하는 경우에도 `APP_ORIGIN`을 실제 브라우저 주소의 출처(프로토콜 + 호스트 + 포트)로 설정해야 합니다. 경로와 끝의 `/`는 넣지 않습니다. HTTPS를 지정하면 쿠키도 HTTPS 전용이 됩니다.

다른 터미널에서 첫 계정을 생성합니다. 이메일과 이름을 본인 것으로 바꿉니다.

```bash
npm run admin -- create-user --email owner@example.com --name '운영자'
```

비밀번호는 화면에 표시되지 않는 터미널 입력을 사용하며 12–128자여야 합니다. 비밀번호를 명령행 인수, Git 파일, 대화창에 넣지 않습니다. 자동화가 필요한 경우에만 CLI의 `--password-stdin`을 이용해 비밀 관리 도구의 표준 출력을 연결합니다.

로그인하면 계정 전용 작업 공간을 선택합니다. **빈 작업 공간으로 시작**은 실제 데이터용이고 **예시 데이터로 시작**은 계산·화면 점검용입니다. 이전 버전에서 사용한 브라우저 기록이 있으면 **이 브라우저의 데이터 가져오기**로 명시적으로 옮깁니다. 원래 브라우저 기록은 지우지 않습니다. 서버 계정마다 작업 공간이 분리되어 있으며 같은 계정으로 로그인한 다른 기기에서 기록을 확인할 수 있습니다. 조직 공동 편집과 역할별 권한은 제공하지 않습니다.

계정 없이 **예시로 둘러보기**를 선택하거나 `?demo=1`로 접속하면 브라우저 저장 모드입니다. 이 데이터는 서버에 동기화되지 않습니다. `npm run dev`는 프런트엔드만 시작하므로 서버 로그인이 필요하면 `dev:full`을 사용합니다.

## 서버 준비

- Docker Engine과 Compose 플러그인이 설치된 Linux 서버를 사용합니다. 작은 시범 운영은 2 vCPU / RAM 2 GB 이상을 권장하며 실제 데이터량에 따라 조정합니다.
- 사용할 도메인의 DNS A 레코드를 서버 공인 IPv4로 설정합니다. AAAA 레코드가 있으면 해당 IPv6 주소로도 접근 가능해야 합니다.
- 인바운드 80/TCP와 443/TCP를 허용합니다. HTTP/3을 사용할 경우 443/UDP도 허용합니다. 앱의 3001 포트는 외부에 공개하지 않습니다.
- 서버에서 GitHub, npm, Docker Hub, 인증서 발급 기관에 접근할 수 있어야 합니다. 저장소가 비공개라면 기존 GitHub 인증 방식으로 읽기 권한을 준비합니다.
- 같은 서버의 80/443 포트를 다른 웹 서버가 사용한다면 기존 프록시에 통합하거나 포트를 정리한 후 진행합니다.

## GitHub에 보관하고 배포할 코드 선택

개발 변경은 작업 브랜치의 PR로 검토하고 `main`에 병합한 뒤 서버에서 해당 커밋을 체크아웃합니다. 이 저장소의 개발 브랜치 이름과 실제 PR 상태는 `git status`, GitHub에서 확인합니다. 비밀번호·DB·`.env` 파일은 커밋하지 않습니다.

```bash
git clone https://github.com/TonyNobleHam/HAVs.git
cd HAVs
git checkout main
git pull --ff-only
```

작업 공간은 이미 격리되어 있으므로 Codex 작업 시 별도 Git worktree를 만들 필요는 없습니다. 서버에는 GitHub에 실제로 올라간 배포 대상 커밋이 있어야 합니다.

## HTTPS 배포

```bash
cp deploy/.env.example .env
```

`.env`의 `HAVS_DOMAIN=havs.example.com`을 **소유한 실제 도메인**으로 바꿉니다. `https://`, 경로, 포트는 넣지 않습니다. 예제 도메인 그대로 공개 배포를 실행하지 않습니다.

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app caddy
```

앱 상태가 `healthy`이고 Caddy의 인증서 발급이 완료되면 `https://설정한-도메인`에 접속합니다. `/api/health`는 상태 확인용이며 로그인 성공이나 데이터 정확성을 보장하는 검사는 아닙니다. Docker 이미지는 정적 화면과 Node 서버를 함께 포함합니다. 별도 `npm run dev`나 Vite 서버를 운영 환경에서 실행하지 않습니다.

첫 계정을 배포 서버에 생성합니다. 로컬 개발 계정은 자동으로 복사되지 않습니다.

```bash
docker compose exec app node server/manage.mjs create-user \
  --email owner@example.com --name '운영자'
```

추가 사용자에게는 특정 이메일에 연결된 초대 코드를 발급합니다. 초대 코드 전달은 운영자가 직접 수행하며 자동 이메일은 발송하지 않습니다.

```bash
docker compose exec app node server/manage.mjs create-invite \
  --email colleague@example.com
```

초대는 발급 후 7일 동안 한 번만 사용할 수 있습니다. 사용자는 **초대로 가입** 화면에서 코드와 해당 이메일을 입력합니다. 공개 회원가입은 허용하지 않습니다. 초대 코드는 로그나 공개 문서에 올리지 않습니다.

비밀번호를 잊은 사용자는 서버 운영자가 재설정합니다. 기존 로그인 세션은 폐기됩니다.

```bash
docker compose exec app node server/manage.mjs reset-password \
  --email owner@example.com
```

## 데이터와 환경 변수

| 항목 | 기본값 / 역할 |
| --- | --- |
| `APP_ORIGIN` | 개발 기본 `http://localhost:5173`; 운영에서는 정확한 HTTPS 출처 필수. Compose가 도메인으로 생성 |
| `NODE_ENV` | Compose는 `production`; 보안 쿠키와 HTTPS 출처 검사 사용 |
| `HOST` | 직접 실행 시 `127.0.0.1`; 컨테이너에서는 `0.0.0.0` |
| `PORT` | `3001` |
| `HAVS_DATA_DIR` | 직접 실행 시 `./data`; Compose는 `/app/data` |
| `VITE_API_TARGET` | Vite 개발 프록시의 API 주소; `dev:full`에서는 `PORT`에 맞춰 설정. 별도 API 서버를 사용할 때만 지정 |

`havs_data` Docker 볼륨에 계정, 비밀번호 해시, 세션, 초대, 계정별 기록을 저장합니다. 앱은 비루트 사용자로 실행되며 데이터 볼륨 외 파일 시스템은 읽기 전용입니다. `docker compose down`은 볼륨을 유지하지만 **`docker compose down -v`는 기록을 삭제하므로 운영 서버에서 사용하지 않습니다.** `caddy_data`와 `caddy_config`는 인증서와 Caddy 설정을 보관합니다.

세션은 12시간 유지되며 HttpOnly 쿠키를 사용합니다. 변경 요청에는 출처 검사와 CSRF 검사가 적용됩니다. 비밀번호는 scrypt 해시로 저장합니다. 로그인·가입에는 이메일별 15분당 10회, 연결 IP별 15분당 30회 제한이 적용됩니다. Caddy 뒤에서는 연결 IP가 공유되므로 작은 시범 운영을 넘어갈 경우 신뢰할 수 있는 프록시의 사용자별 요청 제한과 서버 설정을 함께 검토해야 합니다. 전달 헤더의 IP를 무조건 신뢰하지 않습니다.

동시에 같은 계정을 편집하면 버전 충돌을 표시합니다. 다른 기기의 내용을 자동 덮어쓰지 않습니다. 먼저 현재 화면의 JSON 백업을 보관한 후 **서버 기록 다시 불러오기**를 선택해 합칠 내용을 검토합니다. 네트워크 장애 중 편집 내용은 현재 메모리에만 남을 수 있으므로 저장 실패 상태에서 탭을 닫기 전 JSON으로 내보냅니다.

## 전체 서버 백업

앱의 JSON 내보내기는 해당 작업 공간만 보관합니다. 계정까지 복구하려면 아래 SQLite 전체 백업을 별도로 보관합니다. CLI는 SQLite 온라인 백업 API를 사용하므로 앱 실행 중에도 일관된 스냅샷을 생성합니다. 실행 중인 원본 `.sqlite` 파일만 단순 복사하지 않습니다.

```bash
mkdir -p backups
chmod 700 backups
backup_name="havs-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
docker compose exec -T app node server/manage.mjs backup \
  --output "/app/data/$backup_name"
docker compose cp "app:/app/data/$backup_name" "backups/$backup_name"
chmod 600 "backups/$backup_name"
```

백업은 사용자 기록과 인증 정보를 포함합니다. 접근을 제한하고 서버 밖의 보호된 위치에도 복사합니다. 자동 외부 백업·보관 주기 설정은 포함되어 있지 않습니다. 볼륨 안에 남은 스냅샷도 백업 정책에 따라 정리해야 합니다. 보존된 파일의 복구 가능성을 정기적으로 확인합니다.

## 전체 서버 복구

복구는 모든 계정의 기록을 백업 시점으로 되돌립니다. 현재 상태도 먼저 위 방법으로 백업합니다. 아래 `backup_path`는 복구할 실제 파일로 바꾸고, 같은 데이터 볼륨을 사용하는 **모든 API 프로세스를 중지**한 뒤 실행합니다.

```bash
backup_path=backups/havs-YYYYMMDDTHHMMSSZ.sqlite
test -s "$backup_path"
docker compose stop app
docker compose run --rm --no-deps -T app \
  node scripts/restore.mjs --stdin --confirm-offline < "$backup_path"
docker compose up -d app
docker compose ps
```

각 명령이 성공했는지 확인하고 다음 명령을 실행합니다. `--confirm-offline`은 운영자가 API 중지를 확인했다는 뜻이며 자동으로 다른 서버를 중지하는 기능이 아닙니다. 복구 스크립트는 SQLite 무결성과 HAVS 테이블을 확인한 뒤 교체하고, 이전 DB와 WAL 파일은 `data/before-restore-*` 디렉터리에 보관합니다. 복원한 세션은 폐기되므로 사용자는 다시 로그인합니다. 실패 시 오류를 확인하고 기존 서버를 재시작합니다. 계정별 공구·평가를 확인한 후에만 이전 파일의 정리 여부를 결정합니다.

Docker 없이 실행한 로컬 서버도 먼저 중지한 뒤 `node scripts/restore.mjs --source /path/to/backup.sqlite --confirm-offline`로 복구할 수 있습니다. `HAVS_DATA_DIR`은 서버와 동일하게 지정합니다. 가동 중인 DB 파일에 이 명령을 실행하지 않습니다.

## 업데이트와 오류 확인

업데이트 전에 전체 서버 백업을 만들고 배포할 커밋을 기록합니다. 이후 코드를 업데이트하고 이미지를 다시 빌드합니다. 기존 `havs_data` 볼륨이 유지되면 기록도 유지됩니다.

```bash
git pull --ff-only
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app caddy
```

- `APP_ORIGIN` 오류 또는 로그인 403: 브라우저 주소와 `APP_ORIGIN`의 프로토콜·호스트·포트를 비교합니다. 끝의 `/`는 넣지 않습니다.
- HTTPS 인증서 오류: DNS A/AAAA, 서버 방화벽 80/443, Caddy 로그를 확인합니다. 인증서 검증을 끄지 않습니다.
- 로그인 429: 요청 제한의 대기 시간이 지난 후 다시 시도합니다. 서버를 재시작해도 제한 기록은 유지됩니다.
- SQLite 열기 실패: 데이터 디렉터리와 볼륨의 소유권, 디스크 용량을 확인합니다. 컨테이너의 `node` 사용자가 쓸 수 있어야 합니다.
- 구형 정적 호스팅에서는 서버 저장이 동작하지 않습니다. 계정 기능은 이 Node 서버와 지속 데이터 볼륨을 함께 운영해야 합니다.

### HTTPS 프록시가 있는 빌드 환경

일부 클라우드 작업 공간은 컨테이너 기본 네트워크에서 DNS가 되지 않고, 호스트에 제공된 프록시와 신뢰 인증서를 사용해야 합니다. 이 경우에만 플랫폼이 제공한 기존 `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` 설정을 이용합니다.

```bash
havs_proxy_host="$(node -e 'process.stdout.write(new URL(process.env.HTTPS_PROXY).hostname)')"
havs_proxy_ip="$(node --input-type=module -e 'import {lookup} from "node:dns/promises"; process.stdout.write((await lookup(new URL(process.env.HTTPS_PROXY).hostname, {family: 4})).address)')"
docker build --network=host \
  --add-host "$havs_proxy_host:$havs_proxy_ip" \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --secret id=npm_ca,src="$NODE_EXTRA_CA_CERTS" \
  --tag havs-workspace:local .
docker compose up -d --no-build
```

호스트가 이미 해석한 프록시 주소를 BuildKit에도 전달하며, 주소를 저장소에 하드코딩하지 않습니다. 추가 CA는 BuildKit secret으로 설치 단계에만 마운트하며 결과 이미지에 넣지 않습니다. 프록시 자격 증명을 Dockerfile이나 저장소에 작성하지 않습니다. TLS나 npm 잠금 파일의 무결성 검사는 계속 유지합니다. 일반적인 서버에서는 기본 `docker compose up -d --build`만 사용하면 됩니다.

## 실제 공구로 검증

제공된 공구·프로젝트·평가 값은 가상 예시입니다. 실제 데이터 검증은 대표 측정값을 제공받은 후 수행해야 합니다. 공구 1–2개에 대해 모델, 3축 주파수 가중 진동 합성값(m/s²), 해당 작업 조건, 소음 LAeq(dB(A)), 실제 트리거 시간(분), 측정 출처를 기록합니다.

계산 동작은 합성값으로도 교차 확인할 수 있습니다. 진동 5 m/s²를 120분 사용하면 A(8) = 2.5 m/s², 100점입니다. LAeq 85 dB(A)를 480분 기록하면 LEX,8h = 85 dB(A)입니다. 이는 실제 공구 측정 검증을 대신하지 않습니다. 소음값이 없는 작업이 포함되면 일일 소음 결과는 계산하지 않습니다.

운영 시작 전 PC와 휴대폰에서 같은 계정으로 공구·평가 저장, 재로그인, JSON 내보내기, 전체 DB 백업·복구를 확인합니다. HSE 참고 계산을 현지 법규 적합 판정으로 간주하지 않습니다. 조직 공유, MFA/SSO, 자동 메일, 상용 공구 데이터, 고가용성·자동 확장은 이 버전에 포함되지 않습니다.
