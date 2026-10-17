import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { createSeed } from "./seed";
import { isWorkspace } from "./domain";
import type { Workspace } from "./domain";
import { ApiError, getWorkspace, putWorkspace } from "./api";
import type { Connection } from "./api";

export const LOCAL_KEY = "havs.workspace.v1";
export function readLocalWorkspace(): Workspace | null {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(LOCAL_KEY) ?? "null",
    );
    return isWorkspace(value) ? value : null;
  } catch {
    return null;
  }
}
function read() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return { data: createSeed(), warning: "", writable: true };
    const data: unknown = JSON.parse(raw);
    if (!isWorkspace(data)) throw new Error("Invalid workspace");
    return { data, warning: "", writable: true };
  } catch {
    return {
      data: createSeed(),
      writable: false,
      warning:
        "저장된 데이터를 읽을 수 없어 임시 예시 화면을 열었습니다. 기존 데이터는 덮어쓰지 않습니다. 백업을 복원하거나 새 작업 공간을 만들어 주세요.",
    };
  }
}

type Status = "local" | "saved" | "saving" | "error" | "conflict" | "expired";
export function useWorkspace(connection?: Connection) {
  const [initial] = useState(() =>
    connection
      ? { data: connection.initialWorkspace, warning: "", writable: true }
      : read(),
  );
  const [data, setState] = useState<Workspace>(initial.data);
  const [writable, setWritable] = useState(initial.writable);
  const [warning, setWarning] = useState(initial.warning);
  const [status, setStatus] = useState<Status>(connection ? "saved" : "local");
  const current = useRef(initial.data);
  const committed = useRef(JSON.stringify(initial.data));
  const revision = useRef(connection?.revision ?? 0);
  const blocked = useRef(false);
  const alive = useRef(true);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const setData: Dispatch<SetStateAction<Workspace>> = useCallback(
    (action) => {
      const next =
        typeof action === "function" ? action(current.current) : action;
      current.current = next;
      if (connection && !blocked.current)
        setStatus(
          !inFlight.current && JSON.stringify(next) === committed.current
            ? "saved"
            : "saving",
        );
      setState(next);
    },
    [connection],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const flush = useCallback((): Promise<boolean> => {
    if (!connection) return Promise.resolve(writable);
    if (inFlight.current) return inFlight.current;
    if (blocked.current) return Promise.resolve(false);
    const task = (async () => {
      while (JSON.stringify(current.current) !== committed.current) {
        const snapshot = current.current,
          serialized = JSON.stringify(snapshot);
        if (alive.current) setStatus("saving");
        try {
          const result = await putWorkspace(
            snapshot,
            revision.current,
            connection.csrfToken,
          );
          revision.current = result.revision;
          committed.current = serialized;
          if (!alive.current) return true;
        } catch (error) {
          if (!alive.current) return false;
          const httpStatus = error instanceof ApiError ? error.status : 0;
          if (httpStatus === 409) {
            blocked.current = true;
            setStatus("conflict");
            setWarning(
              "다른 기기나 탭에서 기록이 변경되었습니다. 현재 변경은 덮어쓰지 않았습니다. JSON 백업을 받은 뒤 서버 기록을 다시 불러오세요.",
            );
          } else if (httpStatus === 401 || httpStatus === 403) {
            blocked.current = true;
            setStatus("expired");
            setWarning(
              "로그인이 만료되었거나 저장 권한을 확인할 수 없습니다. 현재 변경을 JSON으로 백업한 뒤 다시 로그인하세요.",
            );
          } else if (httpStatus === 413) {
            setStatus("error");
            setWarning(
              "저장 용량을 초과했습니다. 현재 변경은 이 화면에 남아 있습니다. JSON 백업을 보관한 뒤 불필요한 기록을 정리해 주세요.",
            );
          } else {
            setStatus("error");
            setWarning(
              "서버에 저장하지 못했습니다. 현재 변경은 이 화면에 남아 있습니다. 다시 저장하거나 JSON 백업을 내려받아 주세요.",
            );
          }
          return false;
        }
      }
      if (alive.current) {
        setStatus("saved");
        setWarning("");
      }
      return true;
    })();
    inFlight.current = task;
    void task.finally(() => {
      if (inFlight.current === task) inFlight.current = null;
    });
    return task;
  }, [connection, writable]);
  useEffect(() => {
    if (connection) {
      if (JSON.stringify(data) === committed.current || blocked.current) return;
      setStatus("saving");
      const timer = setTimeout(() => {
        void flush();
      }, 350);
      return () => clearTimeout(timer);
    }
    if (!writable) return;
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
      committed.current = JSON.stringify(data);
      setWarning("");
    } catch {
      setWarning(
        "브라우저 저장 공간에 기록하지 못했습니다. 현재 변경 사항이 사라지지 않도록 JSON 백업을 내려받아 주세요.",
      );
    }
  }, [connection, data, writable, flush]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (JSON.stringify(current.current) !== committed.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  async function reload() {
    if (!connection) return;
    if (
      JSON.stringify(current.current) !== committed.current &&
      !confirm(
        "서버 기록을 불러오면 이 화면에서 저장하지 못한 변경은 교체됩니다. JSON 백업을 보관했나요?",
      )
    )
      return;
    try {
      const remote = await getWorkspace(connection.csrfToken);
      if (remote.workspace === null) throw new Error("Missing workspace");
      revision.current = remote.revision;
      committed.current = JSON.stringify(remote.workspace);
      blocked.current = false;
      setData(remote.workspace);
      setStatus("saved");
      setWarning("");
    } catch {
      setWarning(
        "서버 기록을 불러오지 못했습니다. 현재 기록을 백업하고 로그인 상태와 연결을 확인하세요.",
      );
    }
  }
  function replace(next: Workspace) {
    setWritable(true);
    setData(next);
  }
  const hasPending = () =>
    JSON.stringify(current.current) !== committed.current;
  return { data, setData, warning, replace, status, flush, reload, hasPending };
}
export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
