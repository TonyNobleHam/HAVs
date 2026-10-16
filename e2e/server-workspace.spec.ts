import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

type Account = { email: string; name: string; password: string };
type Fixtures = {
  accounts: Record<string, Account>;
  invitation: Account & { code: string };
};
let fixtures: Fixtures;
const baseURL = "http://127.0.0.1:5174";

test.beforeAll(async () => {
  const path = process.env.HAVS_E2E_FIXTURE_FILE;
  if (!path) throw new Error("Use playwright.server.config.ts for the server browser tests.");
  fixtures = JSON.parse(await readFile(path, "utf8"));
});

async function login(page: Page, account: Account) {
  await page.goto("/");
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill(account.password);
  await page.locator("form").getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toBeVisible();
}

async function startEmpty(page: Page) {
  await page.getByRole("button", { name: /^빈 작업 공간으로 시작/ }).click();
  await expectSaved(page);
}

async function expectSaved(page: Page) {
  await expect(page.getByText("서버에 저장됨", { exact: true })).toBeVisible();
}

async function readWorkspace(page: Page) {
  const session = await (await page.request.get("/api/session")).json();
  const response = await page.request.get("/api/workspace", {
    headers: { "X-CSRF-Token": session.csrfToken },
  });
  expect(response.status()).toBe(200);
  return response.json();
}

async function createProject(page: Page, name: string) {
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await page.getByRole("button", { name: "프로젝트 만들기", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("프로젝트명", { exact: true }).fill(name);
  await dialog.getByLabel("현장 · 위치", { exact: true }).fill("검증 현장");
  await dialog.getByLabel("담당자", { exact: true }).fill("검증 담당자");
  await dialog.getByRole("button", { name: "프로젝트 저장", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test("requires login, rejects wrong password, uses an HttpOnly cookie and logs out", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByLabel("이메일", { exact: true })).toBeVisible();
  expect((await page.request.get("/api/workspace")).status()).toBe(401);
  await page.getByLabel("이메일", { exact: true }).fill(fixtures.accounts.login.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("an-invalid-test-password");
  await page.locator("form").getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("이메일 또는 비밀번호");
  await page.getByLabel("비밀번호", { exact: true }).fill(fixtures.accounts.login.password);
  await page.locator("form").getByRole("button", { name: "로그인", exact: true }).click();
  await startEmpty(page);
  const session = (await context.cookies()).find((cookie) => cookie.name === "havs_session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Strict");
  expect(await page.evaluate(() => document.cookie)).not.toContain("havs_session");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(session!.value);
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByLabel("이메일", { exact: true })).toBeVisible();
  expect((await page.request.get("/api/workspace")).status()).toBe(401);
  await page.reload();
  await expect(page.getByLabel("이메일", { exact: true })).toBeVisible();
});

test("registers with an invitation and only creates demo data after explicit selection", async ({ page }) => {
  const invitation = fixtures.invitation;
  await page.goto("/");
  await page.getByRole("button", { name: "초대로 가입", exact: true }).click();
  await page.getByLabel("이름", { exact: true }).fill(invitation.name);
  await page.getByLabel("이메일", { exact: true }).fill(invitation.email);
  await page.getByLabel("비밀번호 (12자 이상)", { exact: true }).fill(invitation.password);
  await page.getByLabel("초대 코드", { exact: true }).fill("invalid-invitation");
  await page.getByRole("button", { name: "계정 만들기", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("가입 정보");
  await page.getByLabel("초대 코드", { exact: true }).fill(invitation.code);
  await page.getByRole("button", { name: "계정 만들기", exact: true }).click();
  await expect(page.getByRole("button", { name: /^빈 작업 공간으로 시작/ })).toBeVisible();
  expect(await readWorkspace(page)).toEqual({ workspace: null, revision: 0 });
  await page.getByRole("button", { name: /^예시 데이터로 시작/ }).click();
  await expectSaved(page);
  const result = await readWorkspace(page);
  expect(result.workspace.tools).toHaveLength(8);
  expect(result.workspace.tools.every((tool: { sample: boolean }) => tool.sample)).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^공구 데이터베이스/ }).click();
  await expect(page.locator("tbody tr")).toHaveCount(8);
});

test("saves tools and assessments across independent browser sessions and isolates other accounts", async ({ page, browser }) => {
  await login(page, fixtures.accounts.persistence);
  await startEmpty(page);
  await createProject(page, "계정 전용 프로젝트");
  await expectSaved(page);
  await page.getByRole("button", { name: /^공구 데이터베이스/ }).click();
  await page.getByRole("button", { name: "공구 등록", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("공구명", { exact: true }).fill("서버 저장 공구");
  await dialog.getByLabel("제조사 · 모델", { exact: true }).fill("TEST-SERVER");
  await dialog.getByLabel("진동 합성값 (m/s²)", { exact: true }).fill("10");
  await dialog.getByLabel("작업 중 소음 LAeq (dB(A))", { exact: true }).fill("85");
  await dialog.getByLabel("데이터 출처 · 작업 조건", { exact: true }).fill("브라우저 자동 검증용 가상값");
  await dialog.getByRole("button", { name: "공구 저장", exact: true }).click();
  await expectSaved(page);
  await page.getByRole("button", { name: "노출 평가", exact: true }).click();
  await page.getByRole("button", { name: "새 노출 평가", exact: true }).click();
  await dialog.getByLabel("작업자 이름", { exact: true }).fill("서버 검증 작업자");
  await dialog.getByRole("spinbutton", { name: "사용 시간 1", exact: true }).fill("120");
  await dialog.getByRole("button", { name: "평가 저장", exact: true }).click();
  await expect(dialog.locator(".report-metrics")).toContainText("5.00");
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expectSaved(page);

  const secondContext = await browser.newContext({ baseURL });
  const isolatedContext = await browser.newContext({ baseURL });
  try {
    const second = await secondContext.newPage();
    await login(second, fixtures.accounts.persistence);
    await second.getByRole("button", { name: "노출 평가", exact: true }).click();
    await expect(second.locator("tbody tr")).toHaveCount(1);
    await expect(second.locator("tbody")).toContainText("서버 검증 작업자");
    await expect(second.locator("tbody")).toContainText("5.00");
    expect(await second.evaluate(() => localStorage.getItem("havs.workspace.v1"))).toBeNull();

    const isolated = await isolatedContext.newPage();
    await login(isolated, fixtures.accounts.other);
    await startEmpty(isolated);
    const otherData = await readWorkspace(isolated);
    expect(otherData.workspace).toEqual({ version: 1, tools: [], projects: [], assessments: [] });
    await isolated.getByRole("button", { name: "노출 평가", exact: true }).click();
    await expect(isolated.getByText("서버 검증 작업자", { exact: true })).toHaveCount(0);
    await expect(isolated.locator("tbody tr")).toHaveCount(0);

    // Switching accounts in the same browser must also discard the previous view.
    await page.getByRole("button", { name: "로그아웃", exact: true }).click();
    await login(page, fixtures.accounts.other);
    await page.getByRole("button", { name: "프로젝트", exact: true }).click();
    await expect(page.locator(".project-card")).toHaveCount(0);
    await expect(page.getByText("계정 전용 프로젝트", { exact: true })).toHaveCount(0);
  } finally {
    await secondContext.close();
    await isolatedContext.close();
  }
});

test("imports legacy browser data only after explicit choice and retains the original", async ({ page }) => {
  const legacy = {
    version: 1,
    tools: [],
    projects: [{ id: "legacy-project", name: "기존 브라우저 프로젝트", site: "서울", manager: "담당자" }],
    assessments: [],
  };
  const legacyJSON = JSON.stringify(legacy);
  await page.addInitScript((data) => localStorage.setItem("havs.workspace.v1", data), legacyJSON);
  await login(page, fixtures.accounts.import);
  await expect(page.getByRole("button", { name: /^이 브라우저의 데이터 가져오기/ })).toBeVisible();
  expect(await readWorkspace(page)).toEqual({ workspace: null, revision: 0 });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /^이 브라우저의 데이터 가져오기/ }).click();
  await expectSaved(page);
  expect((await readWorkspace(page)).workspace).toEqual(legacy);
  expect(await page.evaluate(() => localStorage.getItem("havs.workspace.v1"))).toBe(legacyJSON);
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await expect(page.locator(".project-card")).toContainText("기존 브라우저 프로젝트");
});

test("a stale browser cannot overwrite another browser's changes and keeps unsaved work", async ({ page, browser }) => {
  await login(page, fixtures.accounts.conflict);
  await startEmpty(page);
  const secondContext = await browser.newContext({ baseURL });
  try {
    const stale = await secondContext.newPage();
    await login(stale, fixtures.accounts.conflict);
    await expectSaved(stale);
    await createProject(page, "먼저 서버에 저장한 프로젝트");
    await expectSaved(page);
    await createProject(stale, "아직 저장되지 않은 프로젝트");
    await expect(stale.getByRole("alert")).toContainText("다른");
    await expect(stale.locator(".project-card")).toContainText("아직 저장되지 않은 프로젝트");
    const stored = await readWorkspace(stale);
    expect(stored.workspace.projects.map((project: { name: string }) => project.name)).toEqual(["먼저 서버에 저장한 프로젝트"]);
    await expect(stale.getByText("서버에 저장됨", { exact: true })).toHaveCount(0);

    const downloadPromise = stale.waitForEvent("download");
    await stale.getByRole("button", { name: "전체 데이터 JSON 백업", exact: true }).click();
    const backup = await downloadPromise;
    const backupData = JSON.parse(await readFile((await backup.path())!, "utf8"));
    expect(backupData.projects.map((project: { name: string }) => project.name)).toEqual(["아직 저장되지 않은 프로젝트"]);
    stale.once("dialog", (dialog) => dialog.accept());
    await stale.getByRole("button", { name: "서버 기록 다시 불러오기", exact: true }).click();
    await expectSaved(stale);
    await expect(stale.locator(".project-card")).toContainText("먼저 서버에 저장한 프로젝트");
    await expect(stale.getByText("아직 저장되지 않은 프로젝트", { exact: true })).toHaveCount(0);
  } finally {
    await secondContext.close();
  }
});

test("session revocation cannot save changes and keeps them available for backup", async ({ page }) => {
  await login(page, fixtures.accounts.expired);
  await startEmpty(page);
  // Revoke the real server session without changing the already-open React state.
  const logoutStatus = await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "X-CSRF-Token": session.csrfToken },
    });
    return response.status;
  });
  expect(logoutStatus).toBe(204);
  await createProject(page, "만료 후 보존할 프로젝트");
  await expect(page.getByRole("alert")).toContainText("로그인이 만료");
  await expect(page.locator(".project-card")).toContainText("만료 후 보존할 프로젝트");
  await expect(page.getByText("서버에 저장됨", { exact: true })).toHaveCount(0);
  expect((await page.request.get("/api/workspace")).status()).toBe(401);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "전체 데이터 JSON 백업", exact: true }).click();
  const backup = await downloadPromise;
  const backupData = JSON.parse(await readFile((await backup.path())!, "utf8"));
  expect(backupData.projects.map((project: { name: string }) => project.name)).toEqual(["만료 후 보존할 프로젝트"]);

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "다시 로그인", exact: true }).click();
  await expect(page.getByText("만료 후 보존할 프로젝트", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "다시 로그인", exact: true }).click();
  await expect(page.getByLabel("이메일", { exact: true })).toBeVisible();
  await login(page, fixtures.accounts.expired);
  await page.getByRole("button", { name: "가이드 · 기준", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("input[type=file]").setInputFiles({
    name: "unsaved-work.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backupData)),
  });
  await expectSaved(page);
  expect((await readWorkspace(page)).workspace.projects.map((project: { name: string }) => project.name))
    .toEqual(["만료 후 보존할 프로젝트"]);
});

test("conflict recovery cannot read or log out the account selected in another tab", async ({ page, context }) => {
  await login(page, fixtures.accounts["switched-from"]);
  await startEmpty(page);
  await createProject(page, "첫 계정의 프로젝트");
  await expectSaved(page);
  const otherTab = await context.newPage();
  await otherTab.goto("/");
  await createProject(otherTab, "첫 계정의 다른 탭 기록");
  await expectSaved(otherTab);
  await createProject(page, "첫 계정의 미저장 프로젝트");
  await expect(page.getByRole("alert")).toContainText("다른 기기나 탭");
  await otherTab.getByRole("button", { name: "로그아웃", exact: true }).click();
  await login(otherTab, fixtures.accounts["switched-to"]);
  await startEmpty(otherTab);
  await createProject(otherTab, "두 번째 계정의 비공개 프로젝트");
  await expectSaved(otherTab);

  const rejectedRead = page.waitForResponse((response) =>
    response.url().endsWith("/api/workspace") && response.request().method() === "GET",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "서버 기록 다시 불러오기", exact: true }).click();
  expect((await rejectedRead).status()).toBe(403);
  await expect(page.getByText("첫 계정의 미저장 프로젝트", { exact: true })).toBeVisible();
  await expect(page.getByText("두 번째 계정의 비공개 프로젝트", { exact: true })).toHaveCount(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "전체 데이터 JSON 백업", exact: true }).click();
  const backup = await downloadPromise;
  const backupData = JSON.parse(await readFile((await backup.path())!, "utf8"));
  expect(backupData.projects.map((project: { name: string }) => project.name)).toContain("첫 계정의 미저장 프로젝트");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByLabel("이메일", { exact: true })).toBeVisible();
  const otherSession = await otherTab.request.get("/api/session");
  expect(otherSession.status()).toBe(200);
  expect((await otherSession.json()).user.email).toBe(fixtures.accounts["switched-to"].email);
  expect((await readWorkspace(otherTab)).workspace.projects.map((project: { name: string }) => project.name))
    .toEqual(["두 번째 계정의 비공개 프로젝트"]);
});
