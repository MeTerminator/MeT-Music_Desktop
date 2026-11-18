import { app, Menu, nativeImage, powerSaveBlocker, type BrowserWindow, type NativeImage } from "electron";
import zlib from "node:zlib";
import * as appConfig from "./app-config";
import * as windowManager from "./window-manager";

// System media chrome is driven by the renderer's Media Session API.
// Do not also register globalShortcut for MediaPlayPause/Next/Previous:
// Chromium already routes those keys to the active session, and a second
// registration would double-fire (and steal keys from other players on macOS).

export interface MediaControls {
    playPrev(): void;
    playNext(): void;
    playOrPause(): void;
    showWindow(): void;
}

/** 媒体集成关心的播放状态子集(index.ts 传入完整 HookPayload 亦可) */
interface MediaSong {
    duration?: number;
    currentTime?: number;
    isPlaying?: boolean;
}

const ICON_SIZE = 20;
let controls: MediaControls | null = null;
let lastThumbarPlaying: boolean | null = null;
let lastDockPlaying: boolean | null = null;
let lastProgressKey = "";
let powerSaveId: number | null = null;

function crc32(buffer: Buffer): number {
    return zlib.crc32(buffer);
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeBuf = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
    const stride = width * 4 + 1;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * stride] = 0;
        rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", zlib.deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0))
    ]);
}

function inTriangle(
    px: number, py: number,
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number
): boolean {
    const v0x = cx - ax;
    const v0y = cy - ay;
    const v1x = bx - ax;
    const v1y = by - ay;
    const v2x = px - ax;
    const v2y = py - ay;
    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;
    const den = dot00 * dot11 - dot01 * dot01;
    if (!den) return false;
    const u = (dot11 * dot02 - dot01 * dot12) / den;
    const v = (dot00 * dot12 - dot01 * dot02) / den;
    return u >= 0 && v >= 0 && u + v <= 1;
}

function fillRect(rgba: Buffer, x0: number, y0: number, x1: number, y1: number): void {
    for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
            const i = (y * ICON_SIZE + x) * 4;
            rgba[i] = 255;
            rgba[i + 1] = 255;
            rgba[i + 2] = 255;
            rgba[i + 3] = 255;
        }
    }
}

type Point = [number, number];

function fillTriangle(rgba: Buffer, a: Point, b: Point, c: Point): void {
    for (let y = 0; y < ICON_SIZE; y += 1) {
        for (let x = 0; x < ICON_SIZE; x += 1) {
            if (!inTriangle(x + 0.5, y + 0.5, a[0], a[1], b[0], b[1], c[0], c[1])) continue;
            const i = (y * ICON_SIZE + x) * 4;
            rgba[i] = 255;
            rgba[i + 1] = 255;
            rgba[i + 2] = 255;
            rgba[i + 3] = 255;
        }
    }
}

function iconFromDraw(draw: (rgba: Buffer) => void): NativeImage {
    const rgba = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4);
    draw(rgba);
    return nativeImage.createFromBuffer(encodePng(ICON_SIZE, ICON_SIZE, rgba));
}

const icons = {
    play: iconFromDraw((rgba) => fillTriangle(rgba, [6, 4], [6, 16], [16, 10])),
    pause: iconFromDraw((rgba) => {
        fillRect(rgba, 5, 4, 8, 16);
        fillRect(rgba, 12, 4, 15, 16);
    }),
    prev: iconFromDraw((rgba) => {
        fillRect(rgba, 3, 4, 5, 16);
        fillTriangle(rgba, [16, 4], [16, 16], [6, 10]);
    }),
    next: iconFromDraw((rgba) => {
        fillTriangle(rgba, [4, 4], [4, 16], [14, 10]);
        fillRect(rgba, 15, 4, 17, 16);
    })
};

function getMainWindow(): BrowserWindow | null {
    return windowManager.getMainWindow();
}

function setPowerSave(isPlaying: boolean): void {
    if (isPlaying && powerSaveId == null) {
        powerSaveId = powerSaveBlocker.start("prevent-app-suspension");
        return;
    }
    if (!isPlaying && powerSaveId != null) {
        powerSaveBlocker.stop(powerSaveId);
        powerSaveId = null;
    }
}

function updateProgressBar(win: BrowserWindow, song: MediaSong | null | undefined): void {
    const duration = Number(song?.duration) || 0;
    const currentTime = Number(song?.currentTime) || 0;
    const isPlaying = Boolean(song?.isPlaying);

    if (!appConfig.getConfig().trayProgress || !duration) {
        if (lastProgressKey !== "off") {
            win.setProgressBar(-1);
            lastProgressKey = "off";
        }
        return;
    }

    const ratio = Math.min(1, Math.max(0, currentTime / duration));
    const mode: "normal" | "paused" = isPlaying ? "normal" : "paused";
    const key = `${mode}:${ratio.toFixed(2)}`;
    if (key === lastProgressKey) return;

    lastProgressKey = key;
    win.setProgressBar(ratio, { mode });
}

function updateThumbar(win: BrowserWindow, song: MediaSong | null | undefined): void {
    if (process.platform !== "win32" || typeof win.setThumbarButtons !== "function") return;

    const isPlaying = Boolean(song?.isPlaying);
    if (lastThumbarPlaying === isPlaying) return;
    lastThumbarPlaying = isPlaying;

    win.setThumbarButtons([
        { tooltip: "上一首", icon: icons.prev, click: () => controls?.playPrev() },
        {
            tooltip: isPlaying ? "暂停" : "播放",
            icon: isPlaying ? icons.pause : icons.play,
            click: () => controls?.playOrPause()
        },
        { tooltip: "下一首", icon: icons.next, click: () => controls?.playNext() }
    ]);
}

function updateDockMenu(song: MediaSong | null | undefined): void {
    if (process.platform !== "darwin" || !app.dock) return;

    const isPlaying = Boolean(song?.isPlaying);
    if (lastDockPlaying === isPlaying) return;
    lastDockPlaying = isPlaying;

    app.dock.setMenu(Menu.buildFromTemplate([
        { label: isPlaying ? "暂停" : "播放", click: () => controls?.playOrPause() },
        { label: "上一首", click: () => controls?.playPrev() },
        { label: "下一首", click: () => controls?.playNext() },
        { type: "separator" },
        { label: "显示主界面", click: () => controls?.showWindow() }
    ]));
}

export function setupAppIdentity(): void {
    if (process.platform === "win32") {
        app.setAppUserModelId("top.met6.musicq");
    }
}

export function create(playerControls: MediaControls): void {
    controls = playerControls;
    updateDockMenu({ isPlaying: false });

    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
        updateThumbar(win, { isPlaying: false });
    }
}

export function update(song: MediaSong): void {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;

    updateProgressBar(win, song);
    updateThumbar(win, song);
    updateDockMenu(song);
    setPowerSave(Boolean(song?.isPlaying));
}

export function destroy(): void {
    setPowerSave(false);
    lastThumbarPlaying = null;
    lastDockPlaying = null;
    lastProgressKey = "";
    controls = null;
}
