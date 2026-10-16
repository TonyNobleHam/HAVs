import test from "node:test";
import assert from "node:assert/strict";
import {
  exposure,
  timeToThreshold,
  vibrationRisk,
  csvCell,
  reportCSV,
  isWorkspace,
} from "../src/domain.ts";
import type { Workspace } from "../src/domain.ts";

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const row = (
  vibration: number,
  minutes: number,
  noise: number | null = 85,
) => ({ vibration, minutes, noise });

test("8-hour action value is 2.5 m/s² and exactly 100 points", () => {
  const result = exposure([row(2.5, 480)]);
  close(result.a8, 2.5);
  close(result.points, 100);
  assert.equal(result.risk, "action");
});
test("8-hour limit value is 5 m/s² and exactly 400 points", () => {
  const result = exposure([row(5, 480)]);
  close(result.a8, 5);
  close(result.points, 400);
  assert.equal(result.risk, "limit");
});
test("multiple tools combine vibration energy, not arithmetic averages", () => {
  const result = exposure([row(10, 60), row(5, 120)]);
  close(result.a8, Math.sqrt(18.75));
  close(result.points, 300);
  close(result.contributions[0], 200 / 3);
  close(result.contributions[1], 100 / 3);
  assert.equal(result.minutes, 180);
});
test("zero duration has no exposure, contributions or noise result", () => {
  const result = exposure([row(15, 0)]);
  assert.equal(result.a8, 0);
  assert.equal(result.points, 0);
  assert.equal(result.noise, null);
  assert.deepEqual(result.contributions, [0]);
  assert.equal(exposure([]).noise, null);
});
test("noise energy is normalized to eight hours", () => {
  close(exposure([row(0, 480, 85)]).noise!, 85);
  close(exposure([row(0, 240, 85)]).noise!, 81.98970004336019);
  close(exposure([row(0, 240, 85), row(0, 240, 95)]).noise!, 92.40362689494245);
});
test("missing active noise is unknown, not zero or an underestimated partial result", () => {
  const result = exposure([row(4, 60, 90), row(4, 60, null)]);
  assert.equal(result.noise, null);
  assert.equal(result.noiseComplete, false);
  assert.notEqual(exposure([row(4, 60, 90), row(4, 0, null)]).noise, null);
});
test("invalid and non-finite inputs are rejected", () => {
  for (const bad of [
    row(-1, 60),
    row(1, -60),
    row(NaN, 60),
    row(1, Infinity),
    row(1, 60, NaN),
  ]) {
    assert.throws(() => exposure([bad]));
  }
});
test("boundaries use unrounded values", () => {
  assert.equal(vibrationRisk(2.49999), "low");
  assert.equal(vibrationRisk(2.5), "action");
  assert.equal(vibrationRisk(4.99999), "action");
  assert.equal(vibrationRisk(5), "limit");
});
test("single-tool time to action/limit", () => {
  close(timeToThreshold(10, 2.5), 30);
  close(timeToThreshold(10, 5), 120);
  assert.equal(timeToThreshold(0, 2.5), Infinity);
});
test("CSV escapes commas, quotes and spreadsheet formula injection", () => {
  assert.equal(csvCell('x,"y"'), '"x,""y"""');
  assert.equal(csvCell("=1+2"), '"\'=1+2"');
  assert.equal(csvCell(" @SUM(A1)"), '"\' @SUM(A1)"');
});

const fixture: Workspace = {
  version: 1,
  tools: [
    {
      id: "t1",
      name: "Test drill",
      model: "D1",
      category: "기타",
      vibration: 5,
      noise: null,
      source: "Measured",
      inspectionDue: "2026-10-16",
      sample: false,
    },
  ],
  projects: [
    { id: "p1", name: "Test project", site: "Site", manager: "Manager" },
  ],
  assessments: [
    {
      id: "a1",
      worker: "Worker",
      projectId: "p1",
      date: "2026-10-16",
      notes: "=1+1",
      createdAt: "2026-10-16T09:00:00Z",
      activities: [
        {
          id: "r1",
          toolId: "t1",
          toolName: "Test drill",
          vibration: 5,
          noise: null,
          source: "Measured",
          sample: false,
          minutes: 120,
        },
      ],
    },
  ],
};
test("CSV contains one activity per row, calculated daily values and noise completeness", () => {
  const csv = reportCSV(fixture.assessments, fixture.projects);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.equal(csv.split("\r\n").length, 2);
  assert.ok(csv.includes('"2.500","100.00","소음 데이터 불완전","관리 필요"'));
  assert.ok(csv.includes('"\'=1+1"'));
});
test("backup schema accepts intact historical snapshots even after a tool is removed", () => {
  assert.equal(isWorkspace(fixture), true);
  assert.equal(isWorkspace({ ...fixture, tools: [] }), true);
});
test("backup schema rejects malformed data, duplicate ids, orphan projects and impossible duration", () => {
  assert.equal(isWorkspace(null), false);
  assert.equal(
    isWorkspace({ version: 1, tools: [], assessments: [], projects: [] }),
    true,
  );
  assert.equal(
    isWorkspace({
      ...fixture,
      tools: [{ ...fixture.tools[0], vibration: "five" }],
    }),
    false,
  );
  assert.equal(
    isWorkspace({ ...fixture, tools: [fixture.tools[0], fixture.tools[0]] }),
    false,
  );
  assert.equal(isWorkspace({ ...fixture, projects: [] }), false);
  const bad = structuredClone(fixture);
  bad.assessments[0].activities[0].minutes = 1500;
  assert.equal(isWorkspace(bad), false);
});

test("backup rejects impossible dates and values beyond supported input bounds", () => {
  const impossibleDate = structuredClone(fixture);
  impossibleDate.tools[0].inspectionDue = "2026-02-31";
  assert.equal(isWorkspace(impossibleDate), false);
  const excessive = structuredClone(fixture);
  excessive.tools[0].vibration = 1e300;
  assert.equal(isWorkspace(excessive), false);
  const duplicateActivity = structuredClone(fixture);
  duplicateActivity.assessments[0].activities.push(
    duplicateActivity.assessments[0].activities[0],
  );
  assert.equal(isWorkspace(duplicateActivity), false);
});
