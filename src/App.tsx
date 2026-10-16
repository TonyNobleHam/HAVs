import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Activity as ActivityIcon,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Download,
  FileText,
  FolderKanban,
  Gauge,
  HardHat,
  LayoutDashboard,
  LogOut,
  Menu,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Upload,
  Waves,
  Wrench,
  X,
} from "lucide-react";
import {
  dateISO,
  duration,
  exposure,
  isWorkspace,
  reportCSV,
  riskLabels,
  snapshot,
  timeToThreshold,
} from "./domain";
import type {
  Activity,
  Assessment,
  Project,
  Risk,
  Tool,
  Workspace,
} from "./domain";
import { download, useWorkspace } from "./storage";
import type { Connection } from "./api";

type View = "dashboard" | "tools" | "assessments" | "projects" | "guide";
const navigation: { id: View; title: string; icon: typeof Waves }[] = [
  { id: "dashboard", title: "대시보드", icon: LayoutDashboard },
  { id: "tools", title: "공구 데이터베이스", icon: Wrench },
  { id: "assessments", title: "노출 평가", icon: ActivityIcon },
  { id: "projects", title: "프로젝트", icon: FolderKanban },
  { id: "guide", title: "가이드 · 기준", icon: BookOpen },
];
const categories = ["연삭·절단", "천공·파쇄", "체결", "조경", "기타"];
const dateLabel = (value: string) => value.replaceAll("-", ".");

function Badge({ risk }: { risk: Risk }) {
  return (
    <span className={`badge ${risk}`}>
      <span />
      {riskLabels[risk]}
    </span>
  );
}
function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <ClipboardCheck size={26} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea, a[href], [tabindex="0"]',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);
      const first = focusable[0],
        last = focusable.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === ref.current)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === ref.current)
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="닫기" onClick={onClose}>
            <X size={22} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function TrendChart({ assessments }: { assessments: Assessment[] }) {
  const days = Array.from({ length: 7 }, (_, i) => dateISO(i - 6));
  const values = days.map((day) =>
    Math.max(
      0,
      ...assessments
        .filter((a) => a.date === day)
        .map((a) => exposure(a.activities).a8),
    ),
  );
  const max = Math.max(7.5, Math.ceil(Math.max(...values) / 2.5) * 2.5);
  const y = (value: number) => 154 - (value / max) * 130;
  return (
    <svg
      viewBox="0 0 580 202"
      className="trend-chart"
      role="img"
      aria-label="최근 7일 일일 최고 진동 노출량. 점선은 조치값 2.5와 한계값 5입니다."
    >
      {[0, 2.5, 5, max]
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .map((tick) => (
          <g key={tick}>
            <line
              x1="42"
              y1={y(tick)}
              x2="568"
              y2={y(tick)}
              stroke={tick === 5 ? "#eec7b3" : "#e5eae7"}
              strokeDasharray={tick ? "4 5" : ""}
            />
            <text
              x="28"
              y={y(tick) + 4}
              textAnchor="end"
              className="chart-label"
            >
              {tick.toFixed(1)}
            </text>
          </g>
        ))}
      {values.map((value, i) => (
        <g key={days[i]}>
          <rect
            x={65 + i * 73}
            y={y(value)}
            width="32"
            height={154 - y(value)}
            rx="5"
            fill={value >= 5 ? "#e78d62" : value >= 2.5 ? "#8ea99a" : "#b4c9bc"}
          >
            <title>
              {days[i]}: {value.toFixed(2)} m/s²
            </title>
          </rect>
          <text
            x={81 + i * 73}
            y="181"
            textAnchor="middle"
            className={`chart-label ${i === 6 ? "today" : ""}`}
          >
            {days[i].slice(5).replace("-", ".")}
          </text>
          {value > 0 && (
            <text
              x={81 + i * 73}
              y={y(value) - 7}
              textAnchor="middle"
              className="chart-value"
            >
              {value.toFixed(1)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

function AssessmentTable({
  rows,
  projects,
  onOpen,
}: {
  rows: Assessment[];
  projects: Project[];
  onOpen: (a: Assessment) => void;
}) {
  if (!rows.length)
    return (
      <Empty title="아직 평가 기록이 없습니다">
        공구와 작업 시간을 입력해 첫 번째 노출 평가를 만들어 보세요.
      </Empty>
    );
  return (
    <div className="table-scroll">
      <table className="assessment-table">
        <thead>
          <tr>
            <th>작업자 / 프로젝트</th>
            <th>평가일</th>
            <th>사용 시간</th>
            <th>일일 노출 A(8)</th>
            <th>위험 수준</th>
            <th>
              <span className="sr-only">보고서</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const e = exposure(a.activities);
            return (
              <tr key={a.id}>
                <td>
                  <div className="person">
                    <span className="avatar">{a.worker.slice(0, 1)}</span>
                    <div>
                      <strong>{a.worker}</strong>
                      <small>
                        {projects.find((p) => p.id === a.projectId)?.name}
                      </small>
                    </div>
                  </div>
                </td>
                <td className="subtle nowrap">{dateLabel(a.date)}</td>
                <td>
                  {duration(e.minutes)}
                  <small className="cell-small">
                    공구 {a.activities.length}개
                  </small>
                </td>
                <td>
                  <strong className="number">{e.a8.toFixed(2)}</strong>
                  <span className="unit"> m/s²</span>
                </td>
                <td>
                  <Badge risk={e.risk} />
                </td>
                <td>
                  <button
                    className="icon-button"
                    aria-label={`${a.worker} ${a.date} 보고서 보기`}
                    onClick={() => onOpen(a)}
                  >
                    <ArrowUpRight size={18} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Dashboard({
  data,
  selectView,
  onNew,
  onOpen,
}: {
  data: Workspace;
  selectView: (view: View) => void;
  onNew: () => void;
  onOpen: (a: Assessment) => void;
}) {
  const [project, setProject] = useState("all");
  const rows = data.assessments.filter(
    (a) => project === "all" || a.projectId === project,
  );
  const week = rows.filter((a) => a.date >= dateISO(-6) && a.date <= dateISO());
  const today = rows.filter((a) => a.date === dateISO());
  const counts = (["low", "action", "limit"] as Risk[]).map(
    (risk) => week.filter((a) => exposure(a.activities).risk === risk).length,
  );
  const total = week.length;
  const lowAngle = total ? (counts[0] / total) * 360 : 0;
  const midAngle = total ? ((counts[0] + counts[1]) / total) * 360 : 0;
  const maintenance = data.tools
    .filter((t) => t.inspectionDue <= dateISO(7))
    .sort((a, b) => a.inspectionDue.localeCompare(b.inspectionDue));
  const rankMap = new Map<string, { id: string; name: string; sum: number }>();
  week.forEach((a) =>
    a.activities.forEach((row) => {
      const previous = rankMap.get(row.toolId);
      rankMap.set(row.toolId, {
        id: row.toolId,
        name: row.toolName.split(" · ")[0],
        sum: (previous?.sum ?? 0) + row.vibration ** 2 * row.minutes,
      });
    }),
  );
  const ranked = [...rankMap.values()]
    .sort((a, b) => b.sum - a.sum)
    .slice(0, 4);
  const allContribution = [...rankMap.values()].reduce((n, a) => n + a.sum, 0);
  const recent = [...rows]
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
    )
    .slice(0, 4);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span /> WORKPLACE SAFETY, IN FOCUS
          </div>
          <h1>현장의 위험을, 한눈에.</h1>
          <p>작은 데이터가 만드는 더 안전한 작업 환경.</p>
        </div>
        <div className="heading-actions">
          <label className="select-shell">
            <FolderKanban size={15} />
            <select
              aria-label="현장 필터"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="all">전체 프로젝트</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
          </label>
          <button className="button primary" onClick={onNew}>
            <Plus size={17} />새 노출 평가
          </button>
        </div>
      </div>
      <div className="sample-banner">
        <span className="sample-dot" />
        <span>
          {data.tools.some((t) => t.sample) ? "예시 작업 공간" : "내 작업 공간"}
        </span>
        <span className="banner-divider" />
        <p>
          {data.tools.some((t) => t.sample)
            ? "가상 공구 데이터로 기능을 둘러보세요. 실제 평가에는 확인된 측정값이 필요합니다."
            : "확인된 공구 데이터를 입력하고 작업자의 하루 전체 사용 시간을 기록하세요."}
        </p>
        <button onClick={() => selectView("guide")}>
          이용 가이드 <ArrowRight size={14} />
        </button>
      </div>
      <div className="stats-grid">
        <Stat
          label="등록된 공구"
          number={data.tools.length}
          unit="개"
          icon={Wrench}
          note="전체 공구 데이터베이스"
          color="green"
        />
        <Stat
          label="오늘의 노출 평가"
          number={today.length}
          unit="건"
          icon={ClipboardCheck}
          note={`${new Set(today.map((a) => a.worker)).size}명의 작업자 기록`}
          color="blue"
        />
        <Stat
          label="관리가 필요한 평가"
          number={
            today.filter((a) => exposure(a.activities).risk !== "low").length
          }
          unit="건"
          icon={TriangleAlert}
          note="오늘 · 진동 조치값 이상"
          color="orange"
        />
        <Stat
          label="진행 프로젝트"
          number={project === "all" ? data.projects.length : 1}
          unit="개"
          icon={FolderKanban}
          note="현장별 작업 환경 관리"
          color="purple"
        />
      </div>
      <div className="charts-grid">
        <section className="panel chart-panel">
          <div className="panel-heading">
            <div>
              <h2>일일 진동 노출 추이</h2>
              <p>최근 7일 · 평가별 A(8)의 일일 최댓값</p>
            </div>
            <span className="quiet-pill">m/s²</span>
          </div>
          <TrendChart assessments={week} />
          <div className="chart-footer">
            <span>
              <i className="legend-dot sage" />
              일일 최고 노출
            </span>
            <span>
              <i className="legend-line" />
              조치값 2.5 · 한계값 5.0
            </span>
            <span className="chart-time">최근 7일</span>
          </div>
        </section>
        <section className="panel risk-panel">
          <div className="panel-heading">
            <div>
              <h2>위험 수준 분포</h2>
              <p>최근 7일 진동 노출 평가 기준</p>
            </div>
            <ShieldCheck size={19} className="subtle" />
          </div>
          <div className="risk-content">
            <div
              className="donut"
              style={{
                background: total
                  ? `conic-gradient(#567f68 0deg ${lowAngle}deg, #ecc47b ${lowAngle}deg ${midAngle}deg, #e48c68 ${midAngle}deg 360deg)`
                  : "#e9edea",
              }}
            >
              <div>
                <strong>
                  {total}
                  <small>건</small>
                </strong>
                <span>전체 평가</span>
              </div>
            </div>
            <div className="risk-legend">
              {(["low", "action", "limit"] as Risk[]).map((risk, i) => (
                <div key={risk}>
                  <span>
                    <i className={`legend-dot ${risk}`} />
                    {riskLabels[risk]}
                  </span>
                  <strong>
                    {counts[i]}
                    <small>건</small>
                  </strong>
                </div>
              ))}
            </div>
          </div>
          <div className="panel-note">
            <ShieldCheck size={14} />
            진동은 2.5 m/s²부터 노출 저감 조치가 필요해요.
          </div>
        </section>
      </div>
      <div className="lower-grid">
        <section className="panel recent-panel">
          <div className="panel-heading">
            <div className="heading-inline">
              <h2>최근 노출 평가</h2>
              <span className="count-chip">{rows.length}</span>
            </div>
            <button
              className="text-button"
              onClick={() => selectView("assessments")}
            >
              전체 보기 <ChevronRight size={15} />
            </button>
          </div>
          <AssessmentTable
            rows={recent}
            projects={data.projects}
            onOpen={onOpen}
          />
        </section>
        <section className="panel priorities-panel">
          <div className="panel-heading">
            <div>
              <h2>집중 관리 공구</h2>
              <p>최근 7일 전체 기록의 진동 기여도</p>
            </div>
            <Gauge size={19} className="subtle" />
          </div>
          <div className="rank-list">
            {ranked.map((tool, i) => (
              <div className="rank-row" key={tool.id}>
                <span className="rank-index">0{i + 1}</span>
                <div>
                  <div className="rank-title">
                    <span>{tool.name}</span>
                    <strong>
                      {allContribution
                        ? Math.round((tool.sum / allContribution) * 100)
                        : 0}
                      %
                    </strong>
                  </div>
                  <div className="progress-track">
                    <span
                      style={{
                        width: `${allContribution ? (tool.sum / allContribution) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
            {!ranked.length && (
              <p className="subtle">평가를 추가하면 우선순위가 표시됩니다.</p>
            )}
          </div>
          <button className="panel-link" onClick={() => selectView("tools")}>
            공구 데이터 확인하기 <ArrowUpRight size={16} />
          </button>
        </section>
      </div>
      <section className="maintenance-strip">
        <div className="maintenance-symbol">
          <Wrench size={20} />
        </div>
        <div>
          <strong>공구도 정기적인 점검이 필요해요.</strong>
          <p>
            {maintenance.length
              ? `7일 이내 점검 대상 ${maintenance.length}개 · ${maintenance
                  .slice(0, 2)
                  .map((t) => t.name)
                  .join(", ")}${maintenance.length > 2 ? " 외" : ""}`
              : "7일 이내 예정되거나 기한이 지난 점검이 없습니다."}
          </p>
        </div>
        <button
          className="button secondary"
          onClick={() => selectView("tools")}
        >
          점검 일정 보기 <ArrowRight size={15} />
        </button>
      </section>
    </>
  );
}

function Stat({
  label,
  number,
  unit,
  icon: Icon,
  note,
  color,
}: {
  label: string;
  number: number;
  unit: string;
  icon: typeof Waves;
  note: string;
  color: string;
}) {
  return (
    <section className="stat-card">
      <div className="stat-top">
        <span>{label}</span>
        <span className={`stat-icon ${color}`}>
          <Icon size={18} />
        </span>
      </div>
      <div className="stat-value">
        {number}
        <span>{unit}</span>
      </div>
      <p>
        <span className={`tiny-dot ${color}`} />
        {note}
      </p>
    </section>
  );
}

function ToolForm({
  tool,
  onSave,
  onClose,
}: {
  tool?: Tool;
  onSave: (t: Tool) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name")).trim(),
      model = String(form.get("model")).trim(),
      source = String(form.get("source")).trim();
    if (!name || !model || !source) {
      setError("공구명, 모델, 데이터 출처를 입력해 주세요.");
      return;
    }
    onSave({
      id: tool?.id ?? crypto.randomUUID(),
      name,
      model,
      source,
      category: String(form.get("category")),
      vibration: Number(form.get("vibration")),
      noise: form.get("noise") === "" ? null : Number(form.get("noise")),
      inspectionDue: String(form.get("inspectionDue")),
      sample: form.get("sample") === "on",
    });
  }
  return (
    <Modal
      title={tool ? "공구 정보 수정" : "새 공구 등록"}
      subtitle="작업 조건에 맞는 진동값과 데이터 출처를 기록하세요."
      onClose={onClose}
    >
      <form onSubmit={submit} className="modal-form">
        <div className="form-grid">
          <label>
            공구명
            <input
              name="name"
              required
              maxLength={80}
              defaultValue={tool?.name}
              placeholder="예: 앵글 그라인더"
            />
          </label>
          <label>
            제조사 · 모델
            <input
              name="model"
              required
              maxLength={80}
              defaultValue={tool?.model}
              placeholder="예: 제조사 AG-125"
            />
          </label>
          <label>
            공구 종류
            <select name="category" defaultValue={tool?.category}>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            다음 점검일
            <input
              name="inspectionDue"
              type="date"
              required
              defaultValue={tool?.inspectionDue ?? dateISO(30)}
            />
          </label>
          <label>
            진동 합성값 (m/s²)
            <input
              name="vibration"
              type="number"
              required
              min="0"
              max="100"
              step="0.01"
              defaultValue={tool?.vibration}
              placeholder="예: 6.2"
            />
          </label>
          <label>
            작업 중 소음 LAeq (dB(A))
            <input
              name="noise"
              type="number"
              min="0"
              max="200"
              step="0.1"
              defaultValue={tool?.noise ?? ""}
              placeholder="미입력 시 소음 평가 제외"
            />
          </label>
        </div>
        <label>
          데이터 출처 · 작업 조건
          <textarea
            name="source"
            required
            maxLength={1000}
            defaultValue={tool?.source}
            placeholder="측정 보고서, 측정일, 작업 재료·방식 등을 기록하세요."
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            name="sample"
            defaultChecked={tool?.sample ?? false}
          />
          기능 확인용 예시 데이터입니다.
        </label>
        <p className="form-hint">
          진동값은 손잡이의 3축 주파수 가중 합성값입니다. 제조사 방출값과 현장
          노출값은 다를 수 있습니다. 기존 평가 기록은 수정되지 않습니다.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            취소
          </button>
          <button className="button primary" type="submit">
            <Check size={16} />
            공구 저장
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ToolsPage({
  data,
  onSave,
  onDelete,
}: {
  data: Workspace;
  onSave: (tool: Tool) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("all");
  const [editing, setEditing] = useState<Tool | "new" | null>(null);
  const [dueOnly, setDueOnly] = useState(false);
  const rows = data.tools.filter(
    (t) =>
      `${t.name} ${t.model}`.toLowerCase().includes(query.toLowerCase()) &&
      (category === "all" || t.category === category) &&
      (!dueOnly || t.inspectionDue <= dateISO(7)),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR TOOL INTELLIGENCE</div>
          <h1>공구 데이터베이스</h1>
          <p>공구의 진동·소음 데이터부터 점검 일정까지, 한곳에서 관리하세요.</p>
        </div>
        <button className="button primary" onClick={() => setEditing("new")}>
          <Plus size={17} />
          공구 등록
        </button>
      </div>
      <div className="info-banner">
        <Waves size={19} />
        <p>
          <strong>데이터의 출처가 정확한 평가의 시작입니다.</strong> 예시 공구의
          수치는 실제 제품의 측정값이 아닙니다.
        </p>
      </div>
      <section className="panel">
        <div className="filter-bar">
          <label className="search-field">
            <Search size={17} />
            <input
              aria-label="공구 검색"
              placeholder="공구명 또는 모델 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select
            aria-label="공구 종류 필터"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="all">전체 공구 종류</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <button
            className={`button filter-button ${dueOnly ? "active" : ""}`}
            onClick={() => setDueOnly(!dueOnly)}
          >
            <SlidersHorizontal size={15} />
            점검 예정
          </button>
          <span className="filter-count">총 {rows.length}개</span>
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table className="tool-table">
              <thead>
                <tr>
                  <th>공구 / 모델</th>
                  <th>진동 합성값</th>
                  <th>소음 LAeq</th>
                  <th>조치값 도달 시간¹</th>
                  <th>다음 점검일</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <div className="tool-cell">
                        <span className="tool-symbol">
                          <Wrench size={21} />
                        </span>
                        <div>
                          <strong>
                            {t.name}{" "}
                            {t.sample && (
                              <span className="sample-tag">예시</span>
                            )}
                          </strong>
                          <small>
                            {t.model} · {t.category}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <strong className="number">
                        {t.vibration.toFixed(1)}
                      </strong>
                      <span className="unit"> m/s²</span>
                    </td>
                    <td>
                      {t.noise ?? "—"}
                      <span className="unit">
                        {t.noise !== null ? " dB(A)" : ""}
                      </span>
                    </td>
                    <td>{duration(timeToThreshold(t.vibration, 2.5))}</td>
                    <td>
                      <span
                        className={
                          t.inspectionDue < dateISO() ? "overdue" : "subtle"
                        }
                      >
                        {dateLabel(t.inspectionDue)}
                        {t.inspectionDue < dateISO() && (
                          <small className="cell-small">점검 기한 경과</small>
                        )}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          aria-label={`${t.name} 수정`}
                          onClick={() => setEditing(t)}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="icon-button danger"
                          aria-label={`${t.name} 삭제`}
                          onClick={() => {
                            if (
                              confirm(
                                `${t.name} 공구를 삭제할까요? 기존 평가의 측정값은 보존됩니다.`,
                              )
                            )
                              onDelete(t.id);
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="조건에 맞는 공구가 없습니다">
            검색 조건을 변경하거나 새로운 공구를 등록하세요.
          </Empty>
        )}
        <div className="table-footnote">
          ¹ 해당 공구만 사용할 때 A(8) 2.5 m/s²에 도달하는 계산상 시간입니다.
          다른 공구의 노출과 합산해야 합니다.
        </div>
      </section>
      {editing && (
        <ToolForm
          tool={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={(tool) => {
            onSave(tool);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function AssessmentForm({
  data,
  assessment,
  onSave,
  onClose,
}: {
  data: Workspace;
  assessment?: Assessment;
  onSave: (a: Assessment) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Activity[]>(
    assessment?.activities ??
      (data.tools[0] ? [snapshot(data.tools[0], 30)] : []),
  );
  const [error, setError] = useState("");
  const result = exposure(rows);
  const usable = data.tools.length > 0 && data.projects.length > 0;
  function update(id: string, patch: Partial<Activity>) {
    setRows((old) => old.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      worker = String(form.get("worker")).trim(),
      date = String(form.get("date"));
    if (!worker) {
      setError("작업자 이름을 입력해 주세요.");
      return;
    }
    if (
      !rows.length ||
      rows.some((a) => a.minutes <= 0) ||
      result.minutes > 1440
    ) {
      setError(
        "공구별 사용 시간을 입력하세요. 총 시간은 하루 24시간을 넘을 수 없습니다.",
      );
      return;
    }
    if (
      data.assessments.some(
        (a) =>
          a.id !== assessment?.id &&
          a.worker.trim() === worker &&
          a.date === date,
      )
    ) {
      setError(
        "이 작업자의 같은 날짜 평가가 이미 있습니다. 하루 노출을 빠짐없이 합산하도록 기존 평가를 수정해 주세요.",
      );
      return;
    }
    onSave({
      id: assessment?.id ?? crypto.randomUUID(),
      worker,
      date,
      projectId: String(form.get("projectId")),
      activities: rows,
      notes: String(form.get("notes")).trim(),
      createdAt: assessment?.createdAt ?? new Date().toISOString(),
    });
  }
  return (
    <Modal
      wide
      title={assessment ? "노출 평가 수정" : "새 노출 평가"}
      subtitle="한 작업자의 하루 동안 사용한 모든 공구를 기록하세요."
      onClose={onClose}
    >
      {!usable && !assessment ? (
        <Empty title="공구와 프로젝트를 먼저 등록해 주세요">
          공구 데이터베이스와 프로젝트 메뉴에서 각각 한 개 이상 추가하면 평가를
          시작할 수 있습니다.
        </Empty>
      ) : (
        <form onSubmit={submit} className="assessment-form">
          <div className="assessment-input">
            <div className="form-grid">
              <label>
                작업자 이름
                <input
                  name="worker"
                  required
                  maxLength={60}
                  placeholder="예: 홍길동"
                  defaultValue={assessment?.worker}
                />
              </label>
              <label>
                평가일
                <input
                  type="date"
                  name="date"
                  required
                  defaultValue={assessment?.date ?? dateISO()}
                />
              </label>
              <label className="span-two">
                프로젝트
                <select
                  name="projectId"
                  required
                  defaultValue={assessment?.projectId}
                >
                  {data.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="section-label">
              <h3>공구별 실제 사용 시간</h3>
              <span>트리거를 누른 시간 기준</span>
            </div>
            <div className="activity-list">
              {rows.map((row, i) => (
                <div className="activity-row" key={row.id}>
                  <span className="activity-index">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="activity-inputs">
                    <label>
                      사용 공구
                      <select
                        aria-label={`사용 공구 ${i + 1}`}
                        value={row.toolId}
                        onChange={(e) => {
                          const tool = data.tools.find(
                            (t) => t.id === e.target.value,
                          );
                          if (tool)
                            update(row.id, {
                              ...snapshot(tool, row.minutes),
                              id: row.id,
                            });
                        }}
                      >
                        {!data.tools.some((t) => t.id === row.toolId) && (
                          <option value={row.toolId}>
                            {row.toolName} (보관된 기록)
                          </option>
                        )}
                        {data.tools.map((t) => (
                          <option value={t.id} key={t.id}>
                            {t.name} · {t.model}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="activity-values">
                      <span>{row.vibration} m/s²</span>
                      <span>
                        {row.noise === null
                          ? "소음 미입력"
                          : `${row.noise} dB(A)`}
                      </span>
                      {row.sample && <span className="sample-tag">예시</span>}
                    </div>
                  </div>
                  <label className="minutes-field">
                    사용 시간
                    <div>
                      <input
                        aria-label={`사용 시간 ${i + 1}`}
                        type="number"
                        min="1"
                        max="1440"
                        step="1"
                        required
                        value={row.minutes || ""}
                        onChange={(e) =>
                          update(row.id, {
                            minutes: Math.max(0, Number(e.target.value)),
                          })
                        }
                      />
                      <span>분</span>
                    </div>
                  </label>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`공구 ${i + 1} 제거`}
                    onClick={() =>
                      setRows((old) => old.filter((a) => a.id !== row.id))
                    }
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
            <button
              className="add-row"
              type="button"
              disabled={!data.tools.length}
              onClick={() =>
                setRows((old) => [...old, snapshot(data.tools[0], 30)])
              }
            >
              <Plus size={17} />
              사용 공구 추가
            </button>
            <label className="notes-label">
              작업 내용 · 관리 조치
              <textarea
                name="notes"
                maxLength={2000}
                defaultValue={assessment?.notes}
                placeholder="작업 재료, 작업 방식, 휴식 및 공구 교체 등 관리 조치를 기록하세요."
              />
            </label>
          </div>
          <aside className="live-result">
            <div className="live-label">
              <span />
              실시간 계산
            </div>
            <h3>일일 진동 노출 A(8)</h3>
            <div className="result-value">
              {result.a8.toFixed(2)}
              <span>m/s²</span>
            </div>
            <Badge risk={result.risk} />
            <div className="exposure-meter">
              <span
                style={{ width: `${Math.min((result.a8 / 7.5) * 100, 100)}%` }}
              />
              <i style={{ left: "33.33%" }} />
              <i style={{ left: "66.66%" }} />
            </div>
            <div className="meter-labels">
              <span>0</span>
              <span>2.5 조치</span>
              <span>5.0 한계</span>
            </div>
            <div className="result-detail">
              <span>노출 점수</span>
              <strong>
                {Math.round(result.points)}
                <small> 점</small>
              </strong>
            </div>
            <div className="result-detail">
              <span>총 사용 시간</span>
              <strong>{duration(result.minutes)}</strong>
            </div>
            <div className="result-detail">
              <span>소음 LEX,8h</span>
              <strong>
                {result.noise?.toFixed(1) ?? "미산출"}
                <small>{result.noise !== null ? " dB(A)" : ""}</small>
              </strong>
            </div>
            <p className="result-explanation">
              {result.risk === "limit"
                ? "진동 노출 한계값 이상입니다. 작업 계획을 재검토하고 노출을 줄이는 조치가 필요합니다."
                : result.risk === "action"
                  ? "진동 조치값 이상입니다. 저진동 공구, 실제 사용 시간 단축 등 관리 조치를 검토하세요."
                  : "입력한 작업의 진동 노출은 조치값 미만입니다. 기록하지 않은 작업이 없는지 확인하세요."}
            </p>
            {!result.noiseComplete && (
              <p className="form-hint">
                소음 데이터가 없는 공구가 포함되어 소음 일일 노출량을 계산할 수
                없습니다.
              </p>
            )}
            {rows.some((a) => a.sample) && (
              <div className="sample-warning">
                <TriangleAlert size={15} />
                예시 데이터가 포함된 계산입니다.
              </div>
            )}
            <p className="form-hint">
              UK HSE 참고 기준 · 입력된 작업만 계산합니다.
            </p>
          </aside>
          <div className="assessment-footer">
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="button secondary"
              type="button"
              onClick={onClose}
            >
              취소
            </button>
            <button className="button primary" type="submit">
              <Check size={16} />
              평가 저장
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function AssessmentPage({
  data,
  onNew,
  onOpen,
}: {
  data: Workspace;
  onNew: () => void;
  onOpen: (a: Assessment) => void;
}) {
  const [query, setQuery] = useState(""),
    [risk, setRisk] = useState("all"),
    [project, setProject] = useState("all");
  const rows = data.assessments
    .filter(
      (a) =>
        a.worker.includes(query) &&
        (project === "all" || a.projectId === project) &&
        (risk === "all" || exposure(a.activities).risk === risk),
    )
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">MEASURE. UNDERSTAND. PROTECT.</div>
          <h1>노출 평가</h1>
          <p>작업자의 하루를 기록하고, 진동과 소음의 누적 노출을 확인하세요.</p>
        </div>
        <div className="heading-actions">
          <button
            className="button secondary"
            disabled={!rows.length}
            onClick={() =>
              download(
                `HAVS-평가-${dateISO()}.csv`,
                reportCSV(rows, data.projects),
                "text/csv;charset=utf-8",
              )
            }
          >
            <Download size={16} />
            CSV 내보내기
          </button>
          <button className="button primary" onClick={onNew}>
            <Plus size={17} />새 노출 평가
          </button>
        </div>
      </div>
      <section className="panel">
        <div className="filter-bar">
          <label className="search-field">
            <Search size={17} />
            <input
              aria-label="작업자 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="작업자 이름 검색"
            />
          </label>
          <select
            aria-label="프로젝트 필터"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="all">전체 프로젝트</option>
            {data.projects.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label="위험 수준 필터"
            value={risk}
            onChange={(e) => setRisk(e.target.value)}
          >
            <option value="all">전체 위험 수준</option>
            {Object.entries(riskLabels).map(([id, label]) => (
              <option value={id} key={id}>
                {label}
              </option>
            ))}
          </select>
          <span className="filter-count">총 {rows.length}건</span>
        </div>
        <AssessmentTable rows={rows} projects={data.projects} onOpen={onOpen} />
      </section>
      <div className="info-banner bottom-info">
        <ClipboardCheck size={18} />
        <p>
          평가에는 저장 당시의 공구 수치가 보관됩니다. 공구 데이터를 변경해도
          이전 평가 결과는 유지됩니다.
        </p>
      </div>
    </>
  );
}

function ProjectForm({
  project,
  onSave,
  onClose,
}: {
  project?: Project;
  onSave: (p: Project) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  return (
    <Modal
      title={project ? "프로젝트 수정" : "새 프로젝트"}
      subtitle="현장 단위로 작업과 평가를 모아보세요."
      onClose={onClose}
    >
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          const name = String(f.get("name")).trim(),
            site = String(f.get("site")).trim(),
            manager = String(f.get("manager")).trim();
          if (!name || !site || !manager) {
            setError("프로젝트명, 현장, 담당자를 입력해 주세요.");
            return;
          }
          onSave({
            id: project?.id ?? crypto.randomUUID(),
            name,
            site,
            manager,
          });
        }}
      >
        <label>
          프로젝트명
          <input
            required
            name="name"
            maxLength={100}
            defaultValue={project?.name}
            placeholder="예: 성수 업무시설 리모델링"
          />
        </label>
        <div className="form-grid">
          <label>
            현장 · 위치
            <input
              name="site"
              required
              maxLength={100}
              defaultValue={project?.site}
              placeholder="예: 서울 성동구"
            />
          </label>
          <label>
            담당자
            <input
              name="manager"
              required
              maxLength={60}
              defaultValue={project?.manager}
              placeholder="담당자 이름"
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="button primary">
            프로젝트 저장
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectsPage({
  data,
  onSave,
  onReport,
}: {
  data: Workspace;
  onSave: (p: Project) => void;
  onReport: (p: Project) => void;
}) {
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">A SAFER SITE, TOGETHER</div>
          <h1>프로젝트</h1>
          <p>현장별 평가를 모아 위험 관리 현황과 보고서를 확인하세요.</p>
        </div>
        <button className="button primary" onClick={() => setEditing("new")}>
          <Plus size={17} />
          프로젝트 만들기
        </button>
      </div>
      <div className="project-grid">
        {data.projects.map((p, i) => {
          const rows = data.assessments.filter((a) => a.projectId === p.id);
          const attention = rows.filter(
            (a) => exposure(a.activities).risk !== "low",
          ).length;
          return (
            <section className="panel project-card" key={p.id}>
              <div className="project-card-top">
                <span className={`project-icon color-${i % 3}`}>
                  <FolderKanban size={24} />
                </span>
                <button
                  className="icon-button"
                  aria-label={`${p.name} 수정`}
                  onClick={() => setEditing(p)}
                >
                  <Pencil size={17} />
                </button>
              </div>
              <span className="project-site">{p.site}</span>
              <h2>{p.name}</h2>
              <p className="project-manager">
                <span className="avatar small">{p.manager.slice(0, 1)}</span>
                담당자 · {p.manager}
              </p>
              <div className="project-stats">
                <div>
                  <span>평가 기록</span>
                  <strong>
                    {rows.length}
                    <small>건</small>
                  </strong>
                </div>
                <div>
                  <span>관리 필요</span>
                  <strong className={attention ? "orange-text" : ""}>
                    {attention}
                    <small>건</small>
                  </strong>
                </div>
                <div>
                  <span>작업자</span>
                  <strong>
                    {new Set(rows.map((a) => a.worker)).size}
                    <small>명</small>
                  </strong>
                </div>
              </div>
              <button className="project-report" onClick={() => onReport(p)}>
                <FileText size={16} />
                프로젝트 보고서
                <ArrowRight size={17} />
              </button>
            </section>
          );
        })}
      </div>
      {!data.projects.length && (
        <section className="panel">
          <Empty title="첫 프로젝트를 만들어 보세요">
            현장과 담당자를 등록하고 작업자의 평가를 관리할 수 있습니다.
          </Empty>
        </section>
      )}
      {editing && (
        <ProjectForm
          project={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={(p) => {
            onSave(p);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function Report({
  assessment,
  project,
  data,
  onClose,
  onEdit,
  onDelete,
}: {
  assessment?: Assessment;
  project?: Project;
  data: Workspace;
  onClose: () => void;
  onEdit: (a: Assessment) => void;
  onDelete: (a: Assessment) => void;
}) {
  const rows = assessment
    ? [assessment]
    : data.assessments
        .filter((a) => a.projectId === project?.id)
        .sort((a, b) => b.date.localeCompare(a.date));
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const visible = rows.filter(
    (a) => (!from || a.date >= from) && (!to || a.date <= to),
  );
  return (
    <Modal
      wide
      title={assessment ? "일일 노출 평가 보고서" : "프로젝트 위험 관리 보고서"}
      subtitle={
        assessment
          ? `${assessment.worker} · ${dateLabel(assessment.date)}`
          : `${project?.name} · ${project?.site}`
      }
      onClose={onClose}
    >
      <div className="report-toolbar">
        <span>
          <ShieldCheck size={17} /> HAVS / EXPOSURE REPORT
        </span>
        <div>
          {assessment && (
            <button
              className="button secondary"
              onClick={() => onEdit(assessment)}
            >
              <Pencil size={15} />
              수정
            </button>
          )}
          <button
            className="button secondary"
            disabled={!visible.length}
            onClick={() =>
              download(
                `HAVS-${assessment?.worker ?? project?.name}-${dateISO()}.csv`,
                reportCSV(visible, data.projects),
                "text/csv;charset=utf-8",
              )
            }
          >
            <Download size={15} />
            CSV
          </button>
          <button
            className="button primary"
            disabled={!visible.length}
            onClick={() => window.print()}
          >
            <FileText size={15} />
            인쇄 / PDF
          </button>
        </div>
      </div>
      {!assessment && (
        <div className="report-date-range">
          <label>
            시작일
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              max={to || undefined}
            />
          </label>
          <span>—</span>
          <label>
            종료일
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              min={from || undefined}
            />
          </label>
          <span className="subtle">기간 내 {visible.length}건</span>
        </div>
      )}
      <div className="report-content">
        {visible.length === 0 && (
          <Empty title="선택한 기간에 평가 기록이 없습니다">
            프로젝트에 평가를 등록하거나 조회 기간을 변경하세요.
          </Empty>
        )}
        {visible.map((a) => {
          const e = exposure(a.activities);
          return (
            <article className="report-record" key={a.id}>
              <div className="report-title">
                <div>
                  <span className="eyebrow">DAILY EXPOSURE ASSESSMENT</span>
                  <h3>
                    {a.worker}
                    <small>
                      {data.projects.find((p) => p.id === a.projectId)?.name} ·{" "}
                      {dateLabel(a.date)}
                    </small>
                  </h3>
                </div>
                <Badge risk={e.risk} />
              </div>
              {a.activities.some((row) => row.sample) && (
                <div className="sample-report">
                  예시 데이터가 포함되어 있습니다. 실제 작업 승인이나 안전
                  판정에 사용할 수 없습니다.
                </div>
              )}
              <div className="report-metrics">
                <div>
                  <span>진동 A(8)</span>
                  <strong>
                    {e.a8.toFixed(2)}
                    <small> m/s²</small>
                  </strong>
                </div>
                <div>
                  <span>노출 점수</span>
                  <strong>
                    {e.points.toFixed(1)}
                    <small> 점</small>
                  </strong>
                </div>
                <div>
                  <span>소음 LEX,8h</span>
                  <strong>
                    {e.noise?.toFixed(1) ?? "미산출"}
                    <small>{e.noise !== null ? " dB(A)" : ""}</small>
                  </strong>
                </div>
                <div>
                  <span>총 사용 시간</span>
                  <strong className="duration-result">
                    {duration(e.minutes)}
                  </strong>
                </div>
              </div>
              <div className="table-scroll">
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>사용 공구</th>
                      <th>진동 (m/s²)</th>
                      <th>소음 (dB(A))</th>
                      <th>시간</th>
                      <th>진동 기여도</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.activities.map((row, i) => (
                      <tr key={row.id}>
                        <td>
                          <strong>{row.toolName}</strong>
                          <small className="cell-small">
                            출처: {row.source}
                          </small>
                        </td>
                        <td>{row.vibration}</td>
                        <td>{row.noise ?? "미입력"}</td>
                        <td>{row.minutes}분</td>
                        <td>{e.contributions[i].toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="report-notes">
                <h4>작업 내용 · 관리 조치</h4>
                <p>{a.notes || "기록된 메모가 없습니다."}</p>
              </div>
              <div className="report-advice">
                <strong>관리 검토 사항</strong>
                <p>
                  {e.risk === "limit"
                    ? "진동 한계값 이상: 작업 계획 변경, 저진동 공구 대체 및 실제 사용 시간 감축을 검토하세요."
                    : e.risk === "action"
                      ? "진동 조치값 이상: 노출 저감 계획, 공구 점검 및 작업자 건강 관리를 검토하세요."
                      : "입력된 작업의 진동 노출은 조치값 미만입니다. 하루의 모든 작업과 데이터의 대표성을 확인하세요."}
                </p>
                <p>
                  {e.noise === null
                    ? "일부 공구의 소음값이 없어 소음 일일 노출량을 산출하지 않았습니다."
                    : e.noise >= 85
                      ? "소음 상위 조치값 85 dB(A) 이상: 소음원 저감과 청력 보호 대책이 필요합니다."
                      : e.noise >= 80
                        ? "소음 하위 조치값 80 dB(A) 이상: 소음 관리 및 청력 보호 안내를 검토하세요."
                        : "입력된 작업의 소음 일일 노출량은 하위 조치값 80 dB(A) 미만입니다."}
                </p>
              </div>
            </article>
          );
        })}
        <div className="report-disclaimer">
          UK HSE 참고 기준. 진동 조치값 2.5 m/s² / 한계값 5 m/s². 소음 조치값
          80·85 dB(A). 소음은 보호구 감쇠, 피크 소음 및 미입력 작업을 반영하지
          않으므로 법적 준수 여부를 판정하지 않습니다. 평가별 계산이며 서로 다른
          작업자의 노출을 합산하지 않습니다.
        </div>
        {assessment && (
          <button
            className="text-button danger delete-assessment"
            onClick={() => {
              if (confirm("이 평가를 삭제할까요? 삭제 후 복구할 수 없습니다."))
                onDelete(assessment);
            }}
          >
            <Trash2 size={15} />
            평가 삭제
          </button>
        )}
      </div>
    </Modal>
  );
}

function GuidePage({
  data,
  replace,
  notify,
  cloud,
}: {
  data: Workspace;
  replace: (data: Workspace) => void;
  notify: (message: string) => void;
  cloud: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState("");
  async function importFile(file?: File) {
    if (!file) return;
    setImportError("");
    try {
      if (file.size > (cloud ? 2_000_000 : 5_000_000))
        throw new Error(`백업 파일은 ${cloud ? 2 : 5}MB 이하여야 합니다.`);
      const value: unknown = JSON.parse(await file.text());
      if (!isWorkspace(value))
        throw new Error(
          "지원하는 HAVS 백업 형식이 아닙니다. 원래 내보낸 JSON 파일을 선택하세요.",
        );
      if (
        !confirm(
          "현재 작업 공간을 백업 파일의 내용으로 교체할까요? 먼저 현재 데이터를 백업하는 것을 권장합니다.",
        )
      )
        return;
      replace(value);
      notify("백업 데이터를 복원했습니다.");
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "백업을 읽을 수 없습니다.",
      );
    }
    if (input.current) input.current.value = "";
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">KNOWLEDGE MAKES A DIFFERENCE</div>
          <h1>가이드 · 평가 기준</h1>
          <p>
            정확하게 기록하고, 계산의 의미를 이해하고, 데이터를 안전하게
            보관하세요.
          </p>
        </div>
      </div>
      <div className="guide-grid">
        <section className="panel guide-card">
          <span className="guide-icon">
            <Waves size={25} />
          </span>
          <h2>손·팔 진동의 일일 노출량</h2>
          <p>
            실제 공구 작동 시간(트리거 시간)을 기준으로 여러 작업의 진동
            에너지를 합산합니다. 쉬는 시간은 사용 시간에 포함하지 않습니다.
          </p>
          <code>A(8) = √[Σ(aᵢ² × Tᵢ) / 480]</code>
          <p className="subtle">a: 진동 합성값(m/s²), T: 실제 사용 시간(분)</p>
          <div className="threshold-row">
            <Badge risk="low" />
            <span>2.5 m/s² 미만</span>
          </div>
          <div className="threshold-row">
            <Badge risk="action" />
            <span>2.5 이상 ~ 5 미만</span>
          </div>
          <div className="threshold-row">
            <Badge risk="limit" />
            <span>5 m/s² 이상</span>
          </div>
          <p>
            노출 점수 = 100 × (A(8) / 2.5)². 100점은 조치값, 400점은
            한계값입니다. 휴식을 추가한다고 이미 발생한 노출이 사라지지는
            않습니다.
          </p>
          <a
            className="external-link"
            href="https://www.hse.gov.uk/vibration/hav/readyreckoner.htm"
            target="_blank"
            rel="noreferrer"
          >
            HSE 진동 노출 계산 기준 <ArrowUpRight size={15} />
          </a>
        </section>
        <section className="panel guide-card">
          <span className="guide-icon noise">
            <AudioLines size={25} />
          </span>
          <h2>소음의 일일 노출량</h2>
          <p>
            공구별 작업 중 LAeq와 사용 시간으로 8시간 기준 소음 노출을
            계산합니다. 하나라도 소음값이 없으면 결과를 산출하지 않습니다.
          </p>
          <code>LEX,8h = 10 log₁₀[Σ(Tᵢ/480 × 10^(Lᵢ/10))]</code>
          <div className="threshold-row">
            <span>하위 노출 조치값</span>
            <strong>80 dB(A)</strong>
          </div>
          <div className="threshold-row">
            <span>상위 노출 조치값</span>
            <strong>85 dB(A)</strong>
          </div>
          <p>
            참고 화면의 청력 보호구 데이터베이스와 감쇠 계산은 이 버전에
            포함하지 않았습니다. 보호구 감쇠와 피크 소음을 고려해야 하는 87
            dB(A) 법적 한계 준수 판정도 제공하지 않습니다.
          </p>
          <a
            className="external-link"
            href="https://www.hse.gov.uk/noise/regulations.htm"
            target="_blank"
            rel="noreferrer"
          >
            HSE 소음 관리 기준 <ArrowUpRight size={15} />
          </a>
        </section>
      </div>
      <section className="panel guide-card data-management">
        <div>
          <span className="eyebrow">YOUR DATA, YOUR WORKSPACE</span>
          <h2>데이터 백업 · 복원</h2>
          <p>
            {cloud
              ? "기록은 로그인한 계정의 서버 작업 공간에 저장됩니다. 다른 기기에서 로그인하면 저장된 기록을 불러옵니다. 정기적으로 JSON 백업도 보관하세요."
              : "예시 모드는 현재 브라우저에 데이터를 저장합니다. 다른 기기와 동기화되지 않으며 브라우저 데이터를 삭제하면 기록도 삭제됩니다. 정기적으로 JSON 백업을 보관하세요."}
          </p>
          <div className="data-counts">
            <span>
              공구 <strong>{data.tools.length}</strong>
            </span>
            <span>
              평가 <strong>{data.assessments.length}</strong>
            </span>
            <span>
              프로젝트 <strong>{data.projects.length}</strong>
            </span>
          </div>
        </div>
        <div className="backup-actions">
          <button
            className="button primary"
            onClick={() =>
              download(
                `HAVS-backup-${dateISO()}.json`,
                JSON.stringify(data, null, 2),
                "application/json",
              )
            }
          >
            <Download size={16} />
            전체 데이터 백업
          </button>
          <button
            className="button secondary"
            onClick={() => input.current?.click()}
          >
            <Upload size={16} />
            JSON 백업 복원
          </button>
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
          <button
            className="text-button danger"
            onClick={() => {
              if (
                confirm(
                  "모든 공구, 프로젝트, 평가를 지우고 빈 작업 공간으로 시작할까요? 먼저 백업을 보관하세요.",
                )
              ) {
                replace({
                  version: 1,
                  tools: [],
                  projects: [],
                  assessments: [],
                });
                notify(
                  "빈 작업 공간을 만들었습니다. 프로젝트와 공구를 등록해 주세요.",
                );
              }
            }}
          >
            새 작업 공간으로 시작
          </button>
        </div>
        {importError && (
          <p role="alert" className="form-error">
            {importError}
          </p>
        )}
      </section>
      <div className="info-banner">
        <BookOpen size={20} />
        <p>
          이 계산은 영국 HSE의 참고 기준을 사용합니다. 실제 평가에는 해당 지역
          법령, 대표성 있는 측정 데이터, 작업 조건과 전문적인 검토가 필요합니다.
        </p>
      </div>
    </>
  );
}

export default function App({
  connection,
  onExit,
  accountError,
}: {
  connection?: Connection;
  onExit?: () => Promise<boolean>;
  accountError?: string;
}) {
  const { data, setData, warning, replace, status, flush, reload, hasPending } =
    useWorkspace(connection);
  const [leaving, setLeaving] = useState(false);
  const backup = () =>
    download(
      `HAVS-backup-${dateISO()}.json`,
      JSON.stringify(data, null, 2),
      "application/json",
    );
  async function exitWorkspace() {
    if (!onExit || leaving) return;
    setLeaving(true);
    if (connection) await flush();
    if (
      connection &&
      hasPending() &&
      !confirm(
        "저장되지 않은 변경이 있습니다. JSON 백업을 받지 않았다면 취소하고 먼저 백업하세요. 그래도 로그아웃할까요?",
      )
    ) {
      setLeaving(false);
      return;
    }
    await onExit();
    setLeaving(false);
  }
  const syncLabel = {
    local: "브라우저에 저장",
    saved: "서버에 저장됨",
    saving: "서버 저장 중…",
    error: "서버 저장 실패",
    conflict: "다른 기기의 변경 확인 필요",
    expired: "다시 로그인 필요",
  }[status];
  const [view, setView] = useState<View>("dashboard");
  const [menuOpen, setMenuOpen] = useState(false);
  const [assessmentForm, setAssessmentForm] = useState<
    Assessment | "new" | null
  >(null);
  const [report, setReport] = useState<{
    assessment?: Assessment;
    project?: Project;
  } | null>(null);
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const selectView = (next: View) => {
    setView(next);
    setMenuOpen(false);
    window.scrollTo({ top: 0 });
  };
  const saveTool = (tool: Tool) => {
    setData((old) => ({
      ...old,
      tools: old.tools.some((t) => t.id === tool.id)
        ? old.tools.map((t) => (t.id === tool.id ? tool : t))
        : [...old.tools, tool],
    }));
    setToast(
      connection ? "공구 정보를 변경했습니다." : "공구 정보를 저장했습니다.",
    );
  };
  const saveProject = (project: Project) => {
    setData((old) => ({
      ...old,
      projects: old.projects.some((p) => p.id === project.id)
        ? old.projects.map((p) => (p.id === project.id ? project : p))
        : [...old.projects, project],
    }));
    setToast(
      connection ? "프로젝트를 기록했습니다." : "프로젝트를 저장했습니다.",
    );
  };
  const saveAssessment = (assessment: Assessment) => {
    setData((old) => ({
      ...old,
      assessments: old.assessments.some((a) => a.id === assessment.id)
        ? old.assessments.map((a) => (a.id === assessment.id ? assessment : a))
        : [assessment, ...old.assessments],
    }));
    setAssessmentForm(null);
    setReport({ assessment });
    setToast(
      connection ? "노출 평가를 기록했습니다." : "노출 평가를 저장했습니다.",
    );
  };
  const page = navigation.find((item) => item.id === view)!;
  return (
    <>
      <div className="app-shell" inert={leaving} aria-busy={leaving}>
        {menuOpen && (
          <button
            className="sidebar-backdrop"
            aria-label="메뉴 닫기"
            onClick={() => setMenuOpen(false)}
          />
        )}
        <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
          <button
            className="brand"
            onClick={() => selectView("dashboard")}
            aria-label="HAVS 대시보드"
          >
            <span className="brand-mark">
              <AudioLines size={27} strokeWidth={2.2} />
            </span>
            <span>
              HAVS<span className="brand-dot">.</span>
              <small>WORKPLACE INTELLIGENCE</small>
            </span>
          </button>
          <div className="workspace-picker">
            <span className="workspace-icon">
              <HardHat size={19} />
            </span>
            <div>
              <strong>
                {connection
                  ? `${connection.user.name}님의 작업 공간`
                  : "안전관리 작업 공간"}
              </strong>
              <small>
                {connection ? "Personal workspace" : "Demo workspace"}
              </small>
            </div>
            <span className="workspace-status" />
          </div>
          <span className="nav-caption">WORKSPACE</span>
          <nav aria-label="주 메뉴">
            {navigation.map(({ id, title, icon: Icon }) => (
              <button
                key={id}
                className={`nav-item ${view === id ? "selected" : ""}`}
                onClick={() => selectView(id)}
                aria-current={view === id ? "page" : undefined}
              >
                <Icon size={19} />
                <span>{title}</span>
                {id === "tools" && (
                  <span className="nav-count">{data.tools.length}</span>
                )}
                {id === "dashboard" && view === id && (
                  <span className="selected-dot" />
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-tip">
              <span className="tip-icon">
                <ShieldCheck size={22} />
              </span>
              <strong>더 안전한 내일을 위해</strong>
              <p>
                공구를 이해하는 것이
                <br />
                위험 관리의 첫걸음입니다.
              </p>
              <button onClick={() => selectView("guide")}>
                평가 기준 알아보기 <ArrowUpRight size={16} />
              </button>
            </div>
            <div className="local-storage-note">
              <span />
              <div>
                {connection ? "계정별 서버 보관" : "예시 모드 · 브라우저 저장"}
                <small>가이드에서 데이터를 백업하세요</small>
              </div>
            </div>
            <div className="sidebar-version">
              HAVS WORKSPACE <span>v0.2</span>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="icon-button mobile-menu"
                aria-label="메뉴 열기"
                onClick={() => setMenuOpen(true)}
              >
                <Menu size={21} />
              </button>
              <span>내 작업 공간</span>
              <ChevronRight size={14} />
              <strong>{page.title}</strong>
            </div>
            <div className="topbar-actions">
              <span className="today-date">
                <span />
                {new Intl.DateTimeFormat("ko-KR", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                  weekday: "short",
                  timeZone: "Asia/Seoul",
                }).format(new Date())}
              </span>
              <button
                className="icon-button backup-button"
                aria-label="전체 데이터 JSON 백업"
                title="전체 데이터 백업"
                onClick={() =>
                  download(
                    `HAVS-backup-${dateISO()}.json`,
                    JSON.stringify(data, null, 2),
                    "application/json",
                  )
                }
              >
                <ArrowDownToLine size={18} />
              </button>
              <span className="topbar-divider" />
              <span
                className="profile-avatar"
                title={connection?.user.email || "예시 작업 공간"}
              >
                {connection?.user.name.slice(0, 2) || "ME"}
              </span>
              {onExit && (
                <button
                  className="account-exit"
                  disabled={leaving}
                  onClick={() => void exitWorkspace()}
                >
                  <LogOut size={16} />
                  {leaving ? "확인 중…" : connection ? "로그아웃" : "로그인"}
                </button>
              )}
            </div>
          </header>
          <main id="main-content">
            {connection && (
              <div className="remote-account-bar">
                <span className="account-caption">{connection.user.email}</span>
                <span className={`sync-label ${status}`} role="status">
                  <span />
                  {syncLabel}
                </span>
              </div>
            )}
            {(warning || accountError) && (
              <div className="storage-warning" role="alert">
                <TriangleAlert size={19} />
                <span>{warning || accountError}</span>
                <div className="sync-actions">
                  <button onClick={backup}>JSON 백업</button>
                  {connection && status === "error" && (
                    <button onClick={() => void flush()}>다시 저장</button>
                  )}
                  {connection && status === "conflict" && (
                    <button onClick={() => void reload()}>
                      서버 기록 다시 불러오기
                    </button>
                  )}
                  {connection && status === "expired" && (
                    <button
                      disabled={leaving}
                      onClick={() => void exitWorkspace()}
                    >
                      다시 로그인
                    </button>
                  )}
                  {!connection && (
                    <button onClick={() => selectView("guide")}>
                      데이터 관리
                    </button>
                  )}
                </div>
              </div>
            )}
            {view === "dashboard" && (
              <Dashboard
                data={data}
                selectView={selectView}
                onNew={() => setAssessmentForm("new")}
                onOpen={(assessment) => setReport({ assessment })}
              />
            )}
            {view === "tools" && (
              <ToolsPage
                data={data}
                onSave={saveTool}
                onDelete={(id) => {
                  setData((old) => ({
                    ...old,
                    tools: old.tools.filter((t) => t.id !== id),
                  }));
                  setToast("공구를 삭제했습니다. 이전 평가 기록은 보존됩니다.");
                }}
              />
            )}
            {view === "assessments" && (
              <AssessmentPage
                data={data}
                onNew={() => setAssessmentForm("new")}
                onOpen={(assessment) => setReport({ assessment })}
              />
            )}
            {view === "projects" && (
              <ProjectsPage
                data={data}
                onSave={saveProject}
                onReport={(project) => setReport({ project })}
              />
            )}
            {view === "guide" && (
              <GuidePage
                data={data}
                replace={replace}
                notify={setToast}
                cloud={!!connection}
              />
            )}
            <footer className="page-footer">
              <span>
                HAVS<span className="brand-dot">.</span>{" "}
                <span>작은 기록, 더 안전한 현장.</span>
              </span>
              <span>
                UK HSE 참고 기준 <span className="footer-dot">·</span>{" "}
                {connection ? "계정별 서버 저장" : "예시 · 브라우저 저장"}
              </span>
            </footer>
          </main>
        </div>
        {assessmentForm && (
          <AssessmentForm
            data={data}
            assessment={assessmentForm === "new" ? undefined : assessmentForm}
            onSave={saveAssessment}
            onClose={() => setAssessmentForm(null)}
          />
        )}
        {report && (
          <Report
            {...report}
            data={data}
            onClose={() => setReport(null)}
            onEdit={(assessment) => {
              setReport(null);
              setAssessmentForm(assessment);
            }}
            onDelete={(assessment) => {
              setData((old) => ({
                ...old,
                assessments: old.assessments.filter(
                  (a) => a.id !== assessment.id,
                ),
              }));
              setReport(null);
              setToast("평가 기록을 삭제했습니다.");
            }}
          />
        )}
        {toast && (
          <div className="toast" role="status">
            <CheckCircle2 size={18} />
            {toast}
            <button
              className="icon-button"
              aria-label="알림 닫기"
              onClick={() => setToast("")}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
      {leaving && (
        <div className="account-leaving" role="status">
          저장 상태와 로그인을 확인하고 있습니다…
        </div>
      )}
    </>
  );
}
