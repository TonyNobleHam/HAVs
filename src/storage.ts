import { useEffect, useState } from "react";
import { createSeed } from "./seed";
import { isWorkspace } from "./domain";
import type { Workspace } from "./domain";

const KEY = "havs.workspace.v1";
function read() {
  try {
    const raw = localStorage.getItem(KEY);
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

export function useWorkspace() {
  const [initial] = useState(read);
  const [data, setData] = useState<Workspace>(initial.data);
  const [writable, setWritable] = useState(initial.writable);
  const [warning, setWarning] = useState(initial.warning);
  useEffect(() => {
    if (!writable) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      setWarning("");
    } catch {
      setWarning(
        "브라우저 저장 공간에 기록하지 못했습니다. 현재 변경 사항이 사라지지 않도록 JSON 백업을 내려받아 주세요.",
      );
    }
  }, [data, writable]);
  function replace(next: Workspace) {
    setWritable(true);
    setData(next);
  }
  return { data, setData, warning, replace };
}

export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
