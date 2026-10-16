import { dateISO, snapshot } from "./domain";
import type { Workspace, Tool, Project, Assessment } from "./domain";

export function createSeed(): Workspace {
  const tools: Tool[] = [
    {
      id: "t1",
      name: "앵글 그라인더",
      model: "AG-125",
      category: "연삭·절단",
      vibration: 6.2,
      noise: 92,
      inspectionDue: dateISO(20),
    },
    {
      id: "t2",
      name: "로터리 해머 드릴",
      model: "RH-28",
      category: "천공·파쇄",
      vibration: 12.5,
      noise: 98,
      inspectionDue: dateISO(-3),
    },
    {
      id: "t3",
      name: "임팩트 렌치",
      model: "IW-18",
      category: "체결",
      vibration: 4.5,
      noise: 88,
      inspectionDue: dateISO(8),
    },
    {
      id: "t4",
      name: "오비탈 샌더",
      model: "OS-150",
      category: "연삭·절단",
      vibration: 3.2,
      noise: 81,
      inspectionDue: dateISO(40),
    },
    {
      id: "t5",
      name: "왕복 톱",
      model: "RS-20",
      category: "연삭·절단",
      vibration: 8.4,
      noise: 94,
      inspectionDue: dateISO(5),
    },
    {
      id: "t6",
      name: "콘크리트 브레이커",
      model: "CB-16",
      category: "천공·파쇄",
      vibration: 15.0,
      noise: 103,
      inspectionDue: dateISO(25),
    },
    {
      id: "t7",
      name: "충전 드릴",
      model: "CD-18",
      category: "천공·파쇄",
      vibration: 2.1,
      noise: 77,
      inspectionDue: dateISO(55),
    },
    {
      id: "t8",
      name: "예초기",
      model: "BC-35",
      category: "조경",
      vibration: 5.6,
      noise: 96,
      inspectionDue: dateISO(-1),
    },
  ].map((t) => ({
    ...t,
    source: "기능 확인용 가상 데이터 · 실제 공구 측정값 아님",
    sample: true,
  }));
  const projects: Project[] = [
    {
      id: "p1",
      name: "성수 업무시설 리모델링",
      site: "서울 · 성수 현장",
      manager: "김현우",
    },
    {
      id: "p2",
      name: "판교 연구동 유지보수",
      site: "경기 · 판교 현장",
      manager: "박지민",
    },
    {
      id: "p3",
      name: "한강공원 녹지 관리",
      site: "서울 · 여의도 현장",
      manager: "이서준",
    },
  ];
  const configs: [string, string, number, [number, number][]][] = [
    [
      "김민수",
      "p1",
      0,
      [
        [0, 90],
        [2, 45],
      ],
    ],
    [
      "이정호",
      "p1",
      0,
      [
        [1, 100],
        [0, 30],
      ],
    ],
    [
      "박서연",
      "p2",
      0,
      [
        [3, 80],
        [6, 45],
      ],
    ],
    ["최준혁", "p2", 0, [[4, 40]]],
    ["정하늘", "p3", -1, [[7, 90]]],
    ["김민수", "p1", -1, [[0, 120]]],
    ["이정호", "p1", -2, [[5, 65]]],
    ["박서연", "p2", -3, [[3, 150]]],
    ["최준혁", "p2", -4, [[2, 75]]],
    ["정하늘", "p3", -5, [[7, 60]]],
    [
      "김민수",
      "p1",
      -6,
      [
        [0, 60],
        [2, 30],
      ],
    ],
    ["이정호", "p1", -6, [[1, 40]]],
  ];
  const assessments: Assessment[] = configs.map(
    ([worker, projectId, offset, items], index) => ({
      id: `a${index + 1}`,
      worker,
      projectId,
      date: dateISO(offset),
      activities: items.map(([i, mins]) => snapshot(tools[i], mins)),
      notes: "기능 확인을 위한 예시 평가입니다.",
      createdAt: `${dateISO(offset)}T09:00:00+09:00`,
    }),
  );
  return { version: 1, tools, projects, assessments };
}
