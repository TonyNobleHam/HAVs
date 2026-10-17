# Cloudflare에 HAVS 배포

목표 주소는 **https://havs.oehnps.co.uk**입니다. Cloudflare Workers가 로그인/API를 실행하고 D1이 계정과 기록을 보관합니다. 화면은 Workers 정적 자산으로 제공합니다. 개인 PC나 별도 서버를 계속 켜 둘 필요는 없습니다. 기존 Node/SQLite 앱을 Pages에 그대로 올리는 구성은 아닙니다.

저장소에 배포 준비가 되어 있다는 것과 공개 사이트가 실제로 배포되었다는 것은 다릅니다. 아래 절차에는 해당 Cloudflare 계정의 권한이 필요합니다. 현재 저장소에는 실제 계정 ID, D1 ID, API 토큰이나 기본 사용자 계정이 들어 있지 않습니다.

## 먼저 로컬에서 확인

최신 Node.js 24를 설치하고 저장소에서 실행합니다.

```bash
npm ci
npm run cf:dev
```

화면 빌드와 **로컬 D1** 마이그레이션 후 `http://localhost:8787`이 열립니다. Cloudflare 계정 없이 사용할 수 있습니다. 원격 D1을 만들거나 수정하지 않습니다. 개발 데이터는 무시되는 `.wrangler/state/`에 저장됩니다.

로컬 실행과 dry-run은 Wrangler의 개발 메타데이터를 `.wrangler/local-config/`에 격리합니다. 홈 디렉터리가 읽기 전용인 클라우드에서도 실행할 수 있으며, 실제 로그인·원격 명령에 사용하는 기존 OAuth 설정은 변경하지 않습니다.

다른 터미널에서 로컬 계정을 만듭니다. 이메일과 이름은 본인 것으로 바꿉니다. 비밀번호는 12–128자이며 화면에 표시되지 않는 프롬프트에 입력합니다.

```bash
npm run cf:admin -- create-user --local --email owner@example.com --name '운영자'
```

이 계정은 로컬 D1에만 존재합니다. 실제 사이트에는 아래 원격 계정을 따로 만듭니다. 기존 `npm run dev:full`은 Node/SQLite 개발 방식이며, `cf:dev`의 D1과 데이터가 서로 다릅니다.

## 1. Cloudflare 계정 연결

`oehnps.co.uk`가 활성 상태인 Cloudflare 계정에서 Workers와 D1을 사용할 수 있어야 합니다. 개인 PC의 터미널에서 브라우저 로그인을 진행할 수 있습니다.

```bash
npx wrangler login
npx wrangler whoami
```

기존 Wrangler 로그인은 재사용합니다. 자동화 환경에서는 해당 계정의 Workers/D1 관리, 영역·DNS 조회와 Worker 도메인 연결에 필요한 권한을 가진 `CLOUDFLARE_API_TOKEN`을 환경 설정의 비밀 값으로 연결할 수 있습니다. **토큰·비밀번호를 채팅이나 저장소에 넣지 않습니다.** 사용 계정이 여러 개라면 다음 설정 명령에 `--account-id 계정ID`를 추가합니다.

직접 API 토큰을 만드는 경우 선택한 계정과 `oehnps.co.uk` 영역에 다음 권한을 지정합니다. Cloudflare 화면의 `Edit`는 API 문서에서 `Write`로 표시되기도 합니다.

| 범위 | 권한 |
| --- | --- |
| 해당 계정 | Workers Scripts — Edit, D1 — Edit, Account Settings — Read |
| `oehnps.co.uk` 영역 | Zone — Read, DNS — Read |

Worker 사용자 도메인 연결은 Workers Scripts 권한을 사용합니다. 이 구성은 일반 DNS 레코드 편집이나 Workers Routes 쓰기 권한을 요구하지 않습니다. 근거: [Worker 도메인 API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/), [D1 API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/), [API 토큰 권한](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

기존 OAuth 로그인이 없고 홈 디렉터리에 쓸 수 없는 Codex 환경에서는, 안전하게 연결된 API 토큰을 그대로 사용하면서 해당 터미널에만 `XDG_CONFIG_HOME="$PWD/.wrangler/remote-config"`를 지정하고 그 디렉터리를 생성합니다. 개인 PC의 기존 로그인 경로는 변경하지 않습니다.

Cloudflare 네트워크가 차단된 환경에서는 `api.cloudflare.com` 및 Wrangler가 사용하는 인증·자산 업로드 대상에 접근할 수 있도록 해당 환경 설정을 먼저 적용해야 합니다. 권한이나 연결 문제를 인증서 검증 해제로 우회하지 않습니다.

## 2. 원격 D1 준비

```bash
npm run cf:setup -- --remote
```

스크립트는 같은 이름의 `havs-workspace` D1을 조회해 재사용하고, 없을 때만 생성합니다. 기존 데이터는 초기화하지 않습니다. 다른 앱의 테이블이나 서로 다른 배포 계정/DB를 발견하면 중단합니다. 필요한 마이그레이션을 적용한 후 실제 연결 정보는 무시되는 `.cloudflare-deploy/`에 저장합니다. 추적되는 `wrangler.jsonc`의 가상 로컬 ID를 실제 ID로 바꿀 필요는 없습니다.

요금제를 자동 변경하거나 유료 플랜을 신청하지 않습니다. 계정의 리소스 한도에 걸리면 중단합니다. 이 단계는 DB 준비이며 아직 공개 사이트 배포가 아닙니다.

## 3. 첫 원격 계정 생성

```bash
npm run cf:admin -- create-user --remote --email owner@example.com --name '운영자'
```

운영자가 비밀번호를 입력하지 않는 방법도 있습니다. `create-invite --remote --email 본인이메일`로 초대 코드만 만들고, 배포된 사이트의 **초대로 가입** 화면에서 사용자가 비밀번호를 직접 정합니다. 초대 코드도 공개 대화나 저장소에 올리지 않습니다.

추가 사용자는 이메일에 연결된 일회용 초대로 가입할 수 있습니다.

```bash
npm run cf:admin -- create-invite --remote --email colleague@example.com
```

초대 코드는 7일 동안 한 번 사용할 수 있으며 대상 사용자에게만 전달합니다. 자동 이메일은 보내지 않습니다. 비밀번호를 잊으면 운영자가 아래 명령으로 재설정합니다. 기존 세션은 같은 DB 변경 작업에서 폐기됩니다.

```bash
npm run cf:admin -- reset-password --remote --email owner@example.com
```

관리 명령은 Cloudflare 계정의 인증으로 D1을 관리합니다. 일반 웹 사용자에게 관리자 API를 공개하지 않습니다. SQL 파일은 권한 `0600`의 임시 위치에 만들고 제거하며 비밀번호 해시나 원본 SQL을 로그에 출력하지 않습니다. 비밀번호 자동 입력은 명시적인 `--password-stdin`으로만 지원합니다. 비밀번호를 명령행 인수로 넣지 않습니다.

## 4. 도메인 확인과 배포

```bash
npm run cf:deploy -- --remote
```

배포 스크립트는 다음을 확인합니다.

- 같은 계정의 `oehnps.co.uk` 영역이 활성 상태인지 확인합니다.
- `havs.oehnps.co.uk`에 다른 DNS 레코드나 다른 Worker가 연결되어 있으면 **덮어쓰지 않고 중단**합니다. 기존 레코드의 용도를 Cloudflare에서 먼저 확인합니다. 다른 도메인의 DNS는 바꾸지 않습니다.
- 화면을 빌드하고 Worker를 배포한 뒤, 충돌 덮어쓰기 옵션을 끈 API 요청으로 지정 도메인만 연결합니다. 확인 도중 DNS가 바뀌더라도 강제로 교체하지 않습니다.
- `workers.dev`와 임시 미리보기 주소는 비활성화합니다. `APP_ORIGIN`은 정확히 `https://havs.oehnps.co.uk`로 설정합니다.

`havs-workspace` Worker는 이 사이트 전용입니다. 처음 도메인을 연결하는 동안 다른 운영자가 같은 Worker에 별도 도메인을 동시에 추가하지 않습니다. 연결 API는 해당 Worker의 전체 도메인 목록을 적용하므로 스크립트는 이미 다른 도메인이 연결되어 있으면 중단합니다.

Cloudflare가 도메인의 HTTPS 인증서를 제공하므로 Caddy나 Tunnel 토큰은 필요하지 않습니다. 기존 Compose 배포와는 별도 방식입니다.

도메인에서 `/api` 및 `/api/*`에 **캐시 우회**를 적용합니다. 기존 `Cache Everything` 같은 규칙으로 API 응답을 캐시하면 안 됩니다. 앱이 보내는 `Cache-Control: no-store`를 유지하고 `Origin`, `Cookie`, `X-CSRF-Token` 헤더를 제거하지 않습니다. 이 호스트의 Rocket Loader 등 HTML/스크립트 삽입 기능은 사용하지 않습니다. 정적 파일의 보안 헤더는 `public/_headers`에서 제공합니다.

## 5. 실제 서비스 검증

배포 명령은 공개 HTTPS/API의 캐시 제외와 존재하지 않는 임의 테스트 이메일의 로그인 거절을 확인합니다. 이 요청은 실제 비밀번호 검증 연산을 실행하지만 계정을 생성하지 않습니다. DNS나 인증서 적용 중이면 검증에 실패할 수 있으므로 적용 후 아래 명령만 다시 실행합니다.

```bash
node scripts/cloudflare-check.mjs --remote
```

이어서 브라우저에서 첫 계정으로 로그인하고 공구·평가를 저장한 뒤, 다른 기기에서 같은 계정으로 기록을 확인합니다. Cloudflare의 요청·CPU·D1 사용량과 오류 지표도 확인합니다. **무료 요금제에서 계속 운영 가능한지는 실제 트래픽과 비밀번호 검증 CPU 사용량을 확인해야 합니다.** 로컬 테스트 통과나 `/api/health` 응답만으로 무료 운영을 보장하지 않습니다. CPU 제한 오류가 발생해도 스크립트가 요금제를 자동 변경하지 않습니다.

무료 한도와 가격은 [Workers 요금 안내](https://developers.cloudflare.com/workers/platform/pricing/)와 [D1 요금 안내](https://developers.cloudflare.com/d1/platform/pricing/)에서 현재 조건을 확인합니다. 이 저장소는 유료 요금제에 가입하지 않습니다.

## 백업과 이후 업데이트

작업 공간 JSON 내보내기는 공구·프로젝트·평가만 보관합니다. 계정까지 보관하려면 전체 D1 백업을 별도로 생성합니다. 다음은 Bash 터미널 예시입니다.

```bash
umask 077
mkdir -p backups
npx wrangler d1 export DB --remote \
  --config .cloudflare-deploy/wrangler.json \
  --output "backups/havs-d1-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

이 파일에는 인증 정보와 사용자 기록이 포함됩니다. 안전한 위치에 보관하고 Git에 올리지 않습니다. 복구는 별도 D1에서 검증한 뒤 연결을 전환하는 절차로 계획합니다. 기존 운영 DB에 백업 SQL을 무작정 실행하지 않습니다.

코드 업데이트 후에는 `cf:setup -- --remote`로 새 마이그레이션을 확인하고 `cf:deploy -- --remote`를 실행합니다. `.cloudflare-deploy/`를 잃었다면 같은 계정과 D1을 먼저 확인해 재연결합니다. 기존 Worker/도메인 소유권을 확인하지 못하면 자동 배포는 중단합니다.

**2026년 10월 21일 수요일** 개인 PC 설치는 [개인 PC 안내](local-pc.md)를 참고하세요. PC의 SQLite와 Cloudflare D1은 별개이며 자동 동기화되지 않습니다.
