import { app, clipboard, ipcMain, screen } from "electron";
import { createRequire } from "node:module";
import {
    AppConfigPatchSchema,
    CH,
    ExternalApiConfigPatchSchema,
    HookPayloadSchema,
    LyricConfigPatchSchema,
    LyricWindowActionSchema,
    PlayerCommandSchema,
    WindowControlSchema,
    type AppInfo,
    type ExternalApiStatus,
    type HookPayload,
    type LyricConfig,
    type LyricLineEvent,
    type Rect
} from "../shared/ipc";
import {
    HOOK_MIN_INTERVAL_MS,
    type CoverTheme,
    type LyricsSnapshot,
    type NowPlaying,
    type PlaybackSnapshot
} from "../shared/hook-contract";
import * as config from "./config";
import * as apiConfig from "./api-config";
import * as appConfig from "./app-config";
import * as externalApi from "./external-api";
import * as windowManager from "./window-manager";
import * as trayManager from "./tray-manager";
import * as mediaManager from "./media-manager";
import * as updater from "./updater";

try {
    const nodeRequire = createRequire(__filename);
    if (nodeRequire("electron-squirrel-startup")) app.quit();
} catch {
    // Ignore
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
}

mediaManager.setupAppIdentity();

let currentSong: HookPayload = {
    songName: "",
    songArtist: "",
    songMid: "",
    currentTime: 0,
    duration: 0,
    lyricText: "",
    lyricTrans: "",
    lyricData: [],
    isPlaying: false
};

interface PendingLyricUpdate {
    lyricText: string;
    lyricData: HookPayload["lyricData"];
    lyricTrans: string;
    coverTheme: CoverTheme | null;
}

let pendingLyricUpdate: PendingLyricUpdate | null = null;
let lyricUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let lastLyricUpdateTime = 0;
let lastSongLabel = "";
let lastPlayingState: boolean | null = null;

function flushLyricUpdate(): void {
    if (lyricUpdateTimer) {
        clearTimeout(lyricUpdateTimer);
        lyricUpdateTimer = null;
    }
    if (!pendingLyricUpdate) return;

    // 窗口不可见/不存在时保留 pending,待窗口 show 时补发(见 setOnLyricWindowShow)
    const lyricWindow = windowManager.getLyricWindow();
    if (!lyricWindow || lyricWindow.isDestroyed() || !lyricWindow.isVisible()) return;

    const lyricUpdate = pendingLyricUpdate;
    pendingLyricUpdate = null;
    lastLyricUpdateTime = Date.now();

    const currentConfig = config.getConfig();
    const payload: LyricLineEvent = {
        lyricText: lyricUpdate.lyricText,
        lyricData: lyricUpdate.lyricData,
        lyricTrans: currentConfig.showTranslation ? lyricUpdate.lyricTrans : "",
        coverTheme: lyricUpdate.coverTheme
    };
    lyricWindow.webContents.send(CH.evLyricChange, payload);
}

function scheduleLyricUpdate(data: HookPayload): void {
    pendingLyricUpdate = {
        lyricText: data.lyricText || "",
        lyricData: data.lyricData || [],
        lyricTrans: data.lyricTrans || "",
        coverTheme: data.coverTheme || null
    };

    if (lyricUpdateTimer) return;

    const elapsed = Date.now() - lastLyricUpdateTime;
    const delay = Math.max(0, HOOK_MIN_INTERVAL_MS - elapsed);
    lyricUpdateTimer = setTimeout(flushLyricUpdate, delay);
}

function setupIPC(): void {
    ipcMain.on(CH.hookState, (_event, data: HookPayload) => {
        // 契约 v2:仅在 dev 校验并告警,生产直接透传(hook 高频调用,不做丢弃)。
        if (!app.isPackaged) {
            const parsed = HookPayloadSchema.safeParse(data);
            if (!parsed.success) {
                console.warn(`[ipc] ${CH.hookState} payload failed HookPayloadSchema:`, parsed.error.message);
            }
        }

        currentSong = { ...currentSong, ...data };
        broadcastPlaybackEvents(currentSong);
        const lyricWindow = windowManager.getLyricWindow();

        trayManager.updateTrayMenu(currentSong, playPrev, playNext, playOrPause);
        // 托盘进度是每帧喂、由 tray-manager 自行按「像素/秒」去重,这里不另做节流
        trayManager.updateTrayProgress(currentSong);
        mediaManager.update(currentSong);

        if (lyricWindow && !lyricWindow.isDestroyed()) {
            const songLabel = `${currentSong.songName} - ${currentSong.songArtist}`;
            if (songLabel !== lastSongLabel) {
                lastSongLabel = songLabel;
                lyricWindow.webContents.send(CH.evSongChange, songLabel);
            }

            if (currentSong.isPlaying !== lastPlayingState) {
                lastPlayingState = currentSong.isPlaying;
                lyricWindow.webContents.send(CH.evStatusChange, currentSong.isPlaying);
            }

            scheduleLyricUpdate(currentSong);
        }
    });

    ipcMain.on(CH.windowControl, (_event, raw: unknown) => {
        const parsed = WindowControlSchema.safeParse(raw);
        if (!parsed.success) {
            console.warn(`[ipc] ${CH.windowControl} invalid payload dropped:`, parsed.error.message);
            return;
        }
        switch (parsed.data.action) {
            case "hide-main":
                windowManager.getMainWindow()?.hide();
                break;
            case "show-main":
                showMainWindow();
                break;
            case "open-settings":
                windowManager.createSettingsWindow();
                break;
            case "close-settings":
                windowManager.getSettingsWindow()?.close();
                break;
            case "minimize-main":
                windowManager.getMainWindow()?.minimize();
                break;
            case "toggle-maximize-main": {
                const main = windowManager.getMainWindow();
                if (!main) break;
                // 状态回推由 window-manager 挂在 maximize/unmaximize 事件上,此处不必手动通知
                if (main.isMaximized()) main.unmaximize();
                else main.maximize();
                break;
            }
            case "close-main":
                // 走 win.close():是隐藏到托盘还是真正退出,交给 createMainWindow 里
                // 既有的 close 处理(isQuiting 判定),不在这里另起一套关闭策略
                windowManager.getMainWindow()?.close();
                break;
        }
    });

    ipcMain.handle(CH.appInfo, (): AppInfo => {
        const { width, height } = screen.getPrimaryDisplay().workAreaSize;
        return {
            screen: { width, height },
            isWayland: windowManager.isWaylandSession()
        };
    });

    ipcMain.handle(CH.lyricBoundsGet, (): Rect => {
        const lyricWindow = windowManager.getLyricWindow();
        if (!lyricWindow) return { x: 0, y: 0, width: 1200, height: 130 };
        return lyricWindow.getBounds();
    });

    ipcMain.on(CH.lyricWindow, (_event, raw: unknown) => {
        const parsed = LyricWindowActionSchema.safeParse(raw);
        if (!parsed.success) {
            console.warn(`[ipc] ${CH.lyricWindow} invalid payload dropped:`, parsed.error.message);
            return;
        }
        const action = parsed.data;

        switch (action.type) {
            case "set-lock": {
                config.saveConfig({ isLock: action.isLock });
                windowManager.setLyricWindowLock(action.isLock);
                windowManager.broadcastLyricConfig();
                trayManager.updateTrayMenu(currentSong, playPrev, playNext, playOrPause);
                break;
            }
            case "set-passthrough": {
                // 锁定态解锁按钮 hover 联动:enabled=false 临时关闭穿透使按钮可点;
                // enabled=true 时按当前 isLock 状态重新应用
                windowManager.setLyricWindowLock(action.enabled ? config.getConfig().isLock : false);
                break;
            }
            case "toggle-visibility": {
                windowManager.toggleLyricWindowVisibility();
                trayManager.updateTrayMenu(currentSong, playPrev, playNext, playOrPause);
                break;
            }
            case "move": {
                windowManager.moveLyricWindow(action.x, action.y);
                break;
            }
            case "save-position": {
                windowManager.moveLyricWindow(action.x, action.y);
                const currentConfig = config.getConfig();
                currentConfig.windowX = action.x;
                currentConfig.windowY = action.y;
                config.saveConfig(currentConfig);
                break;
            }
            case "resize": {
                windowManager.resizeLyricWindow(action.x, action.y, action.width, action.height);
                break;
            }
            case "save-bounds": {
                const currentConfig = config.getConfig();
                currentConfig.windowX = action.bounds.x;
                currentConfig.windowY = action.bounds.y;
                currentConfig.windowWidth = action.bounds.width;
                currentConfig.windowHeight = action.bounds.height;
                config.saveConfig(currentConfig);
                break;
            }
            case "save-current-bounds": {
                // 拖动/缩放结束:main 自读实际 bounds 落盘,渲染端无需回读
                const lyricWindow = windowManager.getLyricWindow();
                if (!lyricWindow || lyricWindow.isDestroyed()) break;
                const bounds = lyricWindow.getBounds();
                const patch: Partial<LyricConfig> = {
                    windowWidth: bounds.width,
                    windowHeight: bounds.height
                };
                // Wayland 不暴露全局窗口坐标(恒为 0,0),不覆盖已保存的坐标
                if (!windowManager.isWaylandSession()) {
                    patch.windowX = bounds.x;
                    patch.windowY = bounds.y;
                }
                config.saveConfig(patch);
                break;
            }
            case "reset-position": {
                const screenWidth = windowManager.getScreenWidth();
                const DEFAULT_HEIGHT = 130;

                const currentConfig = config.getConfig();
                currentConfig.windowX = 0;
                currentConfig.windowY = 0;
                currentConfig.windowWidth = screenWidth;
                currentConfig.windowHeight = DEFAULT_HEIGHT;
                config.saveConfig(currentConfig);

                const lyricWindow = windowManager.getLyricWindow();
                if (lyricWindow) {
                    windowManager.resizeLyricWindow(0, 0, screenWidth, DEFAULT_HEIGHT);
                    windowManager.moveLyricWindow(0, 0);
                }
                break;
            }
        }
    });

    ipcMain.handle(CH.lyricConfigGet, () => {
        return config.getConfig();
    });

    ipcMain.on(CH.lyricConfigSet, (_event, raw: unknown) => {
        // payload 为 Partial<LyricConfig>;必须用 LyricConfigPatchSchema 而非
        // LyricConfigSchema.partial() —— 后者在 Zod 4 下仍会用默认值填满缺席字段,
        // 把「只改一项」变成「其余全部重置」(见 shared/ipc.ts 的说明)
        const parsed = LyricConfigPatchSchema.safeParse(raw);
        if (!parsed.success) {
            console.warn(`[ipc] ${CH.lyricConfigSet} invalid payload dropped:`, parsed.error.message);
            return;
        }
        config.saveConfig(parsed.data);
        const newConfig = config.getConfig();

        windowManager.setLyricWindowLock(newConfig.isLock);
        // 合并后的完整配置广播给歌词窗与设置窗(设置窗只发 diff,依赖完整回包对齐)
        windowManager.broadcastLyricConfig();

        trayManager.updateTrayMenu(currentSong, playPrev, playNext, playOrPause);
    });

    ipcMain.handle(CH.apiConfigGet, () => apiConfig.getConfig());

    ipcMain.handle(CH.appConfigGet, () => appConfig.getConfig());

    ipcMain.on(CH.appConfigSet, (_event, raw: unknown) => {
        // 与歌词/外部 API 配置同理:必须用 patch schema,缺席字段等于「不改」而非「重置」
        const parsed = AppConfigPatchSchema.safeParse(raw);
        if (!parsed.success) {
            console.warn(`[ipc] ${CH.appConfigSet} invalid payload dropped:`, parsed.error.message);
            return;
        }
        const next = appConfig.saveConfig(parsed.data);
        // 关掉托盘进度要立刻还原图标,不能等下一帧 hook(暂停时根本没有下一帧)
        trayManager.applyAppConfig(currentSong);
        windowManager.broadcastToLocalWindows(CH.evAppConfigChanged, next);
    });

    ipcMain.handle(CH.apiStatusGet, (): ExternalApiStatus => externalApi.getStatus());

    // 剪贴板走主进程:设置窗的 session 只放行 local-fonts 权限(见 window-manager),
    // 渲染端的 navigator.clipboard 会被那两个 permission handler 挡下来
    ipcMain.handle(CH.clipboardWrite, (_event, raw: unknown): boolean => {
        // 1MB 上限:这个通道只服务「复制接口文档」,不该被拿来搬运大块数据
        if (typeof raw !== "string" || raw.length === 0 || raw.length > 1_000_000) {
            console.warn(`[ipc] ${CH.clipboardWrite} invalid payload dropped`);
            return false;
        }
        clipboard.writeText(raw);
        return true;
    });

    ipcMain.on(CH.apiConfigSet, (_event, raw: unknown) => {
        // 与歌词配置同理:必须用 patch schema,缺席字段等于「不改」而非「重置」
        const parsed = ExternalApiConfigPatchSchema.safeParse(raw);
        if (!parsed.success) {
            console.warn(`[ipc] ${CH.apiConfigSet} invalid payload dropped:`, parsed.error.message);
            return;
        }
        const next = apiConfig.saveConfig(parsed.data);
        // 起/停/换端口都交给 applyConfig 自行比对,这里只管把最新配置喂过去
        externalApi.applyConfig(next);
        windowManager.broadcastToLocalWindows(CH.evApiConfigChanged, next);
    });

    ipcMain.on(CH.playerCommand, (_event, raw: unknown) => {
        const parsed = PlayerCommandSchema.safeParse(raw);
        if (!parsed.success) {
            console.warn(`[ipc] ${CH.playerCommand} invalid payload dropped:`, parsed.error.message);
            return;
        }
        switch (parsed.data.action) {
            case "prev":
                playPrev();
                break;
            case "next":
                playNext();
                break;
            case "playOrPause":
                playOrPause();
                break;
        }
    });
}

function runPlayerCommand(name: string): void {
    const mainWindow = windowManager.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents
        .executeJavaScript(`typeof window.${name} === "function" && window.${name}();`)
        .catch(() => {});
}

/**
 * 调用 UI 上的带参控制函数(外部 API 用)。
 * 与 runPlayerCommand 同样先判空:UI 是从远端加载的,老版本没有这些函数。
 */
function runPlayerCall(name: string, arg: number): void {
    const mainWindow = windowManager.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents
        .executeJavaScript(`typeof window.${name} === "function" && window.${name}(${arg});`)
        .catch(() => {});
}

/**
 * 现取 UI 侧快照(外部 API 的取数端点)。
 * 主窗不在、UI 太旧没有该函数、或执行出错,一律回 null → 端点回 501,
 * 而不是让整个服务失效。
 */
async function queryUI<T>(name: string): Promise<T | null> {
    const mainWindow = windowManager.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    try {
        const result: unknown = await mainWindow.webContents.executeJavaScript(
            `typeof window.${name} === "function" ? window.${name}() : null;`
        );
        return (result ?? null) as T | null;
    } catch (err) {
        console.warn(`[external-api] ${name} failed:`, err);
        return null;
    }
}

/* ---- WebSocket 事件广播(hook tick 驱动;无连接时 broadcastEvent 直接返回) ---- */

const PROGRESS_EVENT_INTERVAL_MS = 1000;
/** 状态兜底轮询的间隔(只在有 WebSocket 客户端时才真的去问 UI) */
const STATE_POLL_INTERVAL_MS = 1000;
let lastEventSongKey = "";
/** 最近一次广播出去的播放状态("playing" / "paused" / "stopped"),null 表示还没播过 */
let lastEventState: string | null = null;
let lastProgressEventTime = 0;
let statePollTimer: ReturnType<typeof setInterval> | null = null;

function broadcastState(state: "playing" | "paused" | "stopped", positionMs: number, durationMs: number): void {
    if (state === lastEventState) return;
    lastEventState = state;
    externalApi.broadcastEvent("state", {
        state,
        position: Math.round(positionMs),
        duration: Math.round(durationMs)
    });
}

function broadcastPlaybackEvents(song: HookPayload): void {
    const songKey = String(song.songMid);
    if (songKey !== lastEventSongKey) {
        lastEventSongKey = songKey;
        externalApi.broadcastEvent("track", {
            id: song.songMid,
            name: song.songName,
            artist: song.songArtist,
            cover: song.coverUrl,
            duration: Math.round((song.duration || 0) * 1000)
        });
    }

    broadcastState(
        song.isPlaying ? "playing" : "paused",
        (song.currentTime || 0) * 1000,
        (song.duration || 0) * 1000
    );

    // hook 每 ~17ms 一次,进度事件按秒节流,避免把连接刷爆
    const now = Date.now();
    if (now - lastProgressEventTime >= PROGRESS_EVENT_INTERVAL_MS) {
        lastProgressEventTime = now;
        externalApi.broadcastEvent("progress", {
            position: Math.round((song.currentTime || 0) * 1000),
            duration: Math.round((song.duration || 0) * 1000),
            lyricText: song.lyricText
        });
    }
}

/**
 * 状态兜底轮询。
 *
 * 上面那套事件全靠 UI 的播放 tick 驱动,而 tick 在暂停时就停了(引擎 pause
 * 路径会 cleanAllInterval),于是「已暂停」这条状态永远发不出去,外部客户端
 * 会一直以为还在播。这里有 WebSocket 客户端连着时按秒现取一次播放状态
 * (和 GET /api/status 同一个数据源,它不依赖 tick),状态变了就补一条 state 事件。
 *
 * 与 hook 那条路共用 lastEventState 去重,谁先发现算谁的,不会发重。
 * UI 侧修好之后这里仍然值得留着:UI 是从远端加载的,老版本靠它兜底。
 */
function startStatePolling(): void {
    if (statePollTimer) return;
    statePollTimer = setInterval(() => {
        // 没人听就别去打扰 UI(每次取数都要过一趟 executeJavaScript)。
        // 去重状态刻意不清空:新连上的客户端由 external-api 的开场快照单独伺候,
        // 清了反而会在下一次轮询里给所有人重发一条根本没变化的 state。
        if (externalApi.getStatus().wsClients === 0) return;
        void queryUI<PlaybackSnapshot>("$MeTMusic_getState").then((snapshot) => {
            if (!snapshot) return;
            broadcastState(snapshot.state, snapshot.position, snapshot.duration);
        });
    }, STATE_POLL_INTERVAL_MS);
}

function playPrev(): void {
    runPlayerCommand("$MeTMusic_prev");
}

function playNext(): void {
    runPlayerCommand("$MeTMusic_next");
}

function playOrPause(): void {
    runPlayerCommand("$MeTMusic_playOrPause");
}

function showMainWindow(): void {
    const existing = windowManager.getMainWindow();
    const mainWindow = existing && !existing.isDestroyed() ? existing : windowManager.createMainWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

app.on("second-instance", showMainWindow);

// macOS emits activate when the user clicks the running app's Dock icon.
app.on("activate", showMainWindow);

app.on("window-all-closed", () => {
    // Remain running in background (tray icon handles quit)
});

app.on("before-quit", () => {
    windowManager.setQuitting(true);
    if (statePollTimer) {
        clearInterval(statePollTimer);
        statePollTimer = null;
    }
    externalApi.stop();
    mediaManager.destroy();
    trayManager.destroyTray();
});

app.whenReady().then(() => {
    config.loadConfig();
    // 关闭按钮行为在主窗建出来之前就得可用(close 事件比任何 IPC 都早)
    appConfig.loadConfig();
    // 歌词窗隐藏期间 flush 会保留 pending,重新可见时补发最后一次歌词行
    windowManager.setOnLyricWindowShow(() => {
        if (pendingLyricUpdate) flushLyricUpdate();
    });
    windowManager.createMainWindow();
    windowManager.createLyricWindow();
    trayManager.createTray(playPrev, playNext, playOrPause);
    mediaManager.create({
        playPrev,
        playNext,
        playOrPause,
        showWindow: showMainWindow
    });
    setupIPC();

    // 外部 API:配置落盘在独立文件,启动时按开关决定是否起服务
    apiConfig.loadConfig();
    externalApi.setStatusListener((status) => {
        windowManager.broadcastToLocalWindows(CH.evApiStatusChanged, status);
    });
    externalApi.init({
        play: () => runPlayerCommand("$MeTMusic_play"),
        pause: () => runPlayerCommand("$MeTMusic_pause"),
        stop: () => runPlayerCommand("$MeTMusic_stop"),
        next: playNext,
        prev: playPrev,
        // 外部接口口径是毫秒,UI 侧 $MeTMusic_seek 收秒
        seek: (positionMs) => runPlayerCall("$MeTMusic_seek", positionMs / 1000),
        setVolume: (volume) => runPlayerCall("$MeTMusic_setVolume", volume),
        getPlaybackState: () => queryUI<PlaybackSnapshot>("$MeTMusic_getState"),
        getNowPlaying: () => queryUI<NowPlaying>("$MeTMusic_getNowPlaying"),
        getLyrics: () => queryUI<LyricsSnapshot>("$MeTMusic_getLyrics"),
        appInfo: () => ({ name: app.getName(), version: app.getVersion() })
    });
    externalApi.applyConfig(apiConfig.getConfig());
    startStatePolling();

    updater.initUpdater();
});
