import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowRight,
  AudioLines,
  Check,
  ClipboardCheck,
  Cloud,
  Eye,
  EyeOff,
  FolderPlus,
  LoaderCircle,
  LogOut,
  ShieldCheck,
  Upload,
  Waves,
} from "lucide-react";
import App from "./App";
import {
  ApiError,
  getSession,
  getWorkspace,
  login,
  logout,
  putWorkspace,
  register,
} from "./api";
import type { Session, Connection, WorkspaceEnvelope } from "./api";
import { readLocalWorkspace } from "./storage";
import { createSeed } from "./seed";
import type { Workspace } from "./domain";
import "./auth.css";

function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <aside className="auth-story">
          <div className="auth-brand">
            <span>
              <AudioLines size={30} />
            </span>
            HAVS<span className="brand-dot">.</span>
          </div>
          <div className="auth-eyebrow">WORKPLACE INTELLIGENCE</div>
          <div className="auth-art" aria-hidden="true">
            <div className="auth-ring" />
            <div className="auth-wave">
              <Waves size={76} strokeWidth={1} />
            </div>
            <span className="art-dot one" />
            <span className="art-dot two" />
          </div>
          <div className="auth-story-copy">
            <span className="auth-kicker">EVERY RECORD MATTERS</span>
            <h1>
              작은 기록에서,
              <br />더 안전한 현장으로.
            </h1>
            <p>
              공구의 진동과 소음, 작업자의 사용 시간.
              <br />
              현장의 데이터를 하나의 작업 공간에 모으세요.
            </p>
          </div>
          <div className="auth-benefits">
            <span>
              <ClipboardCheck size={15} />
              진동·소음 노출 평가
            </span>
            <span>
              <Cloud size={15} />
              계정별 기록 보관
            </span>
            <span>
              <ShieldCheck size={15} />
              프로젝트별 관리
            </span>
          </div>
          <div className="auth-story-footer">MEASURE. UNDERSTAND. PROTECT.</div>
        </aside>
        <section className="auth-content">{children}</section>
      </div>
      <p className="auth-footnote">
        HAVS Workspace · UK HSE 참고 기준 · 실제 평가에는 확인된 측정 데이터가
        필요합니다.
      </p>
    </div>
  );
}
function SignIn({
  onSession,
  onDemo,
  unavailable,
  retry,
}: {
  onSession: (session: Session) => Promise<void>;
  onDemo: () => void;
  unavailable: boolean;
  retry: () => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [visible, setVisible] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const element = event.currentTarget,
      f = new FormData(element);
    setBusy(true);
    setError("");
    try {
      const session =
        mode === "login"
          ? await login(
              String(f.get("email")).trim(),
              String(f.get("password")),
            )
          : await register(
              String(f.get("email")).trim(),
              String(f.get("password")),
              String(f.get("name")).trim(),
              String(f.get("inviteCode")).trim(),
            );
      await onSession(session);
      element.reset();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : "로그인 요청을 완료하지 못했습니다. 다시 시도해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame>
      <div className="auth-form-heading">
        <span className="eyebrow">YOUR SAFETY WORKSPACE</span>
        <h2>
          {mode === "login"
            ? "작업 공간에 오신 것을 환영합니다"
            : "함께 만드는 안전한 현장"}
        </h2>
        <p>
          {mode === "login"
            ? "로그인하고 현장의 기록을 이어가세요."
            : "관리자에게 받은 초대 코드로 계정을 만드세요."}
        </p>
      </div>
      <div className="auth-tabs">
        <button
          aria-pressed={mode === "login"}
          onClick={() => {
            setMode("login");
            setError("");
          }}
        >
          로그인
        </button>
        <button
          aria-pressed={mode === "register"}
          onClick={() => {
            setMode("register");
            setError("");
          }}
        >
          초대로 가입
        </button>
      </div>
      {unavailable && (
        <div className="auth-server-notice" role="status">
          <span>
            서버에 연결되지 않았습니다. 예시 화면은 둘러볼 수 있습니다.
          </span>
          <button onClick={retry}>연결 다시 확인</button>
        </div>
      )}
      <form onSubmit={submit} className="auth-form" key={mode}>
        {mode === "register" && (
          <label>
            이름
            <input
              name="name"
              autoComplete="name"
              required
              maxLength={60}
              placeholder="이름을 입력하세요"
            />
          </label>
        )}
        <label>
          이메일
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            maxLength={254}
            placeholder="name@company.com"
          />
        </label>
        <label>
          {mode === "register" ? "비밀번호 (12자 이상)" : "비밀번호"}
          <div className="password-field">
            <input
              name="password"
              type={visible ? "text" : "password"}
              required
              minLength={mode === "register" ? 12 : undefined}
              maxLength={128}
              autoComplete={
                mode === "register" ? "new-password" : "current-password"
              }
              placeholder={
                mode === "register"
                  ? "12자 이상 입력하세요"
                  : "비밀번호를 입력하세요"
              }
            />
            <button
              type="button"
              aria-label={visible ? "비밀번호 숨기기" : "비밀번호 표시"}
              onClick={() => setVisible(!visible)}
            >
              {visible ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
        </label>
        {mode === "register" && (
          <label>
            초대 코드
            <input
              name="inviteCode"
              required
              autoComplete="off"
              maxLength={256}
              placeholder="관리자에게 받은 일회용 코드"
            />
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="button primary auth-submit"
          disabled={busy}
        >
          {busy ? <LoaderCircle size={17} className="spinner" /> : null}
          {busy ? "확인 중…" : mode === "login" ? "로그인" : "계정 만들기"}
          {!busy && <ArrowRight size={17} />}
        </button>
      </form>
      <p className="auth-invite-note">
        {mode === "login"
          ? "계정이 없거나 비밀번호를 잊으셨나요? 현장 관리자에게 문의해 주세요."
          : "초대 코드는 한 번만 사용할 수 있습니다. 가입 후에는 내 계정에 연결된 기록만 표시됩니다."}
      </p>
      <div className="auth-demo">
        <span>먼저 기능을 확인하고 싶다면</span>
        <button onClick={onDemo}>
          예시로 둘러보기 <ArrowRight size={15} />
        </button>
        <small>예시 모드는 이 브라우저에만 저장됩니다.</small>
      </div>
    </AuthFrame>
  );
}
function SetupWorkspace({
  session,
  revision,
  onReady,
  onLogout,
  accountError,
}: {
  session: Session;
  revision: number;
  onReady: (connection: Connection) => void;
  onLogout: () => Promise<void>;
  accountError?: string;
}) {
  const [local] = useState(readLocalWorkspace),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function start(workspace: Workspace, migrating = false) {
    if (
      migrating &&
      !confirm(
        "이 브라우저의 기존 공구·평가·프로젝트를 현재 로그인한 계정에 복사할까요? 브라우저의 원본 데이터는 유지됩니다.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const result = await putWorkspace(workspace, revision, session.csrfToken);
      onReady({
        ...session,
        initialWorkspace: workspace,
        revision: result.revision,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const remote = await getWorkspace(session.csrfToken).catch(() => null);
        if (remote?.workspace) {
          onReady({
            ...session,
            initialWorkspace: remote.workspace,
            revision: remote.revision,
          });
          return;
        }
      }
      setError(
        e instanceof Error ? e.message : "작업 공간을 만들지 못했습니다.",
      );
      setBusy(false);
    }
  }
  return (
    <AuthFrame>
      <div className="auth-form-heading">
        <span className="eyebrow">A FRESH START</span>
        <h2>
          {session.user.name}님의
          <br />첫 작업 공간을 준비하세요.
        </h2>
        <p>
          기록은 로그인한 계정에 보관됩니다.
          <br />
          원하는 시작 방법을 선택해 주세요.
        </p>
      </div>
      <div className="workspace-choices">
        <button
          disabled={busy}
          onClick={() =>
            void start({ version: 1, tools: [], assessments: [], projects: [] })
          }
        >
          <span className="choice-icon">
            <FolderPlus size={23} />
          </span>
          <span>
            <strong>빈 작업 공간으로 시작</strong>
            <small>실제 현장의 프로젝트와 공구를 등록합니다.</small>
          </span>
          <ArrowRight size={17} />
        </button>
        <button disabled={busy} onClick={() => void start(createSeed())}>
          <span className="choice-icon">
            <Waves size={23} />
          </span>
          <span>
            <strong>예시 데이터로 시작</strong>
            <small>가상 공구 8개와 평가 기록으로 둘러봅니다.</small>
          </span>
          <ArrowRight size={17} />
        </button>
        {local && (
          <button disabled={busy} onClick={() => void start(local, true)}>
            <span className="choice-icon">
              <Upload size={23} />
            </span>
            <span>
              <strong>이 브라우저의 데이터 가져오기</strong>
              <small>
                공구 {local.tools.length}개 · 평가 {local.assessments.length}건
                · 원본 유지
              </small>
            </span>
            <ArrowRight size={17} />
          </button>
        )}
      </div>
      {busy && (
        <p className="auth-busy" role="status">
          <LoaderCircle className="spinner" size={17} />
          작업 공간을 저장하고 있습니다.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {accountError && (
        <p className="form-error" role="alert">
          {accountError}
        </p>
      )}
      <div className="setup-identity">
        <Check size={15} />
        {session.user.email}
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onLogout();
            setBusy(false);
          }}
        >
          <LogOut size={14} />
          로그아웃
        </button>
      </div>
    </AuthFrame>
  );
}
export default function SessionGate() {
  const [demo, setDemo] = useState(
    () => new URLSearchParams(location.search).get("demo") === "1",
  );
  const [checking, setChecking] = useState(!demo),
    [unavailable, setUnavailable] = useState(false),
    [error, setError] = useState("");
  const [session, setSession] = useState<Session | null>(null),
    [workspace, setWorkspace] = useState<WorkspaceEnvelope | null>(null);
  async function accept(next: Session) {
    const remote = await getWorkspace(next.csrfToken);
    setWorkspace(remote);
    setSession(next);
    setError("");
    setUnavailable(false);
  }
  async function check() {
    setChecking(true);
    setError("");
    try {
      await accept(await getSession());
    } catch (e) {
      setSession(null);
      setWorkspace(null);
      setUnavailable(!(e instanceof ApiError && e.status === 401));
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    if (!demo) void check();
  }, []);
  async function leave() {
    if (session) {
      try {
        await logout(session.csrfToken);
      } catch (e) {
        let stale = e instanceof ApiError && e.status === 401;
        if (e instanceof ApiError && e.status === 403) {
          try {
            const active = await getSession();
            stale =
              active.user.id !== session.user.id ||
              active.csrfToken !== session.csrfToken;
          } catch (lookupError) {
            stale =
              lookupError instanceof ApiError && lookupError.status === 401;
          }
        }
        if (!stale) {
          setError(
            "로그아웃을 완료하지 못했습니다. 서버 연결을 확인하고 다시 시도해 주세요.",
          );
          return false;
        }
      }
    }
    setSession(null);
    setWorkspace(null);
    setError("");
    return true;
  }
  if (demo)
    return (
      <App
        key="demo"
        onExit={async () => {
          history.replaceState(null, "", location.pathname);
          setDemo(false);
          await check();
          return true;
        }}
      />
    );
  if (checking)
    return (
      <div className="auth-loading" role="status">
        <span className="brand-mark">
          <AudioLines size={26} />
        </span>
        <LoaderCircle className="spinner" size={21} />
        <p>작업 공간을 확인하고 있습니다.</p>
      </div>
    );
  if (!session || !workspace)
    return (
      <SignIn
        onSession={accept}
        onDemo={() => {
          history.replaceState(null, "", `${location.pathname}?demo=1`);
          setDemo(true);
        }}
        unavailable={unavailable}
        retry={() => void check()}
      />
    );
  if (!workspace.workspace)
    return (
      <SetupWorkspace
        session={session}
        revision={workspace.revision}
        accountError={error}
        onReady={(connection) =>
          setWorkspace({
            workspace: connection.initialWorkspace,
            revision: connection.revision,
          })
        }
        onLogout={async () => {
          await leave();
        }}
      />
    );
  const connection: Connection = {
    ...session,
    initialWorkspace: workspace.workspace,
    revision: workspace.revision,
  };
  return (
    <App
      key={session.user.id}
      connection={connection}
      onExit={leave}
      accountError={error}
    />
  );
}
