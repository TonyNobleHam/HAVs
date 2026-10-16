import { test, expect } from "@playwright/test";

test("dashboard, tool search and all navigation work without browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?demo=1");
  await expect(
    page.getByRole("heading", { name: "현장의 위험을, 한눈에." }),
  ).toBeVisible();
  await expect(page.getByText("예시 작업 공간", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "공구 데이터베이스" }).click();
  await page.getByRole("textbox", { name: "공구 검색" }).fill("AG-125");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody")).toContainText("앵글 그라인더");
  await page.getByRole("button", { name: "점검 예정", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "조건에 맞는 공구가 없습니다" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "노출 평가", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(12);
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await expect(page.locator(".project-card")).toHaveCount(3);
  await page.getByRole("button", { name: "가이드 · 기준" }).click();
  await expect(
    page.getByRole("heading", { name: "데이터 백업 · 복원" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("create tool, assess exposure, preserve history, edit and persist across reload", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "공구 데이터베이스" }).click();
  await page.getByRole("button", { name: "공구 등록", exact: true }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("공구명", { exact: true }).fill("검증용 공구");
  await form.getByLabel("제조사 · 모델").fill("TEST-10");
  await form.getByLabel("진동 합성값 (m/s²)").fill("10");
  await form.getByLabel("작업 중 소음 LAeq (dB(A))").fill("85");
  await form.getByLabel("데이터 출처 · 작업 조건").fill("브라우저 검증용 수치");
  await form.getByRole("button", { name: "공구 저장" }).click();
  await page.getByRole("button", { name: "노출 평가", exact: true }).click();
  await page.getByRole("button", { name: "새 노출 평가", exact: true }).click();
  await form.getByLabel("작업자 이름").fill("검증 작업자");
  await form
    .getByRole("combobox", { name: "사용 공구 1", exact: true })
    .selectOption({ label: "검증용 공구 · TEST-10" });
  await form
    .getByRole("spinbutton", { name: "사용 시간 1", exact: true })
    .fill("120");
  await expect(form.locator(".result-value")).toContainText("5.00");
  await expect(form.locator(".badge")).toContainText("한계값 이상");
  await form.getByRole("button", { name: "평가 저장" }).click();
  await expect(
    form.getByRole("heading", { name: "일일 노출 평가 보고서" }),
  ).toBeVisible();
  await expect(form.locator(".report-metrics")).toContainText("5.00");
  await expect(form.locator(".report-metrics")).toContainText("400.0");
  await expect(form.locator(".report-metrics")).toContainText("79.0");
  const downloadPromise = page.waitForEvent("download");
  await form.getByRole("button", { name: "CSV", exact: true }).click();
  const downloaded = await downloadPromise;
  expect(downloaded.suggestedFilename()).toMatch(/HAVS-검증 작업자.*\.csv/);
  await form.getByRole("button", { name: "닫기", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "공구 데이터베이스" }).click();
  await page.getByRole("button", { name: "검증용 공구 수정" }).click();
  await form.getByLabel("진동 합성값 (m/s²)").fill("2");
  await form.getByRole("button", { name: "공구 저장" }).click();
  await page.getByRole("button", { name: "노출 평가", exact: true }).click();
  await page.getByRole("textbox", { name: "작업자 검색" }).fill("검증 작업자");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody")).toContainText("5.00");
  await page
    .getByRole("button", { name: /검증 작업자 .* 보고서 보기/ })
    .click();
  await form.getByRole("button", { name: "수정", exact: true }).click();
  await form
    .getByRole("spinbutton", { name: "사용 시간 1", exact: true })
    .fill("30");
  await expect(form.locator(".result-value")).toContainText("2.50");
  await form.getByRole("button", { name: "평가 저장" }).click();
  await expect(form.locator(".report-metrics")).toContainText("2.50");
});

test("duplicate worker/day is blocked", async ({ page }) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "새 노출 평가", exact: true }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("작업자 이름").fill("김민수");
  await form.getByRole("button", { name: "평가 저장" }).click();
  await expect(form.getByRole("alert")).toContainText(
    "같은 날짜 평가가 이미 있습니다",
  );
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
});

test("project creation, report date filter, JSON export and restore", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await page.getByRole("button", { name: "프로젝트 만들기" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("프로젝트명").fill("테스트 현장");
  await dialog.getByLabel("현장 · 위치").fill("서울");
  await dialog.getByLabel("담당자", { exact: true }).fill("테스트 담당자");
  await dialog.getByRole("button", { name: "프로젝트 저장" }).click();
  await expect(page.locator(".project-card")).toHaveCount(4);
  await page
    .locator(".project-card")
    .first()
    .getByRole("button", { name: "프로젝트 보고서" })
    .click();
  await expect(dialog.locator(".report-record")).toHaveCount(6);
  await dialog.getByLabel("시작일").fill("2099-01-01");
  await expect(
    dialog.getByRole("heading", { name: "선택한 기간에 평가 기록이 없습니다" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "가이드 · 기준" }).click();
  const backup = await page.evaluate(() =>
    localStorage.getItem("havs.workspace.v1"),
  );
  await page.locator("input[type=file]").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  await expect(page.getByRole("alert")).toContainText(
    "지원하는 HAVS 백업 형식",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "새 작업 공간으로 시작" }).click();
  await expect(page.locator(".data-counts")).toContainText("공구 0");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("input[type=file]").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(backup!),
  });
  await expect(page.locator(".data-counts")).toContainText("공구 8");
  await expect(page.locator(".data-counts")).toContainText("프로젝트 4");
});

test("mobile navigation and evaluation form fit the screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demo=1");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.getByRole("button", { name: "노출 평가", exact: true }).click();
  await page.getByRole("button", { name: "새 노출 평가", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.getByLabel("작업자 이름").fill("모바일 작업자");
  await page.getByRole("button", { name: "평가 저장" }).click();
  await expect(
    page.getByRole("heading", { name: "일일 노출 평가 보고서" }),
  ).toBeVisible();
});

test("empty workspace can create a project and tool, assess missing noise and print", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "havs.workspace.v1",
      JSON.stringify({ version: 1, tools: [], projects: [], assessments: [] }),
    ),
  );
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "새 노출 평가", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "공구와 프로젝트를 먼저 등록해 주세요" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await page.getByRole("button", { name: "프로젝트 만들기" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("프로젝트명").fill("첫 현장");
  await dialog.getByLabel("현장 · 위치").fill("서울");
  await dialog.getByLabel("담당자", { exact: true }).fill("담당자");
  await dialog.getByRole("button", { name: "프로젝트 저장" }).click();
  await page.getByRole("button", { name: "공구 데이터베이스" }).click();
  await page.getByRole("button", { name: "공구 등록", exact: true }).click();
  await dialog.getByLabel("공구명", { exact: true }).fill("첫 공구");
  await dialog.getByLabel("제조사 · 모델").fill("ONE");
  await dialog.getByLabel("진동 합성값 (m/s²)").fill("5");
  await dialog.getByLabel("데이터 출처 · 작업 조건").fill("실측 보고서");
  await dialog.getByRole("button", { name: "공구 저장" }).click();
  await page.getByRole("button", { name: "노출 평가", exact: true }).click();
  await page.getByRole("button", { name: "새 노출 평가", exact: true }).click();
  await dialog.getByLabel("작업자 이름").fill("첫 작업자");
  await dialog
    .getByRole("spinbutton", { name: "사용 시간 1", exact: true })
    .fill("120");
  await expect(dialog.locator(".result-value")).toContainText("2.50");
  await expect(dialog.locator(".result-detail").last()).toContainText("미산출");
  await dialog.getByRole("button", { name: "평가 저장" }).click();
  await expect(dialog.locator(".report-metrics")).toContainText("미산출");
  await expect(dialog.locator(".sample-report")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__printed = false;
    window.print = () => {
      (window as any).__printed = true;
    };
  });
  await dialog.getByRole("button", { name: "인쇄 / PDF" }).click();
  expect(await page.evaluate(() => (window as any).__printed)).toBe(true);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(dialog.locator(".report-content")).toBeVisible();
  await expect(dialog.locator(".report-toolbar")).toBeHidden();
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
});

test("malformed stored data remains untouched and shows recovery instructions", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("havs.workspace.v1", "{invalid-json"),
  );
  await page.goto("/?demo=1");
  await expect(page.getByRole("alert")).toContainText(
    "기존 데이터는 덮어쓰지 않습니다",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("havs.workspace.v1")),
  ).toBe("{invalid-json");
  await page.getByRole("button", { name: "데이터 관리", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "데이터 백업 · 복원" }),
  ).toBeVisible();
});
