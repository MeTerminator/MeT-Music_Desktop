import { contextBridge, ipcRenderer } from "electron";
// 通道名来自零依赖的 channels.ts(运行时安全,打包时内联);
// 契约类型(含 zod 的 ipc.ts)仅 type-only 引用。
import { CH } from "../shared/channels";
import type { MainWindowAPI, WindowControl } from "../shared/ipc";
import type { HookPayload } from "../shared/hook-contract";

const api: MainWindowAPI = {
    sendPlaybackSync: (data) => ipcRenderer.send(CH.playbackSync, data),
    sendHookData: (data: HookPayload) => ipcRenderer.send(CH.hookState, data),
    hideWindow: () => ipcRenderer.send(CH.windowControl, { action: "hide-main" } satisfies WindowControl),
    openSettings: () => ipcRenderer.send(CH.windowControl, { action: "open-settings" } satisfies WindowControl),
    minimizeWindow: () =>
        ipcRenderer.send(CH.windowControl, { action: "minimize-main" } satisfies WindowControl),
    toggleMaximize: () =>
        ipcRenderer.send(CH.windowControl, { action: "toggle-maximize-main" } satisfies WindowControl),
    closeWindow: () =>
        ipcRenderer.send(CH.windowControl, { action: "close-main" } satisfies WindowControl)
};

contextBridge.exposeInMainWorld("electronAPI", api);
