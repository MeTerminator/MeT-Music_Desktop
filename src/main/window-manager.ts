import { app, BrowserWindow, dialog, screen, shell, type BrowserWindowConstructorOptions } from "electron";
import path from "node:path";
import { CH } from "../shared/ipc";
import * as appConfig from "./app-config";
import * as config from "./config";

let mainWindow: BrowserWindow | null = null;
let lyricWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let isQuiting = false;
let lyricWindowVisible = true;

const DEFAULT_LYRIC_WIDTH = 1200;
const DEFAULT_LYRIC_HEIGHT = 100;
let currentLyricWidth = DEFAULT_LYRIC_WIDTH;
let currentLyricHeight = DEFAULT_LYRIC_HEIGHT;
let saveLyricBoundsTimer: ReturnType<typeof setTimeout> | null = null;
let onLyricWindowShow: (() => void) | null = null;

/** 歌词窗变为可见(show / 首次加载完成)时回调,index.ts 用于补发挂起的歌词行 */
export function setOnLyricWindowShow(cb: () => void): void {
    onLyricWindowShow = cb;
}

/** 向本地窗口(歌词窗 + 设置窗)广播一条 main → renderer 事件 */
export function broadcastToLocalWindows(channel: string, payload: unknown): void {
    for (const win of [lyricWindow, settingsWindow]) {
        if (win && !win.isDestroyed()) {
            win.webContents.send(channel, payload);
        }
    }
}

/** 把当前完整配置广播给歌词窗与设置窗(evConfigChanged) */
export function broadcastLyricConfig(): void {
    broadcastToLocalWindows(CH.evConfigChanged, config.getConfig());
}

export function isWaylandSession(): boolean {
    const ozoneArgument = process.argv.find(argument =>
        argument.startsWith("--ozone-platform=") ||
        argument.startsWith("--ozone-platform-hint=")
    );
    const explicitOzonePlatform = (
        ozoneArgument?.split("=")[1] ||
        process.env.ELECTRON_OZONE_PLATFORM_HINT ||
        process.env.OZONE_PLATFORM ||
        ""
    ).toLowerCase();

    if (explicitOzonePlatform === "x11") return false;
    if (explicitOzonePlatform === "wayland") return true;

    return process.platform === "linux" && (
        Boolean(process.env.WAYLAND_DISPLAY) ||
        String(process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland"
    );
}

function scheduleLyricBoundsSave(): void {
    if (saveLyricBoundsTimer) clearTimeout(saveLyricBoundsTimer);
    saveLyricBoundsTimer = setTimeout(() => {
        if (!lyricWindow || lyricWindow.isDestroyed()) return;

        const bounds = lyricWindow.getBounds();
        const currentConfig = config.getConfig();
        currentConfig.windowWidth = bounds.width;
        currentConfig.windowHeight = bounds.height;

        // Wayland deliberately hides global window coordinates (they are always 0,0).
        // Keep the last meaningful coordinates instead of overwriting them.
        if (!isWaylandSession()) {
            currentConfig.windowX = bounds.x;
            currentConfig.windowY = bounds.y;
        }

        config.saveConfig(currentConfig);
    }, 250);
}

export function getScreenWidth(): number {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayMatching({ x: cursor.x, y: cursor.y, width: 1, height: 1 });
    return display.bounds.width;
}

/** 确认框开着时不重复弹(用户可以连点关闭按钮,也可能同时走托盘/快捷键) */
let closeDialogOpen = false;

/** 真正退出:置退出标志后 app.quit(),before-quit 里的清理照常跑 */
function quitApp(): void {
    isQuiting = true;
    app.quit();
}

/**
 * 主窗关闭按钮的落点(app-config.closeAction / closeConfirm)。
 *
 * 主窗是 frame: false,关闭按钮由远端 UI 渲染后回调过来走 win.close(),
 * 系统快捷键(⌘W / Alt+F4)也落在同一个 close 事件上,所以策略只写在这一处。
 *
 * 开了二次确认就弹一个三选框:最小化到托盘 / 退出程序 / 取消。这里刻意不是
 * 「确定要执行你设定的动作吗」—— 那种确认框除了多按一次没有任何信息量;
 * 让用户当场选,并给一个「记住我的选择」把结果写回 closeAction 并关掉确认,
 * 才是这个开关真正有用的形态。
 */
function handleMainWindowClose(win: BrowserWindow): void {
    const { closeAction, closeConfirm } = appConfig.getConfig();

    if (!closeConfirm) {
        if (closeAction === "quit") quitApp();
        else win.hide();
        return;
    }

    if (closeDialogOpen) return;
    closeDialogOpen = true;

    void dialog
        .showMessageBox(win, {
            type: "question",
            title: "关闭 MeT-Music",
            message: "要最小化到托盘,还是退出程序?",
            detail: "最小化后音乐会继续播放,可从系统托盘图标唤回主界面。",
            buttons: ["最小化到托盘", "退出程序", "取消"],
            // 默认落在用户设定的行为上,回车即可
            defaultId: closeAction === "quit" ? 1 : 0,
            cancelId: 2,
            checkboxLabel: "记住我的选择,不再询问",
            checkboxChecked: false,
            noLink: true
        })
        .then(({ response, checkboxChecked }) => {
            closeDialogOpen = false;
            if (response === 2) return;

            const chosen = response === 1 ? "quit" : "minimize";
            if (checkboxChecked) {
                // 记住选择 = 把这次的决定写成默认行为,并关掉确认框
                const next = appConfig.saveConfig({ closeAction: chosen, closeConfirm: false });
                broadcastToLocalWindows(CH.evAppConfigChanged, next);
            }

            if (chosen === "quit") quitApp();
            else win.hide();
        })
        .catch((err) => {
            closeDialogOpen = false;
            // 弹不出确认框时不能把窗口卡死在「关不掉」:退回配置里的默认行为
            console.error("[window] close confirm dialog failed:", err);
            if (closeAction === "quit") quitApp();
            else win.hide();
        });
}

export function createMainWindow(): BrowserWindow {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    const screenWidth = getScreenWidth();

    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        // Electron 43:x/y 任一为非整数时整组坐标被静默丢弃,必须取整
        x: Math.round((screenWidth - 1200) / 2),
        y: 80,
        show: true,
        frame: false,
        title: "MeT-Music",
        icon: path.join(__dirname, "..", "..", "public", "icons", "icon.png"),
        webPreferences: {
            preload: path.join(__dirname, "..", "preload", "main-window.js"),
            contextIsolation: true,
            nodeIntegration: false,
            // Keep Media Session / audio alive after hide-to-tray.
            backgroundThrottling: false
        }
    });
    mainWindow = win;

    // 隔空播放由系统浏览器承接,保留 UI 提供的 sid / room 等查询参数。
    win.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const target = new URL(url);
            if ((target.protocol === "https:" || target.protocol === "http:") && /^\/player\/?$/.test(target.pathname)) {
                void shell.openExternal(target.href).catch((error) => {
                    console.error("[window] failed to open remote player in browser:", error);
                });
                return { action: "deny" };
            }
        } catch {
            return { action: "deny" };
        }
        return { action: "allow" };
    });

    win.webContents.setBackgroundThrottling(false);
    win.loadURL(process.env.METMUSIC_UI_URL || "https://music.met6.top:444/app/");

    win.on("close", (e) => {
        if (isQuiting) return;
        e.preventDefault();
        handleMainWindowClose(win);
    });

    win.on("closed", () => {
        mainWindow = null;
    });

    win.on("page-title-updated", (e) => {
        e.preventDefault();
        win.setTitle("MeT-MusicQ");
    });

    // 主窗最大化状态回推给 UI:用户双击拖拽区、走系统快捷键或窗口菜单时,
    // UI 无从感知,「最大化/还原」图标会和实际状态对不上。
    // typeof 判空不是版本兼容,而是时序:页面刚开始导航、UI 全局还没挂上时也会触发,
    // 那种时刻 executeJavaScript 本身也可能 reject,一并吞掉。
    const pushWindowState = (): void => {
        if (win.isDestroyed()) return;
        win.webContents
            .executeJavaScript(
                `typeof window.$MeTMusic_setWindowState === "function" && window.$MeTMusic_setWindowState({ maximized: ${win.isMaximized()} });`
            )
            .catch(() => undefined);
    };
    win.on("maximize", pushWindowState);
    win.on("unmaximize", pushWindowState);

    win.webContents.on("did-finish-load", () => {
        // 契约 v2(src/shared/hook-contract.ts):注入 $MeTMusic_Hook,
        // 再经 $MeTMusic_registerHost 注册宿主回调,由 UI 自行渲染导航栏与窗口按钮。
        // 线上 UI 已全量 v2,原先「registerHost 不存在则回落到 v1 DOM 按钮注入」
        // 的分支已移除。
        const inject = `
            window.$MeTMusic_Hook = (d) => window.electronAPI.sendHookData(d);
            window.$MeTMusic_registerHost({
                onOpenSettings: () => window.electronAPI.openSettings(),
                onHideWindow: () => window.electronAPI.hideWindow(),
                // 无边框主窗的窗口按钮(契约里全是可选项)
                onMinimizeWindow: () => window.electronAPI.minimizeWindow(),
                onToggleMaximize: () => window.electronAPI.toggleMaximize(),
                onCloseWindow: () => window.electronAPI.closeWindow()
            });
        `;
        // 页面在注入完成前被导航或关闭时 executeJavaScript 会 reject,吞掉避免
        // unhandled rejection
        win.webContents.executeJavaScript(inject).catch(() => undefined);
        // 注册完立刻对齐一次,免得 UI 的「最大化/还原」图标一上来就是错的
        pushWindowState();
    });

    return win;
}

export function setLyricWindowLock(isLock: boolean): void {
    if (!lyricWindow) return;
    if (process.platform === "darwin" || process.platform === "win32") {
        lyricWindow.setIgnoreMouseEvents(isLock, { forward: true });
    } else {
        lyricWindow.setIgnoreMouseEvents(isLock);
    }
}

function notifyBoundsChanged(): void {
    if (settingsWindow && !settingsWindow.isDestroyed() && lyricWindow && !lyricWindow.isDestroyed()) {
        settingsWindow.webContents.send(CH.evBoundsChanged, lyricWindow.getBounds());
    }
}

export function createLyricWindow(): BrowserWindow {
    if (lyricWindow) return lyricWindow;

    const currentConfig = config.getConfig();
    currentLyricWidth = currentConfig.windowWidth || getScreenWidth();
    currentLyricHeight = currentConfig.windowHeight || DEFAULT_LYRIC_HEIGHT;

    const finalX = (currentConfig.windowX !== undefined && currentConfig.windowX !== null) ? currentConfig.windowX : 0;
    const finalY = (currentConfig.windowY !== undefined && currentConfig.windowY !== null) ? currentConfig.windowY : 0;

    const windowOptions: BrowserWindowConstructorOptions = {
        width: currentLyricWidth,
        height: currentLyricHeight,
        x: finalX,
        y: finalY,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: true,
        minWidth: 100,
        minHeight: 50,
        show: true,
        maximizable: false,
        icon: path.join(__dirname, "..", "..", "public", "icons", "icon.png"),
        webPreferences: {
            preload: path.join(__dirname, "..", "preload", "local-window.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    };

    const win = new BrowserWindow(windowOptions);
    lyricWindow = win;

    win.setAlwaysOnTop(true, "screen-saver");

    if (win.setVisibleOnAllWorkspaces) {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
        win.loadURL(process.env.ELECTRON_RENDERER_URL + "/desktop-lyrics/index.html");
    } else {
        win.loadFile(path.join(__dirname, "..", "renderer", "desktop-lyrics", "index.html"));
    }

    win.on("closed", () => { lyricWindow = null; });

    win.on("hide", () => { lyricWindowVisible = false; });
    win.on("show", () => {
        lyricWindowVisible = true;
        onLyricWindowShow?.();
    });

    win.on("resize", () => {
        if (!lyricWindow) return;

        // Native edge resizing is required on Wayland: the compositor, rather than
        // JavaScript, owns the interactive resize operation.
        const [width, height] = lyricWindow.getSize();
        currentLyricWidth = width ?? currentLyricWidth;
        currentLyricHeight = height ?? currentLyricHeight;
        lyricWindow.webContents.send(CH.evWindowResized, [currentLyricWidth, currentLyricHeight]);
        notifyBoundsChanged();
        scheduleLyricBoundsSave();
    });

    win.on("move", () => {
        notifyBoundsChanged();
    });

    win.webContents.on("did-finish-load", () => {
        const latestConfig = config.getConfig();
        setLyricWindowLock(latestConfig.isLock);
        win.webContents.send(CH.evConfigChanged, latestConfig);
        // 窗口重建后渲染端是空白状态,补发挂起的歌词行
        if (lyricWindowVisible) onLyricWindowShow?.();
    });

    return win;
}

export function createSettingsWindow(): BrowserWindow {
    if (settingsWindow) {
        settingsWindow.show();
        settingsWindow.focus();
        return settingsWindow;
    }

    const win = new BrowserWindow({
        // 左侧菜单占掉 148px,内容区仍要放得下滑块 + 数字输入,故比旧版宽一截
        width: 720,
        height: 720,
        frame: false,
        transparent: true,
        resizable: false,
        alwaysOnTop: true,
        show: true,
        icon: path.join(__dirname, "..", "..", "public", "icons", "icon.png"),
        webPreferences: {
            preload: path.join(__dirname, "..", "preload", "local-window.js"),
            contextIsolation: true,
            nodeIntegration: false,
            partition: "persist:settings"
        }
    });
    settingsWindow = win;

    const settingsSession = win.webContents.session;
    // Electron 类型联合暂未收录 "local-fonts",运行时确有该权限,故经 string 比较
    settingsSession.setPermissionCheckHandler((_webContents, permission) => (permission as string) === "local-fonts");
    settingsSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        callback((permission as string) === "local-fonts");
    });

    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
        win.loadURL(process.env.ELECTRON_RENDERER_URL + "/settings/index.html");
    } else {
        win.loadFile(path.join(__dirname, "..", "renderer", "settings", "index.html"));
    }

    win.on("closed", () => {
        settingsWindow = null;
    });

    return win;
}

export function moveLyricWindow(newX: number, newY: number): void {
    if (!lyricWindow) return;

    const finalX = Math.round(newX);
    const finalY = Math.round(newY);

    lyricWindow.setPosition(finalX, finalY);
    notifyBoundsChanged();
}

export function resizeLyricWindow(x: number, y: number, width: number, height: number): void {
    if (!lyricWindow) return;

    currentLyricWidth = Math.floor(width);
    currentLyricHeight = Math.floor(height);

    lyricWindow.setBounds({
        x: Math.floor(x),
        y: Math.floor(y),
        width: currentLyricWidth,
        height: currentLyricHeight
    });
    // 尺寸变化时 "resize" 事件已负责 evWindowResized / notifyBoundsChanged;
    // 尺寸不变时渲染端无需更新,故此处不再显式发送。
}

export function getMainWindow(): BrowserWindow | null {
    return mainWindow;
}

export function getLyricWindow(): BrowserWindow | null {
    return lyricWindow;
}

export function getSettingsWindow(): BrowserWindow | null {
    return settingsWindow;
}

export function isLyricWindowVisible(): boolean {
    return lyricWindowVisible;
}

export function toggleLyricWindowVisibility(): void {
    const win = lyricWindow ?? createLyricWindow();
    if (lyricWindowVisible) {
        win.hide();
    } else {
        win.show();
    }
}

export function setQuitting(val: boolean): void {
    isQuiting = val;
}
