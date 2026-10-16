import { useEffect, useRef, useState } from "react";
import type { UpdateState } from "@shared/ipc";

export function useUpdateState(): UpdateState | undefined {
  const [state, setState] = useState<UpdateState>();
  useEffect(() => {
    let active = true;
    let eventReceived = false;
    const unsubscribe = window.desktopAPI.onUpdateState(next => {
      eventReceived = true;
      setState(next);
    });
    void window.desktopAPI.getUpdateState().then(next => {
      if (active && !eventReceived) setState(next);
    }).catch(console.error);
    return () => { active = false; unsubscribe(); };
  }, []);
  return state;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function UpdateProgress() {
  const state = useUpdateState();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (state?.status === "downloading") {
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
    } else dialogRef.current?.close();
  }, [state?.status]);
  const percent = state?.total ? Math.min(100, (state.received / state.total) * 100) : undefined;
  return (
    <dialog ref={dialogRef} className="update-progress-dialog" aria-labelledby="update-progress-title" onCancel={event => event.preventDefault()}>
      <h3 id="update-progress-title">正在下载 v{state?.version} 安装包</h3>
      <progress aria-label="安装包下载进度" max={100} value={percent} />
      <p role="status">{percent === undefined ? "准备下载…" : `${percent.toFixed(1)}% · ${mb(state?.received ?? 0)} / ${mb(state?.total ?? 0)}`}</p>
      <p className="setting-note">安装包将保存到系统“下载”文件夹。下载完成后会提醒你安装更新，请保持客户端运行。</p>
    </dialog>
  );
}
