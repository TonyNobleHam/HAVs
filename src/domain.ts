export type Risk = "low" | "action" | "limit";
export type Tool = {
  id: string;
  name: string;
  model: string;
  category: string;
  vibration: number;
  noise: number | null;
  source: string;
  inspectionDue: string;
  sample: boolean;
};
export type Activity = {
  id: string;
  toolId: string;
  toolName: string;
  vibration: number;
  noise: number | null;
  minutes: number;
  source: string;
  sample: boolean;
};
export type Assessment = {
  id: string;
  worker: string;
  projectId: string;
  date: string;
  activities: Activity[];
  notes: string;
  createdAt: string;
};
export type Project = {
  id: string;
  name: string;
  site: string;
  manager: string;
};
export type Workspace = {
  version: 1;
  tools: Tool[];
  assessments: Assessment[];
  projects: Project[];
};

export function exposure(
  activities: Pick<Activity, "vibration" | "noise" | "minutes">[],
) {
  for (const row of activities) {
    if (
      !Number.isFinite(row.vibration) ||
      row.vibration < 0 ||
      !Number.isFinite(row.minutes) ||
      row.minutes < 0 ||
      (row.noise !== null && (!Number.isFinite(row.noise) || row.noise < 0))
    ) {
      throw new Error("노출 계산에는 0 이상의 유효한 수치가 필요합니다.");
    }
  }
  const active = activities.filter((a) => a.minutes > 0);
  const sum = active.reduce((n, a) => n + a.vibration ** 2 * a.minutes, 0);
  const a8 = Math.sqrt(sum / 480);
  const points = sum / 30;
  const noiseComplete =
    active.length > 0 && active.every((a) => a.noise !== null);
  const noiseEnergy = active.reduce(
    (n, a) =>
      n + (a.noise === null ? 0 : (a.minutes / 480) * 10 ** (a.noise / 10)),
    0,
  );
  const noise =
    noiseComplete && noiseEnergy > 0 ? 10 * Math.log10(noiseEnergy) : null;
  return {
    a8,
    points,
    noise,
    noiseComplete,
    minutes: active.reduce((n, a) => n + a.minutes, 0),
    risk: vibrationRisk(a8),
    contributions: activities.map((a) =>
      sum ? ((a.vibration ** 2 * a.minutes) / sum) * 100 : 0,
    ),
  };
}

// UK Control of Vibration at Work Regulations: daily A(8), not instantaneous vibration.
export function vibrationRisk(a8: number): Risk {
  return a8 >= 5 ? "limit" : a8 >= 2.5 ? "action" : "low";
}

export function timeToThreshold(vibration: number, threshold: 2.5 | 5) {
  return vibration > 0 ? 480 * (threshold / vibration) ** 2 : Infinity;
}

export function duration(minutes: number) {
  if (!Number.isFinite(minutes)) return "해당 없음";
  const rounded = Math.round(minutes);
  return rounded >= 60
    ? `${Math.floor(rounded / 60)}시간${rounded % 60 ? ` ${rounded % 60}분` : ""}`
    : `${rounded}분`;
}

export function dateISO(offset = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(
    date,
  );
}

export function snapshot(tool: Tool, minutes: number): Activity {
  return {
    id: crypto.randomUUID(),
    toolId: tool.id,
    toolName: `${tool.name} · ${tool.model}`,
    vibration: tool.vibration,
    noise: tool.noise,
    source: tool.source,
    sample: tool.sample,
    minutes,
  };
}

export function csvCell(value: string | number) {
  let text = String(value);
  // Prevent spreadsheet formula execution when users enter names/notes beginning with =, +, -, @.
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function reportCSV(assessments: Assessment[], projects: Project[]) {
  const header = [
    "평가일",
    "프로젝트",
    "작업자",
    "공구",
    "진동(m/s²)",
    "소음(dB(A))",
    "트리거 시간(분)",
    "진동 A(8)(m/s²)",
    "노출 점수",
    "소음 LEX,8h(dB(A))",
    "진동 판정",
    "데이터 출처",
    "예시 데이터 포함",
    "메모",
  ];
  const rows = assessments.flatMap((a) => {
    const e = exposure(a.activities);
    return a.activities.map((row) => [
      a.date,
      projects.find((p) => p.id === a.projectId)?.name ?? "",
      a.worker,
      row.toolName,
      row.vibration,
      row.noise ?? "미입력",
      row.minutes,
      e.a8.toFixed(3),
      e.points.toFixed(2),
      e.noise?.toFixed(2) ?? "소음 데이터 불완전",
      riskLabels[e.risk],
      row.source,
      row.sample ? "예" : "아니오",
      a.notes,
    ]);
  });
  return (
    "\uFEFF" +
    [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")
  );
}

export const riskLabels: Record<Risk, string> = {
  low: "조치값 미만",
  action: "관리 필요",
  limit: "한계값 이상",
};

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const nonempty = (v: unknown): v is string => str(v) && v.trim().length > 0;
const validDate = (v: unknown): v is string =>
  str(v) &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
const validTool = (v: unknown): v is Tool =>
  object(v) &&
  ["id", "name", "model", "category", "source"].every((k) => nonempty(v[k])) &&
  num(v.vibration) &&
  v.vibration <= 100 &&
  (v.noise === null || (num(v.noise) && v.noise <= 200)) &&
  validDate(v.inspectionDue) &&
  typeof v.sample === "boolean";
const validActivity = (v: unknown): v is Activity =>
  object(v) &&
  ["id", "toolId", "toolName", "source"].every((k) => nonempty(v[k])) &&
  num(v.vibration) &&
  v.vibration <= 100 &&
  (v.noise === null || (num(v.noise) && v.noise <= 200)) &&
  num(v.minutes) &&
  v.minutes > 0 &&
  v.minutes <= 1440 &&
  typeof v.sample === "boolean";

export function isWorkspace(value: unknown): value is Workspace {
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.tools) ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.assessments)
  )
    return false;
  const projects = value.projects;
  if (!value.tools.every(validTool)) return false;
  if (
    !projects.every(
      (p) =>
        object(p) &&
        ["id", "name", "site", "manager"].every((k) => nonempty(p[k])),
    )
  )
    return false;
  if (
    !value.assessments.every(
      (a) =>
        object(a) &&
        ["id", "worker", "projectId", "createdAt"].every((k) =>
          nonempty(a[k]),
        ) &&
        str(a.notes) &&
        str(a.createdAt) &&
        !Number.isNaN(Date.parse(a.createdAt)) &&
        validDate(a.date) &&
        Array.isArray(a.activities) &&
        a.activities.length > 0 &&
        a.activities.every(validActivity) &&
        new Set(a.activities.map((row: Activity) => row.id)).size ===
          a.activities.length &&
        a.activities.reduce((n: number, row: Activity) => n + row.minutes, 0) <=
          1440 &&
        projects.some((p: Project) => p.id === a.projectId),
    )
  )
    return false;
  return [value.tools, value.projects, value.assessments].every(
    (items) =>
      new Set(items.map((item: { id: string }) => item.id)).size ===
      items.length,
  );
}
