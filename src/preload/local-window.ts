import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
// 通道名来自零依赖的 channels.ts(运行时安全,打包时内联);
// 契约类型(含 zod 的 ipc.ts)仅 type-only 引用。
import { CH } from "../shared/channels";
import type {
    AppConfig,
    AppConfigPatch,
    AppInfo,
    DesktopAPI,
    ExternalApiConfig,
    ExternalApiConfigPatch,
    ExternalApiStatus,
    LyricConfig,
    LyricLineEvent,
    LyricWindowAction,
    PlayerCommand,
    Rect,
    WindowControl
} from "../shared/ipc";

/** 订阅 main → 渲染进程事件,返回取消订阅函数 */
function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
    const listener = (_event: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
    ipcRenderer.on(channel, listener);
    return () => {
        ipcRenderer.removeListener(channel, listener);
    };
}

const api: DesktopAPI = {
    getPlaybackSync: () => ipcRenderer.invoke(CH.playbackSyncGet),
    onPlaybackSync: (cb) => subscribe(CH.evPlaybackSync, cb),
    // invoke
    getAppInfo: () => ipcRenderer.invoke(CH.appInfo) as Promise<AppInfo>,
    getLyricBounds: () => ipcRenderer.invoke(CH.lyricBoundsGet) as Promise<Rect>,
    getLyricConfig: () => ipcRenderer.invoke(CH.lyricConfigGet) as Promise<LyricConfig>,
    getExternalApiConfig: () => ipcRenderer.invoke(CH.apiConfigGet) as Promise<ExternalApiConfig>,
    getExternalApiStatus: () => ipcRenderer.invoke(CH.apiStatusGet) as Promise<ExternalApiStatus>,
    getAppConfig: () => ipcRenderer.invoke(CH.appConfigGet) as Promise<AppConfig>,
    copyText: (text: string) => ipcRenderer.invoke(CH.clipboardWrite, text) as Promise<boolean>,

    // send
    playerCommand: (action: PlayerCommand["action"]) =>
        ipcRenderer.send(CH.playerCommand, { action } satisfies PlayerCommand),
    windowControl: (action: WindowControl["action"]) =>
        ipcRenderer.send(CH.windowControl, { action } satisfies WindowControl),
    lyricWindow: (action: LyricWindowAction) => ipcRenderer.send(CH.lyricWindow, action),
    setLyricConfig: (config: Partial<LyricConfig>) => ipcRenderer.send(CH.lyricConfigSet, config),
    setExternalApiConfig: (config: ExternalApiConfigPatch) => ipcRenderer.send(CH.apiConfigSet, config),
    setAppConfig: (config: AppConfigPatch) => ipcRenderer.send(CH.appConfigSet, config),

    // events
    onLyricChange: (cb) => subscribe<[LyricLineEvent]>(CH.evLyricChange, cb),
    onSongChange: (cb) => subscribe<[string]>(CH.evSongChange, cb),
    onStatusChange: (cb) => subscribe<[boolean]>(CH.evStatusChange, cb),
    onConfigChanged: (cb) => subscribe<[LyricConfig]>(CH.evConfigChanged, cb),
    // payload 为 [width, height](见 ipc.ts evWindowResized 注释)
    onWindowResized: (cb) => subscribe<[[number, number]]>(CH.evWindowResized, ([width, height]) => cb(width, height)),
    onBoundsChanged: (cb) => subscribe<[Rect]>(CH.evBoundsChanged, cb),
    onExternalApiConfigChanged: (cb) => subscribe<[ExternalApiConfig]>(CH.evApiConfigChanged, cb),
    onExternalApiStatusChanged: (cb) => subscribe<[ExternalApiStatus]>(CH.evApiStatusChanged, cb),
    onAppConfigChanged: (cb) => subscribe<[AppConfig]>(CH.evAppConfigChanged, cb)
};

contextBridge.exposeInMainWorld("desktopAPI", api);
