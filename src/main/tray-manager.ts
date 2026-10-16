import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from "electron";
import path from "node:path";
import * as appConfig from "./app-config";
import * as config from "./config";
import * as windowManager from "./window-manager";
import { checkForUpdatesManually } from "./updater";

type PlayerAction = () => void;

/** 托盘菜单关心的播放状态子集(index.ts 传入完整 HookPayload 亦可) */
export interface TraySong {
    songName?: string;
    songArtist?: string;
    isPlaying?: boolean;
    /** 已播放(秒);进度显示用 */
    currentTime?: number;
    /** 总时长(秒);为 0 表示元数据还没加载出来 */
    duration?: number;
    playbackRate?: number;
}

let tray: Tray | null = null;

/* ---- 托盘播放进度(app-config.trayProgress) ---- */

const TRAY_ICON_SIZE = 16;
/** 进度条压在图标底部的高度(像素);2px 在 16px 图标上够显眼又不糊住图形 */
const PROGRESS_BAR_HEIGHT = 2;
/** 原始托盘图标与它的 BGRA 位图(叠进度条时按帧拷贝一份改,不动这两个基准) */
let baseIcon: NativeImage | null = null;
let baseBitmap: Buffer | null = null;
/** 上一帧画出的进度条像素宽 / 悬浮提示文本,只在变了的时候才去动托盘 */
let lastBarPixels = -1;
let lastTooltip = "";
let lastTitle = "";
let progressSong: TraySong = {};
let progressAnchor = 0;
let progressTimer: ReturnType<typeof setInterval> | null = null;

function stopProgressTimer(): void {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = null;
}

/** 界面只发送校准快照时，托盘仍独立推进；暂停、跳转与倍速变化会重新锚定。 */
function currentProgress(): TraySong {
    const elapsed = progressSong.isPlaying
        ? Math.max(0, performance.now() - progressAnchor) / 1000 * (progressSong.playbackRate || 1)
        : 0;
    const position = (progressSong.currentTime || 0) + elapsed;
    return { ...progressSong, currentTime: progressSong.duration
        ? Math.min(position, progressSong.duration) : position };
}

function refreshProgress(): void {
    const song = currentProgress();
    renderTrayProgress(song);
    if ((song.currentTime || 0) >= (song.duration || 0)) stopProgressTimer();
}

function configureProgressTimer(): void {
    stopProgressTimer();
    if (tray && !tray.isDestroyed() && appConfig.getConfig().trayProgress
        && progressSong.isPlaying && (progressSong.duration || 0) > 0) {
        progressTimer = setInterval(refreshProgress, 1000);
        progressTimer.unref();
    }
}

/** 秒 → mm:ss(超过一小时给 h:mm:ss) */
function formatTime(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const s = String(total % 60).padStart(2, "0");
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * 在托盘图标底部叠一条进度条。
 *
 * 走 toBitmap / createFromBitmap 手工合成,而不是 setTitle:后者只有 macOS 有,
 * Windows / Linux 会静默没反应。位图是 BGRA、逐行从上到下排的,所以底部那几行
 * 就是末尾那一段,直接按下标改即可。
 *
 * 拿不到基准位图(图标缺失、尺寸对不上导致长度不符)时回退成原图,不画进度 —— 
 * 托盘图标本身比这条进度条重要得多。
 */
function renderProgressIcon(ratio: number): NativeImage | null {
    if (!baseIcon || !baseBitmap) return null;
    const { width, height } = baseIcon.getSize();
    if (baseBitmap.length !== width * height * 4) return null;

    const bitmap = Buffer.from(baseBitmap);
    const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width);
    const barTop = Math.max(0, height - PROGRESS_BAR_HEIGHT);

    for (let y = barTop; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const on = x < filled;
            // BGRA;已播放段是主题蓝 #3b82f6,未播放段压成半透明白当轨道
            bitmap[i] = on ? 246 : 255;
            bitmap[i + 1] = on ? 130 : 255;
            bitmap[i + 2] = on ? 59 : 255;
            bitmap[i + 3] = on ? 255 : 70;
        }
    }
    return nativeImage.createFromBitmap(bitmap, { width, height });
}

/** 收到新快照时校准本地时钟，暂停和 seek 立即反映到托盘。 */
export function updateTrayProgress(currentSong: TraySong): void {
    progressSong = { ...currentSong };
    progressAnchor = performance.now();
    renderTrayProgress(progressSong);
    configureProgressTimer();
}

function renderTrayProgress(currentSong: TraySong): void {
    if (!tray || tray.isDestroyed()) return;

    const enabled = appConfig.getConfig().trayProgress;
    const duration = currentSong.duration || 0;
    const currentTime = currentSong.currentTime || 0;
    const hasProgress = enabled && duration > 0;

    const songLabel = [currentSong.songName, currentSong.songArtist].filter(Boolean).join(" - ");
    const tooltip = [
        "MeT-Music",
        songLabel,
        hasProgress ? `${formatTime(currentTime)} / ${formatTime(duration)}` : ""
    ]
        .filter(Boolean)
        .join("\n");

    const { width } = baseIcon?.getSize() ?? { width: TRAY_ICON_SIZE };
    const barPixels = hasProgress
        ? Math.round(Math.min(1, Math.max(0, currentTime / duration)) * width)
        : -1;

    // 16px 图标的细进度条不易辨认，macOS 菜单栏同时直接显示时间。
    const title = hasProgress ? `${formatTime(currentTime)} / ${formatTime(duration)}` : "";
    if (process.platform === "darwin" && title !== lastTitle) {
        tray.setTitle(title);
        lastTitle = title;
    }

    if (barPixels === lastBarPixels && tooltip === lastTooltip) return;

    if (barPixels !== lastBarPixels) {
        lastBarPixels = barPixels;
        const icon = barPixels < 0 ? baseIcon : renderProgressIcon(currentTime / duration);
        if (icon) tray.setImage(icon);
    }
    if (tooltip !== lastTooltip) {
        lastTooltip = tooltip;
        tray.setToolTip(tooltip);
    }
}

/** 应用级设置变更:关掉进度显示时立刻把图标还原,不必等下一帧 hook */
export function applyAppConfig(currentSong: TraySong): void {
    lastBarPixels = -1;
    lastTooltip = "";
    if (tray && !tray.isDestroyed() && baseIcon && !appConfig.getConfig().trayProgress) {
        tray.setImage(baseIcon);
    }
    // 不用 currentSong 重新锚定：它可能是数秒前的界面快照。
    if (progressAnchor === 0) {
        progressSong = { ...currentSong };
        progressAnchor = performance.now();
    }
    renderTrayProgress(currentProgress());
    configureProgressTimer();
}

export function createTray(onPlayPrev: PlayerAction, onPlayNext: PlayerAction, onPlayOrPause: PlayerAction): void {
    const trayIconPath = path.join(__dirname, "..", "..", "public", "icons", "tray", "tray.png");
    const trayIcon = nativeImage.createFromPath(trayIconPath).resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });

    stopProgressTimer();
    lastBarPixels = -1;
    lastTooltip = "";
    lastTitle = "";
    lastTrayState = null;
    progressSong = {};
    progressAnchor = 0;
    baseIcon = trayIcon;
    try {
        baseBitmap = trayIcon.toBitmap();
    } catch (err) {
        // 拿不到位图就只是没有进度条,托盘本身照常工作
        console.warn("[tray] failed to read tray icon bitmap, progress overlay disabled:", err);
        baseBitmap = null;
    }

    tray = new Tray(trayIcon);
    tray.setToolTip("MeT-Music");

    tray.on("click", () => {
        const mainWindow = windowManager.getMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) {
            windowManager.createMainWindow();
        } else {
            mainWindow.show();
            mainWindow.focus();
        }
    });

    updateTrayMenu({
        songName: "",
        songArtist: "",
        isPlaying: false
    }, onPlayPrev, onPlayNext, onPlayOrPause);
}

interface TrayState {
    songName: string;
    songArtist: string;
    isPlaying: boolean;
    lyricVisible: boolean;
    showTranslation: boolean;
    isLock: boolean;
}

let lastTrayState: TrayState | null = null;

export function updateTrayMenu(
    currentSong: TraySong,
    onPlayPrev: PlayerAction,
    onPlayNext: PlayerAction,
    onPlayOrPause: PlayerAction,
    force = false
): void {
    if (!tray || tray.isDestroyed()) return;

    const currentConfig = config.getConfig();
    const lyricVisible = windowManager.isLyricWindowVisible();

    const currentState: TrayState = {
        songName: (currentSong && currentSong.songName) || "",
        songArtist: (currentSong && currentSong.songArtist) || "",
        isPlaying: (currentSong && !!currentSong.isPlaying) || false,
        lyricVisible: !!lyricVisible,
        showTranslation: !!currentConfig.showTranslation,
        isLock: !!currentConfig.isLock
    };

    if (!force && lastTrayState &&
        lastTrayState.songName === currentState.songName &&
        lastTrayState.songArtist === currentState.songArtist &&
        lastTrayState.isPlaying === currentState.isPlaying &&
        lastTrayState.lyricVisible === currentState.lyricVisible &&
        lastTrayState.showTranslation === currentState.showTranslation &&
        lastTrayState.isLock === currentState.isLock) {
        return;
    }

    lastTrayState = currentState;

    const template: MenuItemConstructorOptions[] = [];

    if (currentState.isPlaying) {
        template.push(
            { label: `🎵 歌曲: ${currentState.songName}` },
            { label: `👤 歌手: ${currentState.songArtist}` },
            { type: "separator" }
        );
    } else {
        template.push({ label: "未播放", enabled: false }, { type: "separator" });
    }

    template.push({
        label: "⏮ 上一首",
        click: () => {
            onPlayPrev();
        }
    });

    template.push({
        label: currentState.isPlaying ? "⏸ 暂停" : "▶ 播放",
        click: () => {
            onPlayOrPause();
        }
    });

    template.push({
        label: "⏭ 下一首",
        click: () => {
            onPlayNext();
        }
    });

    template.push({ type: "separator" });

    template.push({
        label: "显示桌面歌词",
        type: "checkbox",
        checked: currentState.lyricVisible,
        click: () => {
            windowManager.toggleLyricWindowVisibility();
            updateTrayMenu(currentSong, onPlayPrev, onPlayNext, onPlayOrPause, true);
        }
    });

    template.push({
        label: "桌面歌词翻译",
        type: "checkbox",
        checked: currentConfig.showTranslation,
        click: () => {
            // 菜单构建时的 config 可能已过期,点击时实时读取,且只落盘目标字段
            const cfg = config.getConfig();
            config.saveConfig({ showTranslation: !cfg.showTranslation });
            windowManager.broadcastLyricConfig();
            updateTrayMenu(currentSong, onPlayPrev, onPlayNext, onPlayOrPause, true);
        }
    });

    template.push({
        label: "锁定歌词",
        type: "checkbox",
        checked: currentConfig.isLock,
        click: () => {
            // 菜单构建时的 config 可能已过期,点击时实时读取,且只落盘目标字段
            const cfg = config.getConfig();
            const nextLock = !cfg.isLock;
            config.saveConfig({ isLock: nextLock });
            windowManager.setLyricWindowLock(nextLock);
            windowManager.broadcastLyricConfig();
            updateTrayMenu(currentSong, onPlayPrev, onPlayNext, onPlayOrPause, true);
        }
    });

    template.push({ type: "separator" });
    template.push({
        label: "打开主界面",
        click: () => {
            const mainWindow = windowManager.getMainWindow();
            if (!mainWindow || mainWindow.isDestroyed()) {
                windowManager.createMainWindow();
            } else {
                mainWindow.show();
                mainWindow.focus();
            }
        }
    });
    template.push({
        label: "打开设置",
        click: () => {
            windowManager.createSettingsWindow();
        }
    });
    template.push({
        label: "检查更新",
        click: () => {
            // dev 模式下 updater 内部会弹「开发模式下不可用」提示
            void checkForUpdatesManually();
        }
    });
    template.push({ type: "separator" });
    template.push({
        label: "退出",
        click: () => {
            windowManager.setQuitting(true);
            app.quit();
        }
    });

    tray.setContextMenu(Menu.buildFromTemplate(template));
}

export function destroyTray(): void {
    stopProgressTimer();
    tray?.destroy();
    tray = null;
}
