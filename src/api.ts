import { isWorkspace } from "./domain";
import type { Workspace } from "./domain";
import { MAX_SYNC_WORKSPACE_BYTES } from "./limits";

export type Session = {
  user: { id: string; email: string; name: string };
  csrfToken: string;
};
export type WorkspaceEnvelope = {
  workspace: Workspace | null;
  revision: number;
};
export type Connection = Session & {
  initialWorkspace: Workspace;
  revision: number;
};
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: { ...options.headers },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError(
      0,
      "서버에 연결하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.",
    );
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status,
      body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
        ? body.error
        : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    );
  if (body === null) throw new ApiError(502, "서버 응답을 확인할 수 없습니다.");
  return body as T;
}
export const getSession = () => request<Session>("/session");
export const login = (email: string, password: string) =>
  request<Session>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
export const register = (
  email: string,
  password: string,
  name: string,
  inviteCode: string,
) =>
  request<Session>("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name, inviteCode }),
  });
export const logout = (csrfToken: string) =>
  request<void>("/auth/logout", {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
    body: "{}",
  });
export async function getWorkspace(
  csrfToken: string,
): Promise<WorkspaceEnvelope> {
  const value = await request<WorkspaceEnvelope>("/workspace", {
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    (value.workspace !== null && !isWorkspace(value.workspace))
  )
    throw new ApiError(
      502,
      "서버 작업 공간의 형식을 확인할 수 없습니다. 기존 데이터를 백업하고 관리자에게 문의하세요.",
    );
  return value;
}
export async function putWorkspace(
  workspace: Workspace,
  revision: number,
  csrfToken: string,
) {
  assertWorkspaceSize(workspace);
  const result = await request<{ revision: number }>("/workspace", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ workspace, revision }),
  });
  if (!Number.isInteger(result.revision) || result.revision <= revision)
    throw new ApiError(
      502,
      "저장 완료 여부를 확인할 수 없습니다. 서버 기록을 다시 확인하세요.",
    );
  return result;
}

export function assertWorkspaceSize(workspace: Workspace) {
  if (
    new TextEncoder().encode(JSON.stringify(workspace)).byteLength >
    MAX_SYNC_WORKSPACE_BYTES
  )
    throw new ApiError(
      413,
      "서버에 보관할 작업 공간은 1.9MB 이하여야 합니다. JSON 백업을 보관한 뒤 불필요한 기록을 정리해 주세요.",
    );
}
